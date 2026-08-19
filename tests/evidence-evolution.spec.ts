import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MemoryService from '../src/index.ts'
import type { MemoryRecord, MemoryScope } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []

class JsonAdapter extends LlmAdapter {
  constructor(readonly responses: string[]) {
    super()
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = this.responses.shift()
    if (text === undefined) throw new Error('test JSON adapter is out of responses')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-evidence-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'evidence-test-provider',
    model: 'evidence-test-model',
    userId: 'test-user',
    autoCapture: false,
    autoRecall: false,
  })
  return ctx
}

function scope(sessionId: string): MemoryScope {
  return { userId: 'test-user', agentId: 'assistant', sessionId }
}

function extraction(clientRef: string, content: string): string {
  return JSON.stringify({
    basicProfilePatch: {},
    facts: [{
      clientRef,
      content,
      layer: 'l2_fact',
      tags: ['project'],
      confidence: 0.95,
      evidenceTurnIndexes: [2],
    }],
    identities: [],
  })
}

function evolvedRecord(records: readonly MemoryRecord[], targetId: MemoryRecord['id']): MemoryRecord {
  const evolved = records.find(record =>
    record.status === 'active'
    && (record.consolidates.includes(targetId) || record.supersedes.includes(targetId)),
  )
  if (evolved === undefined) throw new Error('expected an active evolution node')
  return evolved
}

function exactSourceIds(record: MemoryRecord, expected: readonly MemoryRecord['id'][]): void {
  expect(record.sourceMemoryIds).toHaveLength(expected.length)
  expect([...new Set(record.sourceMemoryIds)].sort()).toEqual([...new Set(expected)].sort())
}

async function addDirectTarget(ctx: Context, sessionId: string, content: string) {
  const receipt = await ctx.memory.add({
    scope: scope(sessionId),
    content,
    idempotencyKey: `direct-${sessionId}`,
  })
  const targetId = receipt.createdMemoryIds[0]
  if (targetId === undefined) throw new Error('expected a direct derived memory id')
  const target = ctx.memory.get(targetId, scope(sessionId))
  if (target === undefined) throw new Error('expected a direct derived memory')
  return { receipt, target }
}

async function prepareConsolidation() {
  const ctx = await setup()
  const priorMonth = await addDirectTarget(
    ctx,
    'prior-month',
    'Project Northstar launch month is October.',
  )
  const priorDay = await addDirectTarget(
    ctx,
    'prior-day',
    'Project Northstar launch day is the fifteenth.',
  )
  const adapter = new JsonAdapter([
    extraction('launch-detail', 'Project Northstar launches on October 15.'),
    JSON.stringify({
      operations: [{
        type: 'CONSOLIDATE',
        sourceRefs: ['launch-detail'],
        targetIds: [priorMonth.target.id, priorDay.target.id],
        content: 'Project Northstar launches on October 15.',
      }],
    }),
  ])
  ctx.llm.registerAdapter(['evidence-test-provider'], adapter)
  const current = await ctx.memory.add({
    scope: scope('current'),
    content: 'User: Project Northstar launches on October 15.',
    mode: 'extract',
    idempotencyKey: 'current-launch-window',
  })
  const evolved = evolvedRecord(ctx.memory.export(scope('current')), priorMonth.target.id)
  return { ctx, priorMonth, priorDay, current, evolved }
}

async function prepareSupersede() {
  const ctx = await setup()
  const prior = await addDirectTarget(ctx, 'prior-editor', 'The preferred editor is Neovim.')
  const adapter = new JsonAdapter([
    extraction('editor-change', 'The preferred editor is now VS Code.'),
    JSON.stringify({
      operations: [{
        type: 'SUPERSEDE',
        sourceRef: 'editor-change',
        targetIds: [prior.target.id],
        content: 'The preferred editor is now VS Code.',
        reason: 'The current preference changed.',
      }],
    }),
  ])
  ctx.llm.registerAdapter(['evidence-test-provider'], adapter)
  const current = await ctx.memory.add({
    scope: scope('current'),
    content: 'User: My preferred editor is now VS Code.',
    mode: 'extract',
    idempotencyKey: 'current-editor',
  })
  const evolved = evolvedRecord(ctx.memory.export(scope('current')), prior.target.id)
  return { ctx, prior, current, evolved }
}

describe('evolution evidence provenance', () => {
  it('executes the multi-target CONSOLIDATE fixture and links both targets', async () => {
    const { ctx, priorMonth, priorDay, current, evolved } = await prepareConsolidation()

    expect(current.status).toBe('completed')
    expect([...evolved.consolidates].sort()).toEqual([
      priorMonth.target.id,
      priorDay.target.id,
    ].sort())
    for (const target of [priorMonth.target, priorDay.target]) {
      expect(ctx.memory.get(target.id, scope('current'))).toMatchObject({
        status: 'superseded',
        visibility: 'source_only',
        supersededBy: [evolved.id],
      })
    }
  })

  it('executes the SUPERSEDE fixture and links its target', async () => {
    const { ctx, prior, current, evolved } = await prepareSupersede()

    expect(current.status).toBe('completed')
    expect(evolved.supersedes).toEqual([prior.target.id])
    expect(ctx.memory.get(prior.target.id, scope('current'))).toMatchObject({
      status: 'superseded',
      visibility: 'source_only',
      supersededBy: [evolved.id],
    })
  })

  // Temporary RED contracts: after evidence inheritance is implemented, change
  // every `it.fails` below to ordinary `it`; otherwise a correct fix fails CI.
  it.fails('CONSOLIDATE inherits target evidence in addition to the current raw source', async () => {
    const { priorMonth, priorDay, current, evolved } = await prepareConsolidation()

    exactSourceIds(evolved, [
      priorMonth.receipt.rawMemoryId,
      priorDay.receipt.rawMemoryId,
      current.rawMemoryId,
    ])
  })

  it.fails('SUPERSEDE inherits target evidence in addition to the current raw source', async () => {
    const { prior, current, evolved } = await prepareSupersede()

    exactSourceIds(evolved, [prior.receipt.rawMemoryId, current.rawMemoryId])
  })

  it.fails('keeps a consolidated chain head until its final raw evidence is forgotten', async () => {
    const { ctx, priorMonth, priorDay, current, evolved } = await prepareConsolidation()

    await ctx.memory.forget(current.rawMemoryId, scope('current'))
    const afterCurrent = ctx.memory.get(evolved.id, scope('current'))
    if (afterCurrent === undefined) throw new Error('expected the consolidated chain head')
    expect(afterCurrent).toMatchObject({ status: 'active', visibility: 'recallable' })
    exactSourceIds(afterCurrent, [
      priorMonth.receipt.rawMemoryId,
      priorDay.receipt.rawMemoryId,
    ])

    await ctx.memory.forget(priorMonth.receipt.rawMemoryId, scope('current'))
    const afterFirstPrior = ctx.memory.get(evolved.id, scope('current'))
    if (afterFirstPrior === undefined) throw new Error('expected the consolidated chain head')
    expect(afterFirstPrior).toMatchObject({ status: 'active', visibility: 'recallable' })
    exactSourceIds(afterFirstPrior, [priorDay.receipt.rawMemoryId])

    await ctx.memory.forget(priorDay.receipt.rawMemoryId, scope('current'))
    expect(ctx.memory.get(evolved.id, scope('current'))).toMatchObject({
      status: 'deleted',
      visibility: 'source_only',
      sourceMemoryIds: [],
    })
  })
})
