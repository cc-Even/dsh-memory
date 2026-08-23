import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
  MemoryError,
  hashEmbedding,
} from '../src/index.ts'

interface EmbeddingDescription {
  readonly spaceId: string
  readonly dimensions: number
  readonly maxBatchSize: number
  readonly normalization: 'l2'
  readonly quality: 'portable-hash' | 'trained'
}

interface EmbeddingProviderInstance {
  describe(): EmbeddingDescription
  embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>
}

interface EmbeddingModule {
  readonly EmbeddingProvider: abstract new () => EmbeddingProviderInstance
  readonly HashEmbeddingProvider: new () => EmbeddingProviderInstance
  readonly OpenAICompatibleEmbeddingProvider: new (options: {
    readonly baseUrl: string
    readonly apiKey: string
    readonly model: string
    readonly spaceId: string
    readonly dimensions: number
    readonly batchSize?: number
    readonly timeoutMs?: number
    readonly maxRetries?: number
    readonly retryBaseDelayMs?: number
  }) => EmbeddingProviderInstance
}

const embeddingUrl = new URL('../src/embedding.ts', import.meta.url)
const workspace = fileURLToPath(new URL('..', import.meta.url))
const sourcePath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const roots: string[] = []

async function loadEmbedding(): Promise<EmbeddingModule> {
  return await import(/* @vite-ignore */ embeddingUrl.href) as EmbeddingModule
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function embeddingResponse(vectors: readonly (readonly number[])[], model = 'fixture-model'): Response {
  return jsonResponse({
    object: 'list',
    model,
    data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
    usage: { prompt_tokens: 3, total_tokens: 3 },
  })
}

function responseWithAbortableHangingJson(
  init: RequestInit | undefined,
  onBodyRead: () => void = () => undefined,
): Response {
  const response = new Response(null, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  Object.defineProperty(response, 'json', {
    configurable: true,
    value: async () => await new Promise<never>((_resolve, reject) => {
      onBodyRead()
      const signal = init?.signal
      const rejectFromAbort = (): void => reject(signal?.reason)
      if (signal?.aborted) {
        rejectFromAbort()
        return
      }
      signal?.addEventListener('abort', rejectFromAbort, { once: true })
    }),
  })
  return response
}

function trainedOptions(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    baseUrl: 'https://embedding.example.invalid/compatible/v1/',
    apiKey: 'fixture-secret-key',
    model: 'fixture-model',
    spaceId: 'test/openai-compatible/fixture-model/3/l2',
    dimensions: 3,
    batchSize: 4,
    timeoutMs: 100,
    maxRetries: 1,
    retryBaseDelayMs: 1,
    ...overrides,
  }
}

function objectGraphText(value: unknown): string {
  const seen = new Set<object>()
  const parts: string[] = []

  function visit(current: unknown): void {
    if ((typeof current !== 'object' || current === null) && typeof current !== 'function') {
      parts.push(String(current))
      return
    }
    const object = current as object
    if (seen.has(object)) return
    seen.add(object)
    parts.push(inspect(current, { depth: null, getters: false, showHidden: true }))
    if (current instanceof Map) {
      for (const [key, entry] of current) {
        visit(key)
        visit(entry)
      }
    }
    if (current instanceof Set) for (const entry of current) visit(entry)
    for (const key of Reflect.ownKeys(object)) {
      parts.push(String(key))
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(object, key)
      } catch {
        continue
      }
      if (descriptor !== undefined && 'value' in descriptor) visit(descriptor.value)
    }
  }

  visit(value)
  return parts.join('\n')
}

async function captureFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error
  }
}

function expectEmbeddingFailure(failure: unknown): void {
  expect(failure).toBeInstanceOf(MemoryError)
  expect((failure as MemoryError).code).toBe('EMBEDDING_FAILED')
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-101 EmbeddingProvider port and portable hash implementation', () => {
  it('exports the abstract describe/embedBatch port and preserves the legacy hash descriptor and vectors', async () => {
    const module = await loadEmbedding()
    const publicModule = await import('../src/index.ts') as unknown as Partial<EmbeddingModule>
    expect(module.EmbeddingProvider).toBeTypeOf('function')
    expect(publicModule.EmbeddingProvider).toBe(module.EmbeddingProvider)
    expect(publicModule.HashEmbeddingProvider).toBe(module.HashEmbeddingProvider)
    expect(publicModule.OpenAICompatibleEmbeddingProvider).toBe(module.OpenAICompatibleEmbeddingProvider)
    const provider = new module.HashEmbeddingProvider()
    const texts = ['Jade Lantern', '用户偏爱悬疑推理电影。']

    expect(provider.describe()).toEqual({
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      maxBatchSize: expect.any(Number),
      normalization: 'l2',
      quality: 'portable-hash',
    })
    expect(provider.describe().maxBatchSize).toBeGreaterThan(0)
    await expect(provider.embedBatch(texts)).resolves.toEqual(texts.map(hashEmbedding))
  })

  it('keeps empty input deterministic and offline', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('hash provider attempted network access')))
    vi.stubGlobal('fetch', fetchSpy)
    const { HashEmbeddingProvider } = await loadEmbedding()

    await expect(new HashEmbeddingProvider().embedBatch([])).resolves.toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('MEM-101 OpenAI-compatible embedding adapter', () => {
  it('describes only non-secret routing facts and sends the exact OpenAI-compatible request', async () => {
    const fetchSpy = vi.fn(() => Promise.resolve(embeddingResponse([[1, 2, 3], [4, 5, 6]])))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions())

    expect(provider.describe()).toEqual({
      spaceId: 'test/openai-compatible/fixture-model/3/l2',
      dimensions: 3,
      maxBatchSize: 4,
      normalization: 'l2',
      quality: 'trained',
    })
    expect(JSON.stringify(provider.describe())).not.toContain('fixture-secret-key')
    await expect(provider.embedBatch(['alpha', 'beta'])).resolves.toEqual([[1, 2, 3], [4, 5, 6]])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] ?? []
    expect(url).toBe('https://embedding.example.invalid/compatible/v1/embeddings')
    expect(init).toMatchObject({ method: 'POST' })
    const headers = new Headers((init as RequestInit | undefined)?.headers)
    expect(headers.get('authorization')).toBe('Bearer fixture-secret-key')
    expect(headers.get('content-type')).toMatch(/application\/json/i)
    expect(JSON.parse(String((init as RequestInit | undefined)?.body))).toEqual({
      model: 'fixture-model',
      input: ['alpha', 'beta'],
      dimensions: 3,
      encoding_format: 'float',
    })
  })

  it('keeps the OpenAI-compatible descriptor immutable across caller mutation attempts', async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        dimensions: 3,
        input: ['immutable descriptor'],
      })
      return embeddingResponse([[1, 2, 3]])
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions())
    const expected = structuredClone(provider.describe())
    const exposed = provider.describe() as EmbeddingDescription & {
      dimensions: number
      model?: string
      spaceId: string
    }

    try {
      exposed.dimensions = 65_537
      exposed.model = 'caller-mutated-model'
      exposed.spaceId = 'caller-mutated-space'
    } catch {
      // A frozen descriptor is an equally valid immutable contract.
    }

    const subsequent = provider.describe()
    expect(Object.isFrozen(exposed) || subsequent !== exposed).toBe(true)
    expect(subsequent).toEqual(expected)
    await expect(provider.embedBatch(['immutable descriptor'])).resolves.toEqual([[1, 2, 3]])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('restores input order from indexed response items', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({
      object: 'list',
      model: 'fixture-model',
      data: [
        { object: 'embedding', index: 1, embedding: [4, 5, 6] },
        { object: 'embedding', index: 0, embedding: [1, 2, 3] },
      ],
    }))))
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()

    await expect(new OpenAICompatibleEmbeddingProvider(trainedOptions()).embedBatch(['first', 'second']))
      .resolves.toEqual([[1, 2, 3], [4, 5, 6]])
  })

  it.each([408, 429, 500, 503])('retries transient HTTP %i only within maxRetries', async (status) => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'transient' } }, status))
      .mockResolvedValueOnce(embeddingResponse([[1, 2, 3]]))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()

    await expect(new OpenAICompatibleEmbeddingProvider(trainedOptions()).embedBatch(['retry-me']))
      .resolves.toEqual([[1, 2, 3]])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries a network failure but stops at the bounded total attempt count', async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new TypeError('socket reset'))
      .mockRejectedValueOnce(new TypeError('socket reset again'))
      .mockResolvedValueOnce(embeddingResponse([[1, 2, 3]]))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions({ maxRetries: 1 }))

    const failure = await captureFailure(() => provider.embedBatch(['bounded-retry']))
    expectEmbeddingFailure(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it.each([400, 401, 403, 404, 422])('does not retry permanent HTTP %i failures', async (status) => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ error: { message: 'permanent' } }, status)))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()

    const failure = await captureFailure(() =>
      new OpenAICompatibleEmbeddingProvider(trainedOptions()).embedBatch(['no-retry']))
    expectEmbeddingFailure(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['malformed JSON', () => new Response('{not-json', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['missing data', () => jsonResponse({ object: 'list', model: 'fixture-model' })],
    ['wrong count', () => embeddingResponse([])],
    ['wrong dimension', () => embeddingResponse([[1, 2]])],
    ['non-finite number', () => jsonResponse({ data: [{ index: 0, embedding: [1, 'NaN', 3] }] })],
  ])('does not retry a successful HTTP response with %s', async (_label, response) => {
    const fetchSpy = vi.fn(() => Promise.resolve(response()))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()

    const failure = await captureFailure(() =>
      new OpenAICompatibleEmbeddingProvider(trainedOptions()).embedBatch(['invalid-schema']))
    expectEmbeddingFailure(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['duplicate indexes', [
      { object: 'embedding', index: 0, embedding: [1, 2, 3] },
      { object: 'embedding', index: 0, embedding: [4, 5, 6] },
    ]],
    ['out-of-range index', [
      { object: 'embedding', index: 0, embedding: [1, 2, 3] },
      { object: 'embedding', index: 2, embedding: [4, 5, 6] },
    ]],
    ['missing index with duplicate replacement', [
      { object: 'embedding', index: 1, embedding: [1, 2, 3] },
      { object: 'embedding', index: 1, embedding: [4, 5, 6] },
    ]],
  ])('rejects %s as a non-retryable response schema failure', async (_label, data) => {
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse({ object: 'list', model: 'fixture-model', data })))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()

    const failure = await captureFailure(() =>
      new OpenAICompatibleEmbeddingProvider(trainedOptions()).embedBatch(['first', 'second']))
    expectEmbeddingFailure(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('enforces a per-attempt timeout without retrying beyond the configured bound', async () => {
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions({ timeoutMs: 5, maxRetries: 1, retryBaseDelayMs: 1 }))

    const failure = await captureFailure(() => provider.embedBatch(['timeout']))
    expectEmbeddingFailure(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('retries when an ok response body hangs until the per-attempt timeout', async () => {
    vi.useFakeTimers()
    const attemptSignals: AbortSignal[] = []
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal !== undefined) attemptSignals.push(init.signal)
      return Promise.resolve(responseWithAbortableHangingJson(init))
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions({
      timeoutMs: 5,
      maxRetries: 1,
      retryBaseDelayMs: 1,
    }))

    const pending = captureFailure(() => provider.embedBatch(['hanging-response-body']))
    await vi.runAllTimersAsync()
    const failure = await pending

    expectEmbeddingFailure(failure)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(attemptSignals).toHaveLength(2)
    expect(attemptSignals.every(signal => signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates caller abort and never converts it into retry or success', async () => {
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions({ timeoutMs: 1_000, maxRetries: 3 }))
    const controller = new AbortController()
    const pending = provider.embedBatch(['caller-abort'], controller.signal)
    const reason = new Error('caller requested stop')
    controller.abort(reason)

    const failure = await captureFailure(() => pending)
    expect(failure).toBe(reason)
    expect(failure).not.toBeInstanceOf(MemoryError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('propagates the caller reason without retry when abort happens during response body reading', async () => {
    vi.useFakeTimers()
    let markBodyRead: (() => void) | undefined
    const bodyRead = new Promise<void>((resolve) => { markBodyRead = resolve })
    const fetchSpy = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(responseWithAbortableHangingJson(init, () => markBodyRead?.())))
    vi.stubGlobal('fetch', fetchSpy)
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions({ timeoutMs: 1_000, maxRetries: 3 }))
    const controller = new AbortController()
    const pending = captureFailure(() => provider.embedBatch(['caller-abort-during-body'], controller.signal))
    await bodyRead
    const reason = new Error('caller stopped response body reading')
    controller.abort(reason)

    const failure = await pending
    expect(failure).toBe(reason)
    expect(failure).not.toBeInstanceOf(MemoryError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never exposes credentials or upstream details anywhere in an error graph or console output', async () => {
    const secret = 'secret-value-that-must-never-escape'
    const upstreamCause: Record<string, unknown> = {
      authorization: `Bearer ${secret}`,
      requestHeaders: { authorization: `Bearer ${secret}` },
      upstreamBody: `upstream-body-marker ${secret}`,
    }
    upstreamCause.self = upstreamCause
    const upstream = new Error('fixture upstream transport failed', { cause: upstreamCause })
    Object.defineProperty(upstream, 'responseBody', {
      value: `upstream-body-marker ${secret}`,
      enumerable: false,
    })
    const fetchSpy = vi.fn(() => Promise.reject(upstream))
    vi.stubGlobal('fetch', fetchSpy)
    const consoleSpies = (['error', 'warn', 'info', 'debug', 'log'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined))
    const { OpenAICompatibleEmbeddingProvider } = await loadEmbedding()
    const provider = new OpenAICompatibleEmbeddingProvider(trainedOptions({ apiKey: secret, maxRetries: 0 }))

    const failure = await captureFailure(() => provider.embedBatch(['redact-me']))
    expectEmbeddingFailure(failure)
    const errorGraph = objectGraphText(failure)
    const consoleGraph = objectGraphText(consoleSpies.flatMap(spy => spy.mock.calls))
    for (const forbidden of [secret, 'authorization', 'requestHeaders', 'upstream-body-marker']) {
      expect(errorGraph.toLowerCase()).not.toContain(forbidden.toLowerCase())
      expect(consoleGraph.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('MEM-101 public TypeScript embedding contract', () => {
  it('typechecks provider subclassing, descriptors, constructors, and programmatic configuration from the package root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-types-'))
    roots.push(root)
    const fixturePath = join(root, 'contract.ts')
    const configPath = join(root, 'tsconfig.json')
    await writeFile(fixturePath, [
      `import MemoryService, { EmbeddingProvider, HashEmbeddingProvider, OpenAICompatibleEmbeddingProvider } from ${JSON.stringify(sourcePath)}`,
      `import type { Config, EmbeddingDescription, MemoryErrorCode } from ${JSON.stringify(sourcePath)}`,
      'class FixtureProvider extends EmbeddingProvider {',
      "  override describe(): EmbeddingDescription { return { spaceId: 'fixture/3/l2', dimensions: 3, maxBatchSize: 2, normalization: 'l2', quality: 'trained' } }",
      '  override async embedBatch(texts: readonly string[], _signal?: AbortSignal): Promise<readonly (readonly number[])[]> { return texts.map(() => [1, 0, 0]) }',
      '}',
      'const fixture = new FixtureProvider()',
      'const description: EmbeddingDescription = new HashEmbeddingProvider().describe()',
      "const remote = new OpenAICompatibleEmbeddingProvider({ baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'm', spaceId: 'fixture/m/3/l2', dimensions: 3 })",
      "const config: Config = { provider: 'llm', model: 'model', embeddingProvider: fixture }",
      "const embeddingFailureCode: MemoryErrorCode = 'EMBEDDING_FAILED'",
      'void MemoryService; void description; void remote; void config; void embeddingFailureCode',
      '',
    ].join('\n'), 'utf8')
    await writeFile(configPath, JSON.stringify({
      compilerOptions: {
        target: 'es2024',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: ['node'],
        typeRoots: [join(workspace, 'node_modules/@types')],
      },
      files: [fixturePath],
    }, null, 2), 'utf8')

    const result = spawnSync('pnpm', ['exec', 'tsc', '-p', configPath], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env },
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }, 120_000)
})
