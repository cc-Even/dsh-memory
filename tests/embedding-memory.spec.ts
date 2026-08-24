import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  MemoryError,
  hashEmbedding,
  resolveConfig,
} from '../src/index.ts'
import type { MemoryId, MemoryRecord, MemoryScope } from '../src/types.ts'

interface EmbeddingDescription {
  readonly spaceId: string
  readonly dimensions: number
  readonly maxBatchSize: number
  readonly normalization: 'l2'
  readonly quality: 'portable-hash' | 'trained'
}

type EmbedImplementation = (
  texts: readonly string[],
  signal: AbortSignal | undefined,
) => Promise<readonly (readonly number[])[]>

class ScriptedEmbeddingProvider {
  readonly calls: Array<{ readonly texts: readonly string[]; readonly signal: AbortSignal | undefined }> = []

  constructor(
    readonly description: EmbeddingDescription = trainedDescription(),
    public implementation: EmbedImplementation = async texts => texts.map(() => [3, 4, 0]),
  ) {}

  describe(): EmbeddingDescription {
    return this.description
  }

  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    this.calls.push({ texts: [...texts], signal })
    return await this.implementation(texts, signal)
  }
}

class JsonAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  constructor(readonly responses: string[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const text = this.responses.shift()
    if (text === undefined) throw new Error('embedding test JSON adapter is out of responses')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface SetupOptions {
  readonly root?: string
  readonly embeddingProvider?: ScriptedEmbeddingProvider
  readonly embedding?: unknown
  readonly lexicalTokenizer?: { tokenize(text: string): readonly string[] }
  readonly reconcileCandidateLimit?: number
}

interface DurableScopeStateSnapshot {
  readonly revision: number
  readonly records: readonly MemoryRecord[]
  readonly jobs: readonly {
    readonly rawMemoryId: MemoryId
    readonly status: 'accepted' | 'completed' | 'degraded'
    readonly createdMemoryIds: readonly MemoryId[]
    readonly warnings: readonly string[]
  }[]
}

const contexts: Context[] = []
const roots: string[] = []

function trainedDescription(overrides: Partial<EmbeddingDescription> = {}): EmbeddingDescription {
  return {
    spaceId: 'test/scripted-trained/3/l2',
    dimensions: 3,
    maxBatchSize: 8,
    normalization: 'l2',
    quality: 'trained',
    ...overrides,
  }
}

function remoteEmbedding(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: 'openai-compatible',
    baseUrl: 'https://remote.embedding.invalid/v1',
    apiKeyEnv: 'MEM101_EMBEDDING_API_KEY',
    model: 'fixture-remote-model',
    spaceId: 'test/remote-config/fixture-remote-model/3/l2',
    dimensions: 3,
    batchSize: 2,
    timeoutMs: 100,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    ...overrides,
  }
}

function scope(sessionId: string, userId = 'embedding-user'): MemoryScope {
  return {
    tenantId: 'embedding-tenant',
    userId,
    agentId: 'embedding-assistant',
    sessionId,
  }
}

async function setup(options: SetupOptions = {}): Promise<Context> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-memory-'))
  if (options.root === undefined) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'embedding-test-llm',
    model: 'embedding-test-model',
    tenantId: 'embedding-tenant',
    userId: 'embedding-user',
    autoCapture: false,
    autoRecall: false,
    ...(options.embeddingProvider === undefined ? {} : { embeddingProvider: options.embeddingProvider }),
    ...(options.embedding === undefined ? {} : { embedding: options.embedding }),
    ...(options.lexicalTokenizer === undefined ? {} : { lexicalTokenizer: options.lexicalTokenizer }),
    ...(options.reconcileCandidateLimit === undefined ? {} : { reconcileCandidateLimit: options.reconcileCandidateLimit }),
  } as never)
  return ctx
}

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
}

function importedRecord(options: {
  readonly id: string
  readonly owner: MemoryScope
  readonly content: string
  readonly spaceId: string
  readonly dimensions: number
  readonly vector: readonly number[]
  readonly overrides?: Partial<MemoryRecord>
}): MemoryRecord {
  const now = '2026-08-23T00:00:00.000Z'
  return {
    schemaVersion: 1,
    id: options.id as MemoryId,
    scope: options.owner,
    layer: 'l2_fact',
    content: options.content,
    status: 'active',
    visibility: 'recallable',
    sourceType: 'explicit',
    confidence: 1,
    createdAt: now,
    updatedAt: now,
    revision: 1,
    supersedes: [],
    supersededBy: [],
    consolidates: [],
    sourceMemoryIds: [],
    sourceSessionId: options.owner.sessionId,
    sourceTurnIndexes: [],
    tags: [],
    meta: {},
    embedding: {
      spaceId: options.spaceId,
      dimensions: options.dimensions,
      vector: options.vector,
    },
    ...options.overrides,
  }
}

async function disposeContext(ctx: Context): Promise<void> {
  await ctx.fiber.dispose()
  const index = contexts.indexOf(ctx)
  if (index >= 0) contexts.splice(index, 1)
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error
  }
}

function diagnosticObjectGraph(value: unknown): string {
  return inspect(value, { depth: null, showHidden: true, getters: false })
}

function observeDurableStates(ctx: Context): DurableScopeStateSnapshot[] {
  const snapshots: DurableScopeStateSnapshot[] = []
  ctx.on('domain/changed', (value: unknown) => {
    if (value === null || typeof value !== 'object') return
    const change = value as { readonly domain?: unknown; readonly table?: unknown; readonly value?: unknown }
    if (change.domain !== 'memory' || change.table !== 'scopes') return
    snapshots.push(structuredClone(change.value) as DurableScopeStateSnapshot)
  })
  return snapshots
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-101 provider configuration boundary', () => {
  it('accepts a programmatic provider but rejects combining it with loader embedding configuration', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    expect(ctx.memory.health().embeddingSpaceId).toBe(provider.describe().spaceId)

    expect(() => resolveConfig({
      provider: 'embedding-test-llm',
      model: 'embedding-test-model',
      userId: 'embedding-user',
      embeddingProvider: provider,
      embedding: { kind: 'hash' },
    } as never)).toThrow(/embeddingProvider|mutually exclusive|embedding config/i)
  })

  it('redacts a custom provider descriptor failure before service readiness', async () => {
    const sensitive = [
      'descriptor-secret-value',
      'Bearer descriptor-secret-value',
      'authorization-marker',
      'descriptor-upstream-body',
    ]
    const upstream: Record<string, unknown> = {
      requestHeaders: { authorization: sensitive[1], marker: sensitive[2] },
      responseBody: sensitive[3],
    }
    upstream.self = upstream
    const provider = new class extends ScriptedEmbeddingProvider {
      override describe(): EmbeddingDescription {
        throw new MemoryError(
          'EMBEDDING_FAILED',
          `descriptor failed with ${sensitive[0]} and ${sensitive[3]}`,
          { cause: upstream },
        )
      }
    }()
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ]

    const failure = await captureFailure(() => setup({ embeddingProvider: provider }))

    expect(failure).toBeInstanceOf(MemoryError)
    expect(failure).toMatchObject({
      code: 'EMBEDDING_FAILED',
      message: 'embedding provider descriptor is invalid',
    })
    const ctx = contexts.at(-1)
    const observable = diagnosticObjectGraph({
      failure,
      logger: ctx === undefined
        ? undefined
        : (ctx.logger as unknown as { readonly buffer?: unknown }).buffer,
      console: consoleSpies.map(spy => spy.mock.calls),
    })
    for (const value of sensitive) expect(observable).not.toContain(value)
  })

  it.each([65_537, 2 ** 32])(
    'rejects programmatic descriptor dimensions %i before service readiness',
    async dimensions => {
      const provider = new ScriptedEmbeddingProvider(trainedDescription({ dimensions }))
      const failure = await captureFailure(() => setup({ embeddingProvider: provider }))

      expect(failure).toBeInstanceOf(MemoryError)
      expect(failure).toMatchObject({ code: 'EMBEDDING_FAILED' })
      expect(provider.calls).toEqual([])
    },
  )

  it('constructs the remote provider only from the remote config branch and named secret environment variable', async () => {
    const secret = 'remote-config-secret'
    vi.stubEnv('MEM101_EMBEDDING_API_KEY', secret)
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      const input = JSON.parse(String(init?.body)).input as string[]
      return Promise.resolve(new Response(JSON.stringify({
        object: 'list',
        model: 'fixture-remote-model',
        data: input.map((_text, index) => ({ object: 'embedding', index, embedding: [3, 4, 0] })),
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    vi.stubGlobal('fetch', fetchSpy)
    const ctx = await setup({
      embedding: remoteEmbedding(),
    })

    const receipt = await ctx.memory.add({
      scope: scope('remote-config'),
      content: 'The deployment codename is Jade Lantern.',
      idempotencyKey: 'remote-config-write',
    })
    expect(receipt.status).toBe('completed')
    expect(fetchSpy).toHaveBeenCalled()
    expect(ctx.memory.health().embeddingSpaceId).toBe('test/remote-config/fixture-remote-model/3/l2')
    expect(JSON.stringify(ctx.memory.config)).not.toContain(secret)
  })

  it.each([
    { kind: 'openai-compatible' },
    { kind: 'openai-compatible', baseUrl: 'https://example.invalid', apiKeyEnv: 'KEY', model: 'm', spaceId: 's', dimensions: 0 },
    { kind: 'openai-compatible', baseUrl: 'https://example.invalid', apiKey: 'literal-secret', model: 'm', spaceId: 's', dimensions: 3 },
    { kind: 'unknown' },
    remoteEmbedding({ batchSize: 0 }),
    remoteEmbedding({ batchSize: -1 }),
    remoteEmbedding({ timeoutMs: 0 }),
    remoteEmbedding({ timeoutMs: -1 }),
    remoteEmbedding({ retryBaseDelayMs: 0 }),
    remoteEmbedding({ retryBaseDelayMs: -1 }),
    remoteEmbedding({ maxRetries: -1 }),
    remoteEmbedding({ maxRetries: 1.5 }),
    remoteEmbedding({ apiKeyEnv: '' }),
    remoteEmbedding({ baseUrl: '' }),
    remoteEmbedding({ model: '' }),
    remoteEmbedding({ spaceId: '' }),
  ])('rejects incomplete, invalid, literal-secret, or unknown remote configuration %#', (embedding) => {
    expect(() => resolveConfig({
      provider: 'embedding-test-llm',
      model: 'embedding-test-model',
      userId: 'embedding-user',
      embedding,
    } as never)).toThrow(/embedding|kind|dimension|apiKeyEnv|batch|timeout|retry|positive|invalid/i)
  })

  it('fails closed before fetch when the configured secret environment variable is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('missing-key config attempted network access'))))
    const failure = await captureFailure(() => setup({
      embedding: remoteEmbedding({ apiKeyEnv: 'MEM101_MISSING_EMBEDDING_KEY' }),
    }))

    expect(failure, 'remote configuration accepted a missing key environment variable').toBeDefined()
    expect(String(failure)).toMatch(/MEM101_MISSING_EMBEDDING_KEY|api.*key|environment|embedding/i)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('MEM-101 core batching and vector validation', () => {
  it.each([
    ['invalid spaceId', trainedDescription({ spaceId: '' })],
    ['invalid dimensions', trainedDescription({ dimensions: 0 })],
    ['invalid maxBatchSize', trainedDescription({ maxBatchSize: 0 })],
    ['unsupported normalization', trainedDescription({ normalization: 'cosine' as 'l2' })],
    ['invalid quality', trainedDescription({ quality: 'mystery' as 'trained' })],
  ])('rejects an invalid descriptor before the service becomes ready: %s', async (_label, description) => {
    const failure = await captureFailure(() => setup({
      embeddingProvider: new ScriptedEmbeddingProvider(description),
    }))
    expect(failure, 'invalid descriptor was accepted').toBeInstanceOf(MemoryError)
    expect((failure as MemoryError).code).toBe('EMBEDDING_FAILED')
  })

  it.each([
    ['wrong result count', async () => []],
    ['wrong dimensions', async (texts: readonly string[]) => texts.map(() => [1, 2])],
    ['NaN value', async (texts: readonly string[]) => texts.map(() => [1, Number.NaN, 2])],
    ['infinite value', async (texts: readonly string[]) => texts.map(() => [1, Number.POSITIVE_INFINITY, 2])],
    ['zero vector', async (texts: readonly string[]) => texts.map(() => [0, 0, 0])],
  ] satisfies ReadonlyArray<readonly [string, EmbedImplementation]>)('degrades a direct write on invalid provider output: %s', async (_label, implementation) => {
    const provider = new ScriptedEmbeddingProvider(trainedDescription(), implementation)
    const ctx = await setup({ embeddingProvider: provider })
    const receipt = await ctx.memory.add({
      scope: scope('invalid-output'),
      content: 'Raw evidence must survive invalid embedding output.',
      idempotencyKey: `invalid-output-${_label}`,
    })

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(receipt.warnings).toHaveLength(1)
    const records = ctx.memory.export(scope('invalid-output'))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      id: receipt.rawMemoryId,
      layer: 'l1_raw',
      status: 'active',
      visibility: 'recallable',
      embedding: {
        spaceId: provider.describe().spaceId,
        dimensions: provider.describe().dimensions,
        vector: [0, 0, 0],
      },
    })
  })

  it('classifies core provider output validation with the public embedding failure error', async () => {
    const constructed: MemoryError[] = []
    vi.resetModules()
    vi.doMock('../src/error.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/error.ts')>()
      class CapturingMemoryError extends MemoryError {
        constructor(
          code: ConstructorParameters<typeof MemoryError>[0],
          message: string,
          options?: ErrorOptions,
        ) {
          super(code, message, options)
          constructed.push(this)
        }
      }
      return { ...actual, MemoryError: CapturingMemoryError }
    })

    try {
      const dynamic = await import('../src/index.ts')
      const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-error-probe-'))
      roots.push(root)
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json' })
      const provider = new ScriptedEmbeddingProvider(trainedDescription(), async () => [])
      await ctx.plugin(dynamic.default, {
        provider: 'embedding-test-llm',
        model: 'embedding-test-model',
        userId: 'embedding-user',
        autoCapture: false,
        autoRecall: false,
        embeddingProvider: provider,
      } as never)

      const receipt = await ctx.memory.add({
        scope: scope('core-output-error'),
        content: 'Core validation must classify a wrong provider result count.',
        idempotencyKey: 'core-output-error',
      })
      expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
      const failure = constructed.find(error => error.code === ('EMBEDDING_FAILED' as string))
      expect(failure).toBeInstanceOf(MemoryError)
      expect(failure?.code).toBe('EMBEDDING_FAILED')
    } finally {
      vi.doUnmock('../src/error.ts')
      vi.resetModules()
    }
  })

  it('batches extracted records by maxBatchSize, preserves order, and applies final L2 normalization', async () => {
    const rawContent = 'User supplied three durable facts for extraction.'
    const facts = ['Fact alpha is retained.', 'Fact beta is retained.', 'Fact gamma is retained.']
    const vectors = new Map<string, readonly number[]>([
      [rawContent, [3, 4, 0]],
      [facts[0] as string, [0, 3, 4]],
      [facts[1] as string, [4, 0, 3]],
      [facts[2] as string, [8, 6, 0]],
    ])
    const normalized = new Map<string, readonly number[]>([
      [rawContent, [0.6, 0.8, 0]],
      [facts[0] as string, [0, 0.6, 0.8]],
      [facts[1] as string, [0.8, 0, 0.6]],
      [facts[2] as string, [0.8, 0.6, 0]],
    ])
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 2 }),
      async texts => texts.map((text) => {
        const vector = vectors.get(text)
        if (vector === undefined) throw new Error(`unexpected embedding text '${text}'`)
        return vector
      }),
    )
    const ctx = await setup({ embeddingProvider: provider })
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: facts.map((content, index) => ({
          clientRef: `fact-${index + 1}`,
          content,
          layer: 'l2_fact',
          tags: [],
          confidence: 0.9,
          evidenceTurnIndexes: [index],
        })),
        identities: [],
      }),
    ])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: scope('batch-order'),
      content: rawContent,
      mode: 'extract',
      idempotencyKey: 'batch-order',
    })

    expect(receipt.status).toBe('completed')
    expect(provider.calls.every(call => call.texts.length <= 2)).toBe(true)
    expect(provider.calls.flatMap(call => call.texts)).toEqual([rawContent, ...facts])
    const records = ctx.memory.export(scope('batch-order'))
    expect(records.map(record => record.content)).toEqual([rawContent, ...facts])
    for (const record of records) {
      expect(vectorNorm(record.embedding.vector)).toBeCloseTo(1, 12)
      expect(record.embedding.vector, record.content).toEqual(normalized.get(record.content))
      expect(record.embedding.spaceId).toBe(provider.describe().spaceId)
      expect(record.embedding.dimensions).toBe(3)
    }
  })

  it('degrades the whole enrichment when one vector in a derived batch is invalid', async () => {
    const rawContent = 'User supplied a batch whose second derived vector is invalid.'
    const facts = ['Valid derived alpha.', 'Invalid derived beta.', 'Valid derived gamma.']
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 2 }),
      async texts => texts.map(text => text === facts[1] ? [0, 0, 0] : [3, 4, 0]),
    )
    const ctx = await setup({ embeddingProvider: provider })
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: facts.map((content, index) => ({
          clientRef: `invalid-batch-${index + 1}`,
          content,
          layer: 'l2_fact',
          tags: [],
          confidence: 0.9,
          evidenceTurnIndexes: [index],
        })),
        identities: [],
      }),
    ])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: scope('invalid-derived-batch'),
      content: rawContent,
      mode: 'extract',
      idempotencyKey: 'invalid-derived-batch',
    })

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(adapter.responses).toEqual([])
    expect(provider.calls.flatMap(call => call.texts)).toEqual([rawContent, ...facts])
    expect(ctx.memory.export(scope('invalid-derived-batch'))).toEqual([
      expect.objectContaining({
        id: receipt.rawMemoryId,
        layer: 'l1_raw',
        status: 'active',
        visibility: 'recallable',
      }),
    ])
  })
})

describe('MEM-101 raw-first and retrieval degradation semantics', () => {
  it('does not invoke a failing provider until the accepted recallable raw is durably visible', async () => {
    let ctx: Context | undefined
    let observed: readonly MemoryRecord[] = []
    let acceptedAtProvider: DurableScopeStateSnapshot | undefined
    let durableStates: DurableScopeStateSnapshot[] = []
    const provider = new ScriptedEmbeddingProvider(trainedDescription(), async () => {
      if (ctx === undefined) throw new Error('context was not assigned before provider call')
      observed = ctx.memory.export(scope('raw-first-failure'))
      acceptedAtProvider = durableStates.find(state => state.jobs.some(job => job.status === 'accepted'))
      throw new Error('fixture embedding outage')
    })
    ctx = await setup({ embeddingProvider: provider })
    durableStates = observeDurableStates(ctx)

    const receipt = await ctx.memory.add({
      scope: scope('raw-first-failure'),
      content: 'The raw-first launch window is October.',
      idempotencyKey: 'raw-first-provider-failure',
    })

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      layer: 'l1_raw',
      status: 'active',
      visibility: 'recallable',
      embedding: { spaceId: provider.describe().spaceId, dimensions: 3, vector: [0, 0, 0] },
    })
    expect(acceptedAtProvider).toBeDefined()
    expect(acceptedAtProvider?.records).toHaveLength(1)
    expect(acceptedAtProvider?.jobs).toEqual([
      expect.objectContaining({
        rawMemoryId: observed[0]?.id,
        status: 'accepted',
        createdMemoryIds: [],
      }),
    ])
    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(ctx.memory.export(scope('raw-first-failure'))).toEqual(observed)
  })

  it('redacts custom provider failures from receipts, durable jobs, logs, and public search results', async () => {
    const sensitive = [
      'embed-secret-value',
      'Bearer embed-secret-value',
      'authorization-marker',
      'embed-upstream-body',
    ]
    const upstream: Record<string, unknown> = {
      requestHeaders: { authorization: sensitive[1], marker: sensitive[2] },
      responseBody: sensitive[3],
    }
    upstream.self = upstream
    const providerFailure = new MemoryError(
      'EMBEDDING_FAILED',
      `custom embedding failed with ${sensitive[0]} and ${sensitive[3]}`,
      { cause: upstream },
    )
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription(),
      async () => { throw providerFailure },
    )
    const consoleSpies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ]
    const ctx = await setup({ embeddingProvider: provider })
    const durableStates = observeDurableStates(ctx)

    const receipt = await ctx.memory.add({
      scope: scope('redacted-custom-provider'),
      content: 'The emergency rendezvous is Saffron Harbor.',
      idempotencyKey: 'redacted-custom-provider',
    })
    const searchResult = await ctx.memory.search({
      scope: scope('redacted-custom-provider'),
      query: 'Saffron Harbor',
    })
    const degradedJob = durableStates
      .flatMap(state => state.jobs)
      .findLast(job => job.rawMemoryId === receipt.rawMemoryId && job.status === 'degraded')

    expect(receipt).toMatchObject({
      status: 'degraded',
      createdMemoryIds: [],
      warnings: ['embedding provider failed'],
    })
    expect(degradedJob).toMatchObject({ warnings: ['embedding provider failed'] })
    expect(searchResult.channels.normal.map(hit => hit.memory.id)).toContain(receipt.rawMemoryId)
    const observable = diagnosticObjectGraph({
      receipt,
      degradedJob,
      searchResult,
      logger: (ctx.logger as unknown as { readonly buffer?: unknown }).buffer,
      console: consoleSpies.map(spy => spy.mock.calls),
    })
    for (const value of sensitive) expect(observable).not.toContain(value)
  })

  it('rejects a direct write when the completion storage update fails without a degraded rewrite', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const durableStates = observeDurableStates(ctx)
    const table = (ctx.memory as unknown as {
      readonly table: {
        update(key: unknown, updater: (current: unknown) => unknown): Promise<unknown>
      }
    }).table
    const commitFailure = new Error('fixture completion storage update failed')
    const updateSpy = vi.spyOn(table, 'update').mockRejectedValueOnce(commitFailure)

    try {
      const failure = await captureFailure(() => ctx.memory.add({
        scope: scope('completion-storage-failure'),
        content: 'The direct write must retain only its durable raw evidence.',
        idempotencyKey: 'completion-storage-failure',
      }))

      expect(failure).toBe(commitFailure)
      expect(updateSpy).toHaveBeenCalledTimes(1)
      expect(provider.calls).toHaveLength(1)
      const records = ctx.memory.export(scope('completion-storage-failure'))
      expect(records).toEqual([
        expect.objectContaining({
          layer: 'l1_raw',
          status: 'active',
          visibility: 'recallable',
          embedding: {
            spaceId: provider.describe().spaceId,
            dimensions: provider.describe().dimensions,
            vector: [0, 0, 0],
          },
        }),
      ])
      expect(durableStates).toHaveLength(1)
      expect(durableStates[0]?.jobs).toEqual([
        expect.objectContaining({
          rawMemoryId: records[0]?.id,
          status: 'accepted',
          createdMemoryIds: [],
          warnings: [],
        }),
      ])
    } finally {
      updateSpy.mockRestore()
    }
  })

  it('falls back to lexical results with stable diagnostics on search failure', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const receipt = await ctx.memory.add({
      scope: scope('lexical-fallback'),
      content: 'The deployment codename is Jade Lantern.',
      idempotencyKey: 'lexical-fallback-seed',
    })
    expect(receipt.status).toBe('completed')
    provider.calls.splice(0)
    provider.implementation = async () => { throw new Error('search embedding unavailable') }

    const result = await ctx.memory.search({ scope: scope('lexical-fallback'), query: 'Jade Lantern' })

    expect(provider.calls).toHaveLength(1)
    expect(result.channels.normal.map(hit => hit.memory.content)).toContain('The deployment codename is Jade Lantern.')
    const hit = result.channels.normal.find(candidate => candidate.memory.content.includes('Jade Lantern'))
    expect(hit?.matchedBy).toContain('lexical')
    expect(hit?.matchedBy).not.toContain('semantic')
    expect(result.diagnostics.degradedChannels).toContain('semantic:provider-unavailable')
    expect(result.diagnostics.degradedChannels).not.toContain('semantic:portable-hash')
  })

  it('continues reconciliation with lexical candidates when only the reconcile-query embedding fails', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    await ctx.memory.add({
      scope: scope('reconcile-lexical-fallback'),
      content: 'The launch window is October.',
      idempotencyKey: 'reconcile-existing',
    })
    await ctx.memory.add({
      scope: scope('reconcile-lexical-fallback'),
      content: 'Brass telescope rests beside eastern balcony.',
      idempotencyKey: 'reconcile-distractor',
    })
    const candidate = ctx.memory.list({
      scope: scope('reconcile-lexical-fallback'),
      layers: ['l2_fact'],
    }).find(record => record.content === 'The launch window is October.')
    const distractor = ctx.memory.list({
      scope: scope('reconcile-lexical-fallback'),
      layers: ['l2_fact'],
    }).find(record => record.content === 'Brass telescope rests beside eastern balcony.')
    if (candidate === undefined) throw new Error('missing lexical reconciliation candidate')
    if (distractor === undefined) throw new Error('missing lexical reconciliation distractor')

    const extractedContent = 'October remains the launch window.'
    provider.calls.splice(0)
    provider.implementation = async texts => {
      if (texts.length === 1 && texts[0] === extractedContent) {
        throw new Error('reconcile query semantic channel unavailable')
      }
      return texts.map(() => [3, 4, 0])
    }
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: [{
          clientRef: 'lexical-noop',
          content: extractedContent,
          layer: 'l2_fact',
          tags: ['calendar'],
          confidence: 0.95,
          evidenceTurnIndexes: [1],
        }],
        identities: [],
      }),
      JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'lexical-noop', duplicateOf: candidate.id }] }),
    ])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: scope('reconcile-lexical-fallback'),
      content: 'User: October remains the launch window.',
      mode: 'extract',
      idempotencyKey: 'reconcile-lexical-fallback',
    })

    expect(receipt).toMatchObject({ status: 'completed', createdMemoryIds: [] })
    expect(adapter.responses).toEqual([])
    expect(adapter.calls).toHaveLength(2)
    const reconciliationPrompt = JSON.stringify(adapter.calls[1])
    expect(reconciliationPrompt).toContain(candidate.id)
    expect(reconciliationPrompt).toContain(candidate.content)
    expect(reconciliationPrompt).not.toContain(distractor.id)
    expect(reconciliationPrompt).not.toContain(distractor.content)
    expect(provider.calls.some(call => call.texts.length === 1 && call.texts[0] === extractedContent)).toBe(true)
    expect(ctx.memory.get(candidate.id, scope('reconcile-lexical-fallback'))?.sourceMemoryIds).toHaveLength(2)
    expect(ctx.memory.get(receipt.rawMemoryId, scope('reconcile-lexical-fallback'))).toMatchObject({
      status: 'active',
      visibility: 'source_only',
    })
  })

  it('recalls a degraded zero-placeholder raw through lexical search when semantic search also fails', async () => {
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription(),
      async () => { throw new Error('persistent fixture embedding outage') },
    )
    const ctx = await setup({ embeddingProvider: provider })
    const receipt = await ctx.memory.add({
      scope: scope('degraded-raw-search'),
      content: 'The emergency rendezvous is Saffron Harbor.',
      idempotencyKey: 'degraded-raw-search',
    })
    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(ctx.memory.get(receipt.rawMemoryId, scope('degraded-raw-search'))).toMatchObject({
      layer: 'l1_raw',
      status: 'active',
      visibility: 'recallable',
      embedding: { spaceId: provider.describe().spaceId, dimensions: 3, vector: [0, 0, 0] },
    })

    const result = await ctx.memory.search({ scope: scope('degraded-raw-search'), query: 'Saffron Harbor' })
    const rawHit = result.channels.normal.find(hit => hit.memory.id === receipt.rawMemoryId)
    expect(rawHit?.matchedBy).toContain('lexical')
    expect(rawHit?.matchedBy).not.toContain('semantic')
    expect(result.diagnostics.degradedChannels).toContain('semantic:provider-unavailable')
  })

  it('propagates caller cancellation from trained search instead of reporting lexical success', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    await ctx.memory.add({
      scope: scope('search-abort'),
      content: 'The deployment codename is Jade Lantern.',
      idempotencyKey: 'search-abort-seed',
    })
    provider.implementation = async (_texts, signal) => await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const controller = new AbortController()
    const pending = ctx.memory.search({ scope: scope('search-abort'), query: 'Jade Lantern' }, controller.signal)
    const reason = new Error('caller cancelled trained search')
    controller.abort(reason)

    const failure = await captureFailure(() => pending)
    expect(failure).toBe(reason)
    expect(failure).not.toBeInstanceOf(MemoryError)
  })

  it('prefilters an empty or foreign-owner candidate set before calling the provider', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    await ctx.memory.add({
      scope: scope('owner-a'),
      content: 'Owner A private Jade Lantern record.',
      idempotencyKey: 'owner-a-record',
    })
    provider.calls.splice(0)

    const result = await ctx.memory.search({ scope: scope('owner-b', 'other-user'), query: 'Jade Lantern' })
    expect(result.channels).toEqual({ profile: [], normal: [] })
    expect(provider.calls).toEqual([])
  })

  it.each([
    {
      label: 'status',
      recordSession: 'filter-status',
      searchSession: 'filter-status',
      recordOverrides: { status: 'archived' as const },
      searchOverrides: {},
    },
    {
      label: 'visibility',
      recordSession: 'filter-visibility',
      searchSession: 'filter-visibility',
      recordOverrides: { visibility: 'source_only' as const },
      searchOverrides: {},
    },
    {
      label: 'validity',
      recordSession: 'filter-validity',
      searchSession: 'filter-validity',
      recordOverrides: { validUntil: '2020-01-01T00:00:00.000Z' },
      searchOverrides: {},
    },
    {
      label: 'layers',
      recordSession: 'filter-layers',
      searchSession: 'filter-layers',
      recordOverrides: {},
      searchOverrides: { layers: ['l4_identity'] as const },
    },
    {
      label: 'sessionOnly',
      recordSession: 'filter-stored-session',
      searchSession: 'filter-query-session',
      recordOverrides: {},
      searchOverrides: { sessionOnly: true },
    },
  ])('does not call the provider after same-owner non-empty state is exhausted by $label filtering', async (fixture) => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const recordScope = scope(fixture.recordSession)
    await ctx.memory.import(recordScope, [importedRecord({
      id: `filtered-${fixture.label}`,
      owner: recordScope,
      content: 'Filtered Jade Lantern candidate.',
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0.6, 0.8, 0],
      overrides: fixture.recordOverrides,
    })])
    expect(ctx.memory.export(recordScope)).toHaveLength(1)
    provider.calls.splice(0)

    const result = await ctx.memory.search({
      scope: scope(fixture.searchSession),
      query: 'Filtered Jade Lantern candidate.',
      ...fixture.searchOverrides,
    })
    expect(result.channels).toEqual({ profile: [], normal: [] })
    expect(provider.calls).toEqual([])
  })

  it('writes and searches trained vectors without portable-hash diagnostics and reports active health', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const receipt = await ctx.memory.add({
      scope: scope('trained-normal'),
      content: 'The preferred observability tool is Honeycomb.',
      idempotencyKey: 'trained-normal',
    })
    const result = await ctx.memory.search({ scope: scope('trained-normal'), query: 'observability platform' })

    expect(receipt.status).toBe('completed')
    expect(result.channels.normal.map(hit => hit.memory.content)).toContain('The preferred observability tool is Honeycomb.')
    expect(result.diagnostics.degradedChannels).not.toContain('semantic:portable-hash')
    expect(ctx.memory.health()).toMatchObject({
      ready: true,
      embeddingSpaceId: provider.describe().spaceId,
      capabilities: { semanticSearch: true, lexicalSearch: true, preFilter: true },
    })
    for (const record of ctx.memory.export(scope('trained-normal'))) {
      expect(record.embedding).toMatchObject({ spaceId: provider.describe().spaceId, dimensions: 3 })
      expect(vectorNorm(record.embedding.vector)).toBeCloseTo(1, 12)
    }
  })

  it('keeps the default hash write, ranking, diagnostics, and health behavior byte-compatible', async () => {
    const ctx = await setup()
    const content = 'The deployment codename is Jade Lantern.'
    const receipt = await ctx.memory.add({
      scope: scope('default-hash'),
      content,
      idempotencyKey: 'default-hash',
    })
    const records = ctx.memory.export(scope('default-hash'))
    const result = await ctx.memory.search({ scope: scope('default-hash'), query: 'Jade Lantern' })

    expect(receipt.status).toBe('completed')
    expect(records).toHaveLength(2)
    for (const record of records) {
      expect(record.embedding).toEqual({
        spaceId: HASH_EMBEDDING_SPACE_ID,
        dimensions: HASH_EMBEDDING_DIMENSIONS,
        vector: hashEmbedding(content),
      })
    }
    expect(result.channels.normal[0]?.memory.content).toBe(content)
    expect(result.diagnostics.degradedChannels).toContain('semantic:portable-hash')
    expect(ctx.memory.health().embeddingSpaceId).toBe(HASH_EMBEDDING_SPACE_ID)
  })
})

describe('MEM-101 embedding space isolation', () => {
  it('atomically rejects an active recallable trained L2 zero vector', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const owner = scope('trained-zero-l2-import')
    const valid = importedRecord({
      id: 'trained-zero-valid-control',
      owner,
      content: 'A valid trained vector before the invalid record.',
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0.6, 0.8, 0],
    })
    const zero = importedRecord({
      id: 'trained-zero-active-l2',
      owner,
      content: 'An active trained fact cannot use a semantic zero placeholder.',
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0, 0, 0],
    })

    const failure = await captureFailure(() => ctx.memory.import(owner, [valid, zero]))

    expect(failure).toBeInstanceOf(MemoryError)
    expect(failure).toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH' })
    expect(ctx.memory.export(owner)).toEqual([])
  })

  it('rejects an imported orphan trained L1 zero placeholder without a durable job', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const owner = scope('trained-zero-orphan-raw')
    const orphan = importedRecord({
      id: 'trained-zero-orphan-raw',
      owner,
      content: 'A raw placeholder imported without its accepted or degraded job.',
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0, 0, 0],
      overrides: { layer: 'l1_raw' },
    })

    const failure = await captureFailure(() => ctx.memory.import(owner, [orphan]))

    expect(failure).toBeInstanceOf(MemoryError)
    expect(failure).toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH' })
    expect(ctx.memory.export(owner)).toEqual([])
  })

  it('allows a trained L1 zero placeholder created with its degraded durable job', async () => {
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription(),
      async () => { throw new Error('fixture trained provider outage') },
    )
    const ctx = await setup({ embeddingProvider: provider })
    const durableStates = observeDurableStates(ctx)

    const receipt = await ctx.memory.add({
      scope: scope('trained-zero-degraded-raw'),
      content: 'The degraded raw remains usable as lexical evidence.',
      idempotencyKey: 'trained-zero-degraded-raw',
    })
    const records = ctx.memory.export(scope('trained-zero-degraded-raw'))
    const latest = durableStates.at(-1)

    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [] })
    expect(records).toEqual([
      expect.objectContaining({
        id: receipt.rawMemoryId,
        layer: 'l1_raw',
        status: 'active',
        visibility: 'recallable',
        embedding: {
          spaceId: provider.describe().spaceId,
          dimensions: provider.describe().dimensions,
          vector: [0, 0, 0],
        },
      }),
    ])
    expect(latest?.jobs).toEqual([
      expect.objectContaining({
        rawMemoryId: receipt.rawMemoryId,
        status: 'degraded',
        createdMemoryIds: [],
      }),
    ])
  })

  it('does not reject portable-hash zero vectors solely because trained placeholders are constrained', async () => {
    const ctx = await setup()
    const owner = scope('portable-hash-zero-import')
    const record = importedRecord({
      id: 'portable-hash-zero-import',
      owner,
      content: 'Portable hash compatibility remains independent of trained-vector lifecycle rules.',
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: Array.from({ length: HASH_EMBEDDING_DIMENSIONS }, () => 0),
    })

    await expect(ctx.memory.import(owner, [record])).resolves.toBe(1)
    expect(ctx.memory.export(owner)).toEqual([record])
  })

  it('rejects importing a hash record into a trained store and a trained record into a hash store', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const trained = await setup({ embeddingProvider: provider })
    const hash = await setup()
    const owner = scope('foreign-import')

    await expect(trained.memory.import(owner, [importedRecord({
      id: 'hash-record',
      owner,
      content: 'Hash-space import.',
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: hashEmbedding('Hash-space import.'),
    })])).rejects.toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH' })

    await expect(hash.memory.import(owner, [importedRecord({
      id: 'trained-record',
      owner,
      content: 'Trained-space import.',
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0.6, 0.8, 0],
    })])).rejects.toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH' })
  })

  it('rejects the active spaceId when persisted dimensions differ', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const owner = scope('same-space-wrong-dimensions')

    const failure = await captureFailure(() => ctx.memory.import(owner, [importedRecord({
      id: 'same-space-wrong-dimensions',
      owner,
      content: 'Same identifier does not excuse a dimensional mismatch.',
      spaceId: provider.describe().spaceId,
      dimensions: 2,
      vector: [0.6, 0.8],
    })]))
    expect(failure).toBeInstanceOf(MemoryError)
    expect((failure as MemoryError).code).toBe('EMBEDDING_SPACE_MISMATCH')
    expect(ctx.memory.export(owner)).toEqual([])
  })

  it('atomically rejects a mixed import while preserving existing same-owner records', async () => {
    const provider = new ScriptedEmbeddingProvider()
    const ctx = await setup({ embeddingProvider: provider })
    const controlOwner = scope('atomic-valid-control')
    const owner = scope('atomic-mixed-import')
    const valid = importedRecord({
      id: 'atomic-valid-trained',
      owner,
      content: 'This valid record precedes an invalid record in one import.',
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0.6, 0.8, 0],
    })
    const foreign = importedRecord({
      id: 'atomic-foreign-hash',
      owner,
      content: 'This record belongs to the portable hash space.',
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: hashEmbedding('This record belongs to the portable hash space.'),
    })

    const control = importedRecord({
      id: 'atomic-valid-control',
      owner: controlOwner,
      content: valid.content,
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [0.6, 0.8, 0],
    })
    await expect(ctx.memory.import(controlOwner, [control])).resolves.toBe(1)
    expect(ctx.memory.export(controlOwner)).toEqual([control])

    await expect(ctx.memory.import(owner, [valid, foreign]))
      .rejects.toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH' })
    const after = ctx.memory.export(owner)
    expect(after).toEqual([control])
    expect(after.map(record => record.id)).not.toContain(valid.id)
    expect(after.map(record => record.id)).not.toContain(foreign.id)
  })

  it('rejects a cold switch from a non-empty hash store to a trained space without migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-cold-switch-'))
    roots.push(root)
    const first = await setup({ root })
    await first.memory.add({
      scope: scope('cold-switch'),
      content: 'Canonical hash data must not be silently reinterpreted.',
      idempotencyKey: 'cold-switch-seed',
    })
    await disposeContext(first)

    const failure = await captureFailure(() => setup({
      root,
      embeddingProvider: new ScriptedEmbeddingProvider(),
    }))
    expect(failure, 'non-empty hash store accepted a trained space').toBeDefined()
    expect(failure).toMatchObject({ code: 'EMBEDDING_SPACE_MISMATCH' })
  })
})

describe('MEM-103 reconciliation embedding batches and atomic failures', () => {
  it('embeds source contents in bounded ordered batches and maps every result back across batches', async () => {
    const sourceTexts = [
      'alpha-source semantic query',
      'beta-source semantic query',
      'gamma-source semantic query',
    ] as const
    const vectors = new Map<string, readonly number[]>([
      [sourceTexts[0], [1, 0, 0]],
      [sourceTexts[1], [0, 1, 0]],
      [sourceTexts[2], [0, 0, 1]],
    ])
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 2 }),
      async texts => texts.map(text => vectors.get(text) ?? [3, 4, 0]),
    )
    const ctx = await setup({ embeddingProvider: provider, reconcileCandidateLimit: 1 })
    const owner = scope('per-source-batches')
    const candidates = sourceTexts.map((content, index) => importedRecord({
      id: `per-source-candidate-${index}`,
      owner,
      content,
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: vectors.get(content) ?? [3, 4, 0],
    }))
    await ctx.memory.import(owner, candidates)
    const raw = 'evidence with three independently reconciled sources'
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: sourceTexts.map((content, index) => ({
          clientRef: `source-${index}`,
          content,
          layer: 'l2_fact',
          tags: [],
          confidence: 0.9,
          evidenceTurnIndexes: [index + 1],
        })),
        identities: [],
      }),
      JSON.stringify({ operations: candidates.map((candidate, index) => ({
        type: 'NOOP',
        sourceRef: `source-${index}`,
        duplicateOf: candidate.id,
      })) }),
    ])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: owner,
      content: raw,
      mode: 'extract',
      idempotencyKey: 'per-source-batches',
    })

    expect(receipt).toMatchObject({ status: 'completed', createdMemoryIds: [] })
    expect(provider.calls.map(call => call.texts)).toEqual([
      [sourceTexts[0], sourceTexts[1]],
      [sourceTexts[2]],
      [raw],
    ])
    expect(adapter.calls).toHaveLength(2)
    for (const candidate of candidates) {
      expect(ctx.memory.get(candidate.id, owner)?.sourceMemoryIds).toHaveLength(1)
    }
  })

  it.each(['throw', 'zero-vector'] as const)(
    'continues later source batches after a %s provider batch failure when lexical remains available',
    async failureMode => {
    const sourceTexts = ['failed semantic alpha', 'working semantic beta', 'working semantic gamma'] as const
    const secret = `provider-batch-${failureMode}-secret`
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 1 }),
      async texts => {
        if (texts[0] === sourceTexts[0]) {
          if (failureMode === 'throw') throw new Error(secret)
          return [[0, 0, 0]]
        }
        return texts.map(() => [3, 4, 0])
      },
    )
    const tokenizer = {
      tokenize: (text: string) => text === '' ? [] : text.toLowerCase().split(/\s+/u),
    }
    const ctx = await setup({
      embeddingProvider: provider,
      lexicalTokenizer: tokenizer,
      reconcileCandidateLimit: 1,
    })
    const owner = scope('batch-fallback')
    const candidates = sourceTexts.map((content, index) => importedRecord({
      id: `batch-fallback-candidate-${index}`,
      owner,
      content,
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [3, 4, 0],
    }))
    await ctx.memory.import(owner, candidates)
    const raw = 'batch fallback evidence'
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: sourceTexts.map((content, index) => ({
          clientRef: `fallback-source-${index}`,
          content,
          layer: 'l2_fact',
          tags: [],
          confidence: 0.9,
          evidenceTurnIndexes: [index + 1],
        })),
        identities: [],
      }),
      JSON.stringify({ operations: candidates.map((candidate, index) => ({
        type: 'NOOP',
        sourceRef: `fallback-source-${index}`,
        duplicateOf: candidate.id,
      })) }),
    ])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({ scope: owner, content: raw, mode: 'extract', idempotencyKey: 'batch-fallback' })

    expect(receipt.status).toBe('completed')
    expect(provider.calls.map(call => call.texts)).toEqual([
      [sourceTexts[0]],
      [sourceTexts[1]],
      [sourceTexts[2]],
      [raw],
    ])
    expect(adapter.calls).toHaveLength(2)
    expect(diagnosticObjectGraph({
      receipt,
      records: ctx.memory.export(owner),
      health: ctx.memory.health(),
      logger: (ctx.logger as unknown as { readonly buffer?: unknown }).buffer,
    }))
      .not.toContain(secret)
  })

  it('completes complementary per-source channel fallbacks in one reconciliation call', async () => {
    const sourceQueries = ['source a semantic query', 'source b stable lexical overlap'] as const
    const candidateContents = ['source a semantic candidate', 'source b stable lexical overlap candidate'] as const
    const seen: string[] = []
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 1 }),
      async texts => {
        if (texts[0] === sourceQueries[1]) throw new Error('source-b-semantic-secret')
        return texts.map(text => text === sourceQueries[0] ? [1, 0, 0] : [3, 4, 0])
      },
    )
    const tokenizer = {
      tokenize: (text: string) => {
        if (text === '') return []
        seen.push(text)
        if (text === sourceQueries[0]) throw new Error('single source tokenizer failure')
        return text.toLowerCase().split(/\s+/u)
      },
    }
    const ctx = await setup({ embeddingProvider: provider, lexicalTokenizer: tokenizer, reconcileCandidateLimit: 1 })
    const owner = scope('tokenizer-semantic-fallback')
    const candidates = candidateContents.map((content, index) => importedRecord({
      id: `tokenizer-semantic-candidate-${index}`,
      owner,
      content,
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: index === 0 ? [1, 0, 0] : [0, 1, 0],
    }))
    await ctx.memory.import(owner, candidates)
    const adapter = new JsonAdapter([
      JSON.stringify({
        basicProfilePatch: {},
        facts: sourceQueries.map((content, index) => ({
          clientRef: `tokenizer-source-${index}`,
          content,
          layer: 'l2_fact',
          tags: [],
          confidence: 0.9,
          evidenceTurnIndexes: [index + 1],
        })),
        identities: [],
      }),
      JSON.stringify({ operations: candidates.map((candidate, index) => ({
        type: 'NOOP',
        sourceRef: `tokenizer-source-${index}`,
        duplicateOf: candidate.id,
      })) }),
    ])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: owner,
      content: 'tokenizer semantic fallback evidence',
      mode: 'extract',
      idempotencyKey: 'tokenizer-semantic-fallback',
    })

    expect(receipt.status).toBe('completed')
    expect(provider.calls.map(call => call.texts)).toEqual([
      [sourceQueries[0]],
      [sourceQueries[1]],
      ['tokenizer semantic fallback evidence'],
    ])
    expect(seen).toContain(sourceQueries[0])
    expect(seen).toContain(sourceQueries[1])
    expect(seen).toContain(candidateContents[1])
    expect(seen.filter(text => text === sourceQueries[0])).toHaveLength(1)
    expect(adapter.calls).toHaveLength(2)
    expect(JSON.stringify({ receipt, records: ctx.memory.export(owner) })).not.toContain('source-b-semantic-secret')
  })

  it('degrades the whole job without a model plan when one source loses both channels', async () => {
    const sourceTexts = ['healthy first source', 'double unavailable source'] as const
    const providerSecret = 'provider-double-channel-secret'
    const tokenizerSecret = 'tokenizer-double-channel-secret'
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 1 }),
      async texts => {
        if (texts[0] === sourceTexts[1]) throw new Error(providerSecret)
        return texts.map(() => [3, 4, 0])
      },
    )
    const tokenizer = {
      tokenize: (text: string) => {
        if (text === '') return []
        if (text.includes(sourceTexts[1])) throw new Error(tokenizerSecret)
        return text.toLowerCase().split(/\s+/u)
      },
    }
    const ctx = await setup({ embeddingProvider: provider, lexicalTokenizer: tokenizer, reconcileCandidateLimit: 1 })
    const owner = scope('double-channel-source')
    const candidates = sourceTexts.map((content, index) => importedRecord({
      id: `double-channel-candidate-${index}`,
      owner,
      content,
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [3, 4, 0],
    }))
    await ctx.memory.import(owner, candidates)
    const adapter = new JsonAdapter([JSON.stringify({
      basicProfilePatch: {},
      facts: sourceTexts.map((content, index) => ({
        clientRef: `double-source-${index}`,
        content,
        layer: 'l2_fact',
        tags: [],
        confidence: 0.9,
        evidenceTurnIndexes: [index + 1],
      })),
      identities: [],
    })])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: owner,
      content: 'double channel failure evidence',
      mode: 'extract',
      idempotencyKey: 'double-channel-source',
    })

    expect(receipt).toMatchObject({
      status: 'degraded',
      createdMemoryIds: [],
      warnings: ['lexical tokenizer failed'],
    })
    expect(adapter.calls).toHaveLength(1)
    expect(provider.calls.map(call => call.texts)).toEqual([[sourceTexts[0]], [sourceTexts[1]]])
    expect(ctx.memory.export(owner)).toEqual([
      ...candidates,
      expect.objectContaining({
        id: receipt.rawMemoryId,
        layer: 'l1_raw',
        status: 'active',
        visibility: 'recallable',
        embedding: expect.objectContaining({ vector: [0, 0, 0] }),
      }),
    ])
    expect(JSON.stringify({ receipt, records: ctx.memory.export(owner) }))
      .not.toMatch(/provider-double-channel-secret|tokenizer-double-channel-secret/u)
  })

  it('propagates caller abort from the first source batch and never starts later batches or reconciliation', async () => {
    const sourceTexts = ['abort first source', 'must not start second source'] as const
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => { startedResolve = resolve })
    const provider = new ScriptedEmbeddingProvider(
      trainedDescription({ maxBatchSize: 1 }),
      async (texts, signal) => {
        startedResolve?.()
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    )
    const ctx = await setup({ embeddingProvider: provider, reconcileCandidateLimit: 1 })
    const owner = scope('per-source-abort')
    const candidates = sourceTexts.map((content, index) => importedRecord({
      id: `abort-candidate-${index}`,
      owner,
      content,
      spaceId: provider.describe().spaceId,
      dimensions: provider.describe().dimensions,
      vector: [3, 4, 0],
    }))
    await ctx.memory.import(owner, candidates)
    const adapter = new JsonAdapter([JSON.stringify({
      basicProfilePatch: {},
      facts: sourceTexts.map((content, index) => ({
        clientRef: `abort-source-${index}`,
        content,
        layer: 'l2_fact',
        tags: [],
        confidence: 0.9,
        evidenceTurnIndexes: [index + 1],
      })),
      identities: [],
    })])
    ctx.llm.registerAdapter(['embedding-test-llm'], adapter)
    const controller = new AbortController()
    const reason = new Error('MEM-103 caller abort sentinel')
    const input = {
      scope: owner,
      content: 'caller abort raw evidence',
      mode: 'extract' as const,
      idempotencyKey: 'per-source-abort',
    }
    const pending = ctx.memory.add(input, controller.signal)
    await started
    controller.abort(reason)

    const failure = await captureFailure(() => pending)

    expect(failure).toBe(reason)
    expect(provider.calls.map(call => call.texts)).toEqual([[sourceTexts[0]]])
    expect(adapter.calls).toHaveLength(1)
    const durable = await ctx.memory.add(input)
    expect(durable).toMatchObject({
      status: 'degraded',
      createdMemoryIds: [],
      warnings: ['memory enrichment aborted'],
    })
    expect(adapter.calls).toHaveLength(1)
    const exported = ctx.memory.export(owner)
    expect(exported).toEqual([
      ...candidates,
      expect.objectContaining({ layer: 'l1_raw', status: 'active', visibility: 'recallable' }),
    ])
  })
})
