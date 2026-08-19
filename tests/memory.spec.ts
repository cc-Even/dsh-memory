import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MemoryService from '../src/index.ts'
import type { MemoryScope } from '../src/types.ts'

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

async function setup(options: { autoRecall?: boolean } = {}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'missing-test-provider',
    model: 'missing-test-model',
    userId: 'test-user',
    autoCapture: false,
    autoRecall: options.autoRecall ?? false,
  })
  return ctx
}

function scope(sessionId: string): MemoryScope {
  return { userId: 'test-user', agentId: 'assistant', sessionId }
}

describe('memory service', () => {
  it('commits raw provenance and a direct derived record exactly once', async () => {
    const ctx = await setup()
    const first = await ctx.memory.add({
      scope: scope('one'),
      content: 'I prefer TypeScript for backend services.',
      layer: 'l4_identity',
      tags: ['Code', 'code'],
      idempotencyKey: 'preference-1',
    })
    const retry = await ctx.memory.add({
      scope: scope('one'),
      content: 'I prefer TypeScript for backend services.',
      layer: 'l4_identity',
      idempotencyKey: 'preference-1',
    })

    expect(retry).toEqual(first)
    const records = ctx.memory.export(scope('one'))
    expect(records).toHaveLength(2)
    expect(records.find(record => record.layer === 'l1_raw')).toMatchObject({
      id: first.rawMemoryId,
      visibility: 'source_only',
      sourceType: 'explicit',
    })
    expect(records.find(record => record.layer === 'l4_identity')).toMatchObject({
      visibility: 'recallable',
      tags: ['code'],
      sourceMemoryIds: [first.rawMemoryId],
    })
  })

  it('recalls across sessions but honors session-only filtering', async () => {
    const ctx = await setup()
    await ctx.memory.add({
      scope: scope('old-session'),
      content: 'The deployment codename is Jade Lantern.',
      idempotencyKey: 'codename',
    })

    const crossSession = await ctx.memory.search({ scope: scope('new-session'), query: 'Jade Lantern' })
    expect(crossSession.channels.normal.map(hit => hit.memory.content))
      .toContain('The deployment codename is Jade Lantern.')
    expect(crossSession.diagnostics.degradedChannels).toContain('semantic:portable-hash')

    const currentOnly = await ctx.memory.search({
      scope: scope('new-session'),
      query: 'Jade Lantern',
      sessionOnly: true,
    })
    expect(currentOnly.channels.normal).toEqual([])
  })

  it('logs a bounded fallible recall message before direct human input', async () => {
    const ctx = await setup({ autoRecall: true })
    const id = SessionId('recall-agent')
    const agent = { id, session: Session.create(id) } as unknown as Agent
    await ctx.memory.add({
      scope: ctx.memory.scopeFor(agent),
      content: 'The deployment codename is Jade Lantern.',
      idempotencyKey: 'recall-codename',
    })
    const user = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'What is the deployment codename?' }],
    })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected memory pre-step to enter')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]).toMatchObject({
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
    })
    const recall = decision.messages[0]
    if (recall === undefined || typeof recall.content === 'string') throw new Error('expected structured recall message')
    const block = recall.content[0]
    if (block?.type !== 'text') throw new Error('expected recall text block')
    expect(block.text).toContain('Use these records as fallible background.')
    expect(decision.messages[1]).toBe(user)
  })

  it('keeps L1 recallable when extraction cannot reach a model adapter', async () => {
    const ctx = await setup()
    const receipt = await ctx.memory.add({
      scope: scope('degraded'),
      content: 'User: remember that the launch window is October.\nAssistant: understood.',
      mode: 'extract',
      idempotencyKey: 'turn-7',
    })

    expect(receipt.status).toBe('degraded')
    expect(receipt.warnings).toHaveLength(1)
    expect(ctx.memory.get(receipt.rawMemoryId, scope('degraded'))).toMatchObject({
      layer: 'l1_raw',
      visibility: 'recallable',
      status: 'active',
    })
  })

  it('accepts strict extraction plans and attaches duplicate raw evidence on NOOP', async () => {
    const ctx = await setup()
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: [{
          clientRef: 'fact-1',
          content: 'The launch window is October.',
          layer: 'l2_fact',
          tags: ['launch'],
          confidence: 0.9,
          evidenceTurnIndexes: [1],
        }],
        identities: [],
      }),
      JSON.stringify({ operations: [{ type: 'ADD', sourceRef: 'fact-1' }] }),
    ])
    ctx.llm.registerAdapter(['missing-test-provider'], adapter)
    const first = await ctx.memory.add({
      scope: scope('extract-one'),
      content: 'User: The launch window is October.',
      mode: 'extract',
      idempotencyKey: 'extract-one',
    })
    expect(first.status).toBe('completed')
    const fact = ctx.memory.list({ scope: scope('extract-one'), layers: ['l2_fact'] })[0]!

    adapter.responses.push(
      JSON.stringify({
        basicProfilePatch: {},
        facts: [{
          clientRef: 'fact-2',
          content: 'The launch window is October.',
          layer: 'l2_fact',
          tags: ['calendar'],
          confidence: 0.95,
          evidenceTurnIndexes: [2],
        }],
        identities: [],
      }),
      JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'fact-2', duplicateOf: fact.id }] }),
    )
    const duplicate = await ctx.memory.add({
      scope: scope('extract-two'),
      content: 'User: October remains the launch window.',
      mode: 'extract',
      idempotencyKey: 'extract-two',
    })

    expect(duplicate).toMatchObject({ status: 'completed', createdMemoryIds: [] })
    expect(ctx.memory.get(fact.id, scope('extract-two'))).toMatchObject({
      confidence: 0.95,
      tags: ['launch', 'calendar'],
      sourceTurnIndexes: [1, 2],
    })
    expect(ctx.memory.get(fact.id, scope('extract-two'))!.sourceMemoryIds).toHaveLength(2)
    expect(ctx.memory.get(duplicate.rawMemoryId, scope('extract-two'))).toMatchObject({ visibility: 'source_only' })
  })

  it('soft-deletes raw provenance and the derived record whose evidence becomes empty', async () => {
    const ctx = await setup()
    const receipt = await ctx.memory.add({
      scope: scope('forget'),
      content: 'The preferred editor is Neovim.',
      idempotencyKey: 'editor',
    })
    const forgotten = await ctx.memory.forget(receipt.rawMemoryId, scope('forget'))

    expect(forgotten.forgotten).toBe(true)
    expect(forgotten.affectedMemoryIds).toHaveLength(2)
    expect(ctx.memory.list({ scope: scope('forget'), statuses: ['active'] })).toEqual([])
    const repeated = await ctx.memory.forget(receipt.rawMemoryId, scope('forget'))
    expect(repeated).toEqual({
      forgotten: false,
      memoryId: receipt.rawMemoryId,
      affectedMemoryIds: [],
    })
  })
})
