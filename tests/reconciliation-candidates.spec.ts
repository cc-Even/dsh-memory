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
import MemoryService, {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
  hashEmbedding,
} from '../src/index.ts'
import type { MemoryId, MemoryLayer, MemoryRecord, MemoryScope } from '../src/types.ts'

interface Tokenizer {
  tokenize(text: string): readonly string[]
}

class JsonAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(readonly responses: string[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const text = this.responses.shift()
    if (text === undefined) throw new Error('MEM-103 JSON adapter exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
const roots: string[] = []

function scope(sessionId: string, overrides: Partial<MemoryScope> = {}): MemoryScope {
  return {
    tenantId: 'reconcile-tenant',
    userId: 'reconcile-user',
    agentId: 'reconcile-agent',
    sessionId,
    ...overrides,
  }
}

async function setup(options: {
  readonly limit?: number
  readonly tokenizer?: Tokenizer
} = {}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-reconcile-candidates-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'reconcile-test-llm',
    model: 'reconcile-test-model',
    tenantId: 'reconcile-tenant',
    userId: 'reconcile-user',
    autoCapture: false,
    autoRecall: false,
    reconcileCandidateLimit: options.limit ?? 8,
    ...(options.tokenizer === undefined ? {} : { lexicalTokenizer: options.tokenizer }),
  } as never)
  return ctx
}

function record(options: {
  readonly id: string
  readonly content: string
  readonly owner?: MemoryScope
  readonly layer?: MemoryLayer
  readonly status?: MemoryRecord['status']
  readonly visibility?: MemoryRecord['visibility']
  readonly validFrom?: string
  readonly validUntil?: string
  readonly tags?: readonly string[]
  readonly meta?: Readonly<Record<string, string>>
}): MemoryRecord {
  const owner = options.owner ?? scope('seed')
  const now = '2026-08-20T00:00:00.000Z'
  return {
    schemaVersion: 1,
    id: options.id as MemoryId,
    scope: owner,
    layer: options.layer ?? 'l2_fact',
    content: options.content,
    status: options.status ?? 'active',
    visibility: options.visibility ?? 'recallable',
    sourceType: 'explicit',
    confidence: 1,
    ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
    ...(options.validUntil === undefined ? {} : { validUntil: options.validUntil }),
    createdAt: now,
    updatedAt: now,
    revision: 1,
    supersedes: [],
    supersededBy: [],
    consolidates: [],
    sourceMemoryIds: [],
    sourceSessionId: owner.sessionId,
    sourceTurnIndexes: [],
    tags: [...options.tags ?? []],
    meta: { ...options.meta },
    embedding: {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: hashEmbedding(options.content),
    },
  }
}

async function importRecords(ctx: Context, records: readonly MemoryRecord[]): Promise<void> {
  const grouped = new Map<string, MemoryRecord[]>()
  for (const item of records) {
    const key = JSON.stringify([item.scope.tenantId, item.scope.userId, item.scope.agentId])
    grouped.set(key, [...grouped.get(key) ?? [], item])
  }
  for (const values of grouped.values()) {
    const first = values[0]
    if (first !== undefined) await ctx.memory.import(first.scope, values)
  }
}

function extraction(items: readonly {
  readonly ref: string
  readonly content: string
  readonly layer?: 'l2_fact' | 'l4_identity'
}[]): string {
  const materialized = items.map((item, index) => ({
    clientRef: item.ref,
    content: item.content,
    layer: item.layer ?? 'l2_fact',
    tags: [`source-${index}`],
    confidence: 0.9,
    evidenceTurnIndexes: [index + 1],
  }))
  return JSON.stringify({
    basicProfilePatch: {},
    facts: materialized.filter(item => item.layer === 'l2_fact'),
    identities: materialized.filter(item => item.layer === 'l4_identity'),
  })
}

function promptOf(call: GenerateOptions | undefined): string {
  if (call === undefined) throw new Error('missing reconciliation call')
  const message = call.messages[0]
  if (message === undefined || typeof message.content === 'string') throw new Error('missing structured reconciliation prompt')
  const block = message.content[0]
  if (block?.type !== 'text') throw new Error('missing reconciliation prompt text')
  return block.text
}

function promptSection<T>(prompt: string, label: 'SOURCES' | 'CANDIDATES'): T {
  const marker = `${label}=`
  const start = prompt.indexOf(marker)
  expect(start, `missing ${label} prompt section`).toBeGreaterThanOrEqual(0)
  if (start < 0) return [] as T
  const valueStart = start + marker.length
  const end = label === 'SOURCES' ? prompt.indexOf('\nCANDIDATES=', valueStart) : prompt.length
  expect(end, `unterminated ${label} prompt section`).toBeGreaterThanOrEqual(0)
  if (end < 0) return [] as T
  return JSON.parse(prompt.slice(valueStart, end)) as T
}

async function extract(ctx: Context, sessionId: string) {
  return await ctx.memory.add({
    scope: scope(sessionId),
    content: `evidence for ${sessionId}`,
    mode: 'extract',
    idempotencyKey: `${sessionId}-extract`,
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-103 per-source reconciliation candidates', () => {
  it('gives two topics their own limit-one shortlist and a stable deduplicated catalog', async () => {
    const ctx = await setup({ limit: 1 })
    const alpha = record({ id: 'candidate-alpha', content: 'alpha-orbit launch calendar' })
    const beta = record({ id: 'candidate-beta', content: 'beta-cuisine dinner menu' })
    await importRecords(ctx, [alpha, beta])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'alpha-source', content: 'alpha-orbit launch calendar' },
        { ref: 'beta-source', content: 'beta-cuisine dinner menu' },
      ]),
      JSON.stringify({ operations: [
        { type: 'NOOP', sourceRef: 'alpha-source', duplicateOf: alpha.id },
        { type: 'NOOP', sourceRef: 'beta-source', duplicateOf: beta.id },
      ] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'two-topics')

    expect(receipt).toMatchObject({ status: 'completed', createdMemoryIds: [] })
    expect(adapter.calls).toHaveLength(2)
    const prompt = promptOf(adapter.calls[1])
    const sources = promptSection<readonly {
      readonly source: { readonly clientRef: string }
      readonly candidateIds: readonly string[]
    }[]>(prompt, 'SOURCES')
    expect(sources.map(item => item.source.clientRef)).toEqual(['alpha-source', 'beta-source'])
    expect(sources.map(item => item.candidateIds)).toEqual([[alpha.id], [beta.id]])
    expect(prompt.match(new RegExp(`\"id\":\"${alpha.id}\"`, 'gu'))).toHaveLength(1)
    expect(prompt.match(new RegExp(`\"id\":\"${beta.id}\"`, 'gu'))).toHaveLength(1)
  })

  it('uses zero reconciliation calls and deterministic ADD operations when every shortlist is empty', async () => {
    const seen: string[] = []
    const ctx = await setup({ tokenizer: { tokenize: text => { if (text !== '') seen.push(text); return [] } } })
    const adapter = new JsonAdapter([extraction([
      { ref: 'empty-fact', content: 'a completely new launch fact' },
      { ref: 'empty-identity', content: 'a completely new stable preference', layer: 'l4_identity' },
    ])])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'all-empty')

    expect(receipt.status).toBe('completed')
    expect(adapter.calls).toHaveLength(1)
    expect(adapter.responses).toEqual([])
    expect(seen).toEqual([])
    const derived = ctx.memory.list({ scope: scope('all-empty'), layers: ['l2_fact', 'l4_identity'] })
    expect(derived.map(item => item.content)).toEqual([
      'a completely new launch fact',
      'a completely new stable preference',
    ])
  })

  it('keeps per-source ranking order while serializing a shared candidate only once', async () => {
    const ctx = await setup({ limit: 2 })
    const shared = record({ id: 'catalog-shared', content: 'shared atlas preference' })
    const alpha = record({ id: 'catalog-alpha', content: 'shared atlas alpha preference' })
    const beta = record({ id: 'catalog-beta', content: 'shared atlas beta preference' })
    await importRecords(ctx, [shared, alpha, beta])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'catalog-alpha-source', content: alpha.content },
        { ref: 'catalog-beta-source', content: beta.content },
      ]),
      JSON.stringify({ operations: [
        { type: 'ADD', sourceRef: 'catalog-alpha-source' },
        { type: 'ADD', sourceRef: 'catalog-beta-source' },
      ] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'catalog-dedup')

    expect(receipt.status).toBe('completed')
    const prompt = promptOf(adapter.calls[1])
    const sources = promptSection<readonly {
      readonly source: { readonly clientRef: string }
      readonly candidateIds: readonly string[]
    }[]>(prompt, 'SOURCES')
    const catalog = promptSection<readonly { readonly id: string }[]>(prompt, 'CANDIDATES')
    expect(sources.map(item => item.source.clientRef)).toEqual([
      'catalog-alpha-source',
      'catalog-beta-source',
    ])
    expect(sources.map(item => item.candidateIds)).toEqual([
      [alpha.id, shared.id],
      [beta.id, shared.id],
    ])
    expect(catalog.map(item => item.id)).toEqual([alpha.id, shared.id, beta.id])
    expect(catalog.filter(item => item.id === shared.id)).toHaveLength(1)
  })

  it('merges an early auto-ADD with reversed model ADD operations in sanitized source order exactly once', async () => {
    const ctx = await setup({ limit: 1 })
    const alpha = record({ id: 'ordered-alpha-candidate', content: 'ordered alpha source' })
    const beta = record({ id: 'ordered-beta-candidate', content: 'ordered beta source' })
    await importRecords(ctx, [alpha, beta])
    const expectedContents = ['😀', 'ordered alpha source', 'ordered beta source']
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'ordered-empty', content: expectedContents[0] as string },
        { ref: 'ordered-alpha', content: expectedContents[1] as string },
        { ref: 'ordered-beta', content: expectedContents[2] as string },
      ]),
      JSON.stringify({ operations: [
        { type: 'ADD', sourceRef: 'ordered-beta' },
        { type: 'ADD', sourceRef: 'ordered-alpha' },
      ] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'ordered-partial-empty')

    expect(receipt.status).toBe('completed')
    expect(adapter.calls).toHaveLength(2)
    const sources = promptSection<readonly { readonly source: { readonly clientRef: string } }[]>(
      promptOf(adapter.calls[1]),
      'SOURCES',
    )
    expect(sources.map(item => item.source.clientRef)).toEqual(['ordered-alpha', 'ordered-beta'])
    const created = receipt.createdMemoryIds.map(id => ctx.memory.get(id, scope('ordered-partial-empty')))
    expect(created.map(item => item?.content)).toEqual(expectedContents)
    expect(new Set(receipt.createdMemoryIds).size).toBe(3)
    for (const item of created) {
      expect(item).toMatchObject({
        layer: 'l2_fact',
        status: 'active',
        visibility: 'recallable',
        sourceMemoryIds: [receipt.rawMemoryId],
      })
    }
  })

  it('degrades instead of inventing ADD when the model omits a non-empty shortlist source', async () => {
    const ctx = await setup({ limit: 1 })
    const alpha = record({ id: 'coverage-alpha-candidate', content: 'coverage alpha source' })
    const beta = record({ id: 'coverage-beta-candidate', content: 'coverage beta source' })
    await importRecords(ctx, [alpha, beta])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'coverage-alpha', content: alpha.content },
        { ref: 'coverage-beta', content: beta.content },
      ]),
      JSON.stringify({ operations: [{ type: 'ADD', sourceRef: 'coverage-alpha' }] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'missing-model-coverage')

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(adapter.calls).toHaveLength(2)
    expect(ctx.memory.export(scope('missing-model-coverage'))).toEqual([
      alpha,
      beta,
      expect.objectContaining({
        id: receipt.rawMemoryId,
        layer: 'l1_raw',
        status: 'active',
        visibility: 'recallable',
      }),
    ])
  })

  it('hides a partial-empty source from the model and merges its ADD exactly once in source order', async () => {
    const ctx = await setup()
    const candidate = record({ id: 'partial-fact-candidate', content: 'mercury launch window' })
    await importRecords(ctx, [candidate])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'known-fact', content: 'mercury launch window' },
        { ref: 'new-identity', content: 'user prefers quiet workspaces', layer: 'l4_identity' },
      ]),
      JSON.stringify({ operations: [
        { type: 'NOOP', sourceRef: 'known-fact', duplicateOf: candidate.id },
      ] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'partial-empty')

    expect(receipt.status).toBe('completed')
    expect(adapter.calls).toHaveLength(2)
    const prompt = promptOf(adapter.calls[1])
    expect(prompt).toContain('known-fact')
    expect(prompt).not.toContain('new-identity')
    expect(ctx.memory.list({ scope: scope('partial-empty'), layers: ['l4_identity'] }))
      .toEqual([expect.objectContaining({ content: 'user prefers quiet workspaces' })])
    expect(ctx.memory.get(candidate.id, scope('partial-empty'))?.sourceMemoryIds).toHaveLength(1)
  })

  it('rejects a model operation that guesses a deterministic ADD source', async () => {
    const ctx = await setup()
    const candidate = record({ id: 'guess-known-candidate', content: 'known fact target' })
    await importRecords(ctx, [candidate])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'known-source', content: 'known fact target' },
        { ref: 'auto-add-source', content: 'new identity without candidates', layer: 'l4_identity' },
      ]),
      JSON.stringify({ operations: [
        { type: 'NOOP', sourceRef: 'known-source', duplicateOf: candidate.id },
        { type: 'ADD', sourceRef: 'auto-add-source' },
      ] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'guess-auto-add')

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(ctx.memory.export(scope('guess-auto-add'))).toEqual([
      expect.objectContaining({ id: candidate.id }),
      expect.objectContaining({ id: receipt.rawMemoryId, layer: 'l1_raw', visibility: 'recallable' }),
    ])
  })

  it.each(['NOOP', 'SUPERSEDE'] as const)(
    'rejects %s targets borrowed from another source shortlist',
    async operation => {
      const ctx = await setup({ limit: 1 })
      const alpha = record({ id: `borrow-alpha-${operation}`, content: 'alpha private target' })
      const beta = record({ id: `borrow-beta-${operation}`, content: 'beta private target' })
      await importRecords(ctx, [alpha, beta])
      const illegal = operation === 'NOOP'
        ? { type: 'NOOP', sourceRef: 'alpha-source', duplicateOf: beta.id }
        : { type: 'SUPERSEDE', sourceRef: 'alpha-source', targetIds: [beta.id], content: 'alpha changed', reason: 'changed' }
      const adapter = new JsonAdapter([
        extraction([
          { ref: 'alpha-source', content: 'alpha private target' },
          { ref: 'beta-source', content: 'beta private target' },
        ]),
        JSON.stringify({ operations: [illegal, { type: 'ADD', sourceRef: 'beta-source' }] }),
      ])
      ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

      const receipt = await extract(ctx, `borrow-${operation.toLowerCase()}`)

      expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
      expect(ctx.memory.get(receipt.rawMemoryId, scope(`borrow-${operation.toLowerCase()}`)))
        .toMatchObject({ layer: 'l1_raw', status: 'active', visibility: 'recallable' })
      expect(ctx.memory.get(beta.id, scope(`borrow-${operation.toLowerCase()}`)))
        .toMatchObject({ status: 'active', visibility: 'recallable' })
    },
  )

  it('authorizes CONSOLIDATE targets from participating shortlist union', async () => {
    const ctx = await setup({ limit: 1 })
    const alpha = record({ id: 'union-alpha', content: 'northstar launch month' })
    const beta = record({ id: 'union-beta', content: 'northstar launch day' })
    await importRecords(ctx, [alpha, beta])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'month-source', content: 'northstar launch month' },
        { ref: 'day-source', content: 'northstar launch day' },
      ]),
      JSON.stringify({ operations: [{
        type: 'CONSOLIDATE',
        sourceRefs: ['month-source', 'day-source'],
        targetIds: [alpha.id, beta.id],
        content: 'northstar launches on October 15',
      }] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'union-success')

    expect(receipt.status).toBe('completed')
    const head = ctx.memory.list({ scope: scope('union-success'), layers: ['l2_fact'] })
      .find(item => item.status === 'active')
    expect(new Set(head?.consolidates)).toEqual(new Set([alpha.id, beta.id]))
  })

  it('rejects a CONSOLIDATE target borrowed from a nonparticipating source', async () => {
    const ctx = await setup({ limit: 1 })
    const alpha = record({ id: 'union-participant-alpha', content: 'alpha merge target' })
    const beta = record({ id: 'union-participant-beta', content: 'beta merge target' })
    const outsider = record({ id: 'union-outsider', content: 'outsider private target' })
    await importRecords(ctx, [alpha, beta, outsider])
    const adapter = new JsonAdapter([
      extraction([
        { ref: 'alpha-source', content: alpha.content },
        { ref: 'beta-source', content: beta.content },
        { ref: 'outsider-source', content: outsider.content },
      ]),
      JSON.stringify({ operations: [
        {
          type: 'CONSOLIDATE',
          sourceRefs: ['alpha-source', 'beta-source'],
          targetIds: [alpha.id, outsider.id],
          content: 'illegal borrowed consolidation',
        },
        { type: 'ADD', sourceRef: 'outsider-source' },
      ] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'union-outsider')

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(ctx.memory.list({ scope: scope('union-outsider'), layers: ['l2_fact'] }).map(item => item.id))
      .toEqual([alpha.id, beta.id, outsider.id])
  })

  it.each([
    ['wrong layer', 'isolation-layer'],
    ['expired', 'isolation-expired'],
    ['hidden', 'isolation-hidden'],
    ['superseded status', 'isolation-superseded'],
    ['foreign owner', 'isolation-foreign'],
  ] as const)('pre-filters boundaries and rejects a guessed %s target', async (_label, guessedId) => {
    const seen: string[] = []
    const tokenizer: Tokenizer = {
      tokenize: text => {
        if (text !== '') seen.push(text)
        return text === '' ? [] : text.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
      },
    }
    const ctx = await setup({ tokenizer, limit: 8 })
    const valid = record({ id: 'isolation-valid', content: 'authorized orchard target', tags: ['allowed-tag'] })
    const invalid = [
      record({ id: 'isolation-layer', content: 'secret wrong layer', layer: 'l4_identity' }),
      record({ id: 'isolation-expired', content: 'secret expired target', validUntil: '2020-01-01T00:00:00.000Z' }),
      record({ id: 'isolation-future', content: 'secret future target', validFrom: '2999-01-01T00:00:00.000Z' }),
      record({ id: 'isolation-hidden', content: 'secret hidden target', visibility: 'source_only' }),
      record({ id: 'isolation-superseded', content: 'secret superseded target', status: 'superseded', visibility: 'source_only' }),
      record({ id: 'isolation-archived', content: 'secret archived target', status: 'archived', visibility: 'source_only' }),
      record({ id: 'isolation-deleted', content: 'secret deleted target', status: 'deleted', visibility: 'source_only' }),
      record({
        id: 'isolation-foreign',
        content: 'secret foreign owner target',
        owner: scope('foreign', { userId: 'foreign-user' }),
      }),
    ]
    await importRecords(ctx, [valid, ...invalid])
    const adapter = new JsonAdapter([
      extraction([{ ref: 'isolated-source', content: 'authorized orchard target' }]),
      JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'isolated-source', duplicateOf: guessedId }] }),
    ])
    ctx.llm.registerAdapter(['reconcile-test-llm'], adapter)

    const receipt = await extract(ctx, 'isolation')

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    const exposed = `${seen.join('\n')}\n${promptOf(adapter.calls[1])}`
    expect(exposed).toContain(valid.content)
    for (const item of invalid) {
      expect(exposed).not.toContain(item.id)
      expect(exposed).not.toContain(item.content)
    }
    const prompt = promptOf(adapter.calls[1])
    expect(prompt).not.toMatch(/reconcile-tenant|reconcile-user|reconcile-agent|sessionId|embedding|visibility|meta/u)
  })
})
