import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MemoryService, {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
} from '../src/index.ts'
import * as MemoryInvariant from '../src/invariant.ts'
import type { MemoryId, MemoryRecord, MemoryScope } from '../src/types.ts'

const contexts: Context[] = []
const roots: string[] = []
const owner: MemoryScope = { userId: 'invariant-user', agentId: 'assistant', sessionId: 'fixture' }
const timestamp = '2026-08-19T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-invariant-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'unused-invariant-provider',
    model: 'unused-invariant-model',
    userId: owner.userId,
    autoCapture: false,
    autoRecall: false,
  })
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(MemoryInvariant)
  return ctx
}

function memoryId(value: string): MemoryId {
  return value as MemoryId
}

function record(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const content = `fixture ${id}`
  return {
    schemaVersion: 1,
    id: memoryId(id),
    scope: owner,
    layer: 'l2_fact',
    content,
    status: 'active',
    visibility: 'recallable',
    sourceType: 'explicit',
    confidence: 1,
    validFrom: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    supersedes: [],
    supersededBy: [],
    consolidates: [],
    sourceMemoryIds: [],
    sourceSessionId: owner.sessionId,
    sourceTurnIndexes: [],
    tags: [],
    meta: {},
    embedding: {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: Array<number>(HASH_EMBEDDING_DIMENSIONS).fill(0),
    },
    ...overrides,
  }
}

function changed(records: readonly MemoryRecord[]): DomainChanged {
  return {
    domain: 'memory',
    table: 'scopes',
    key: JSON.stringify(['', owner.userId, owner.agentId]),
    operation: 'put',
    value: { revision: 1, records, jobs: [] },
  }
}

async function expectInvalidImport(
  records: readonly MemoryRecord[],
  message: RegExp,
  code = 'CONCURRENT_MODIFICATION',
): Promise<Error | undefined> {
  const ctx = await setup()
  let failure: unknown
  try {
    await ctx.memory.import(owner, records)
  } catch (error) {
    failure = error
  }

  expect.soft(failure).toMatchObject({ code })
  expect.soft(failure).toBeInstanceOf(Error)
  if (failure instanceof Error) expect.soft(failure.message).toMatch(message)
  expect.soft(ctx.memory.export(owner).map(record => record.id)).toEqual([])
  return failure instanceof Error ? failure : undefined
}

async function expectInvariantViolation(
  records: readonly MemoryRecord[],
  message: RegExp,
): Promise<Error | undefined> {
  const ctx = await setup()
  let failure: unknown
  try {
    ctx.emit('domain/changed', changed(records))
  } catch (error) {
    failure = error
  }

  expect.soft(failure).toMatchObject({
    code: 'INVARIANT',
    packageName: '@evyn/dsh-memory',
  })
  expect.soft(failure).toBeInstanceOf(Error)
  if (failure instanceof Error) expect.soft(failure.message).toMatch(message)
  return failure instanceof Error ? failure : undefined
}

async function expectSameViolation(
  records: readonly MemoryRecord[],
  message: RegExp,
): Promise<void> {
  const importFailure = await expectInvalidImport(records, message)
  const invariantFailure = await expectInvariantViolation(records, message)

  expect(importFailure).toBeInstanceOf(Error)
  expect(invariantFailure).toBeInstanceOf(Error)
  if (importFailure === undefined || invariantFailure === undefined) return
  expect(invariantFailure.message).toBe(
    `invariant violated by "@evyn/dsh-memory": ${importFailure.message}`,
  )
}

function oneWaySupersede(): readonly MemoryRecord[] {
  return [
    record('old', { status: 'superseded', visibility: 'source_only' }),
    record('new', { revision: 2, supersedes: [memoryId('old')] }),
  ]
}

function reverseOnly(): readonly MemoryRecord[] {
  return [
    record('old', {
      status: 'superseded',
      visibility: 'source_only',
      supersededBy: [memoryId('new')],
    }),
    record('new', { revision: 2 }),
  ]
}

function equalRevision(): readonly MemoryRecord[] {
  return [
    record('old', {
      status: 'superseded',
      visibility: 'source_only',
      revision: 2,
      supersededBy: [memoryId('new')],
    }),
    record('new', { revision: 2, supersedes: [memoryId('old')] }),
  ]
}

function activePredecessor(): readonly MemoryRecord[] {
  return [
    record('old', {
      status: 'active',
      visibility: 'source_only',
      supersededBy: [memoryId('new')],
    }),
    record('new', { revision: 2, supersedes: [memoryId('old')] }),
  ]
}

describe('memory evolution state invariants', () => {
  it('executes the local import and invariant fixtures for a standalone record', async () => {
    const ctx = await setup()
    const standalone = record('standalone')

    await expect(ctx.memory.import(owner, [standalone])).resolves.toBe(1)
    expect(ctx.memory.export(owner)).toEqual([standalone])
    expect(() => { ctx.emit('domain/changed', changed([standalone])) }).not.toThrow()
  })

  it('accepts a legal revision 1 to 2 to 3 evolution chain', async () => {
    const records = [
      record('revision-1', {
        status: 'superseded',
        visibility: 'source_only',
        supersededBy: [memoryId('revision-2')],
      }),
      record('revision-2', {
        status: 'superseded',
        visibility: 'source_only',
        revision: 2,
        supersedes: [memoryId('revision-1')],
        supersededBy: [memoryId('revision-3')],
      }),
      record('revision-3', {
        revision: 3,
        supersedes: [memoryId('revision-2')],
      }),
    ]
    const ctx = await setup()

    await expect(ctx.memory.import(owner, records)).resolves.toBe(3)
    expect(() => { ctx.emit('domain/changed', changed(records)) }).not.toThrow()
  })

  it('accepts a legal multi-target consolidate edge', async () => {
    const records = [
      record('month', {
        status: 'superseded',
        visibility: 'source_only',
        supersededBy: [memoryId('date')],
      }),
      record('day', {
        status: 'archived',
        visibility: 'source_only',
        supersededBy: [memoryId('date')],
      }),
      record('date', {
        revision: 2,
        consolidates: [memoryId('month'), memoryId('day')],
      }),
    ]
    const ctx = await setup()

    await expect(ctx.memory.import(owner, records)).resolves.toBe(3)
    expect(() => { ctx.emit('domain/changed', changed(records)) }).not.toThrow()
  })

  it('allows archived and deleted source-only predecessors', async () => {
    const records = [
      record('archived-old', {
        status: 'archived',
        visibility: 'source_only',
        supersededBy: [memoryId('archived-new')],
      }),
      record('archived-new', {
        revision: 2,
        supersedes: [memoryId('archived-old')],
      }),
      record('deleted-old', {
        status: 'deleted',
        visibility: 'source_only',
        supersededBy: [memoryId('deleted-new')],
      }),
      record('deleted-new', {
        revision: 2,
        supersedes: [memoryId('deleted-old')],
      }),
    ]
    const ctx = await setup()

    await expect(ctx.memory.import(owner, records)).resolves.toBe(4)
    expect(() => { ctx.emit('domain/changed', changed(records)) }).not.toThrow()
  })

  it('rejects a supersededBy edge without a typed successor edge', async () => {
    await expectSameViolation(reverseOnly(), /reverse edge/i)
  })

  it('rejects a typed successor edge without its supersededBy reverse edge', async () => {
    await expectSameViolation(oneWaySupersede(), /reverse edge/i)
  })

  it('rejects one logical edge typed as both supersedes and consolidates', async () => {
    const records = [
      record('old', {
        status: 'superseded',
        visibility: 'source_only',
        supersededBy: [memoryId('new')],
      }),
      record('new', {
        revision: 2,
        supersedes: [memoryId('old')],
        consolidates: [memoryId('old')],
      }),
    ]

    await expectSameViolation(records, /ambiguous/i)
  })

  it('rejects an explicit evolution self-cycle before revision checks', async () => {
    const self = record('self', {
      status: 'superseded',
      visibility: 'source_only',
      supersedes: [memoryId('self')],
      supersededBy: [memoryId('self')],
    })

    await expectSameViolation([self], /cycle/i)
  })

  it('rejects a two-node evolution cycle before revision checks', async () => {
    const records = [
      record('left', {
        status: 'superseded',
        visibility: 'source_only',
        supersedes: [memoryId('right')],
        supersededBy: [memoryId('right')],
      }),
      record('right', {
        status: 'superseded',
        visibility: 'source_only',
        supersedes: [memoryId('left')],
        supersededBy: [memoryId('left')],
      }),
    ]

    await expectInvalidImport(records, /cycle/i)
  })

  it('rejects an equal successor revision', async () => {
    await expectSameViolation(equalRevision(), /revision/i)
  })

  it('rejects a lower successor revision', async () => {
    const records = [
      record('old', {
        status: 'superseded',
        visibility: 'source_only',
        revision: 3,
        supersededBy: [memoryId('new')],
      }),
      record('new', { revision: 2, supersedes: [memoryId('old')] }),
    ]

    await expectInvalidImport(records, /revision/i)
  })

  it('rejects an active source-only predecessor', async () => {
    await expectSameViolation(activePredecessor(), /predecessor.*status|status.*predecessor/i)
  })

  it('rejects a recallable predecessor even when its status is superseded', async () => {
    const records = [
      record('old', {
        status: 'superseded',
        visibility: 'recallable',
        supersededBy: [memoryId('new')],
      }),
      record('new', { revision: 2, supersedes: [memoryId('old')] }),
    ]

    await expectSameViolation(records, /predecessor.*visibility|visibility.*predecessor/i)
  })

  it('retains missing-target rejection and leaves the target scope empty', async () => {
    const dangling = record('new', {
      revision: 2,
      supersedes: [memoryId('missing')],
    })

    await expectInvalidImport([dangling], /references missing/i)
  })

  it('retains the import target-scope boundary and leaves the target scope empty', async () => {
    const foreign = record('foreign', {
      scope: { userId: 'someone-else', agentId: owner.agentId, sessionId: 'fixture' },
    })

    await expectInvalidImport([foreign], /does not belong to the target scope/i, 'INVALID_INPUT')
  })

  it('makes the companion reject a relation that crosses owner scope', async () => {
    const records = [
      record('foreign-old', {
        scope: { userId: 'someone-else', agentId: owner.agentId, sessionId: 'fixture' },
        status: 'superseded',
        visibility: 'source_only',
        supersededBy: [memoryId('owner-new')],
      }),
      record('owner-new', {
        revision: 2,
        supersedes: [memoryId('foreign-old')],
      }),
    ]

    await expectInvariantViolation(records, /relation crosses scope/i)
  })

  it('retains multiple-active-chain-head rejection and leaves the target scope empty', async () => {
    const records = [
      record('head-a', { chainId: 'shared-chain' }),
      record('head-b', { chainId: 'shared-chain', revision: 2 }),
    ]

    await expectInvalidImport(records, /multiple active heads/i)
  })
})
