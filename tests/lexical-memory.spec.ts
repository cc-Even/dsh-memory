import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
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
  MemoryError,
  hashEmbedding,
} from '../src/index.ts'
import type { MemoryId, MemoryLayer, MemoryRecord, MemoryScope } from '../src/types.ts'

interface Tokenizer {
  tokenize(text: string): readonly string[]
}

interface ProviderDescription {
  readonly spaceId: string
  readonly dimensions: number
  readonly maxBatchSize: number
  readonly normalization: 'l2'
  readonly quality: 'trained'
}

class ScriptedProvider {
  readonly calls: Array<{ texts: readonly string[]; signal?: AbortSignal }> = []
  implementation: (texts: readonly string[], signal?: AbortSignal) => Promise<readonly (readonly number[])[]> = async texts => texts.map(() => [1, 0, 0])

  describe(): ProviderDescription {
    return { spaceId: 'test/mem102-trained/3/l2', dimensions: 3, maxBatchSize: 16, normalization: 'l2', quality: 'trained' }
  }

  async embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    this.calls.push({ texts: [...texts], ...(signal === undefined ? {} : { signal }) })
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
    if (text === undefined) throw new Error('MEM-102 JSON adapter exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
const roots: string[] = []

function scope(sessionId: string, overrides: Partial<MemoryScope> = {}): MemoryScope {
  return { tenantId: 'lexical-tenant', userId: 'lexical-user', agentId: 'lexical-agent', sessionId, ...overrides }
}

async function setup(options: {
  readonly tokenizer?: Tokenizer
  readonly provider?: ScriptedProvider
  readonly maxInputChars?: number
  readonly tokenizerConfig?: { readonly kind: 'legacy' | 'cjk-bigram' }
} = {}): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lexical-memory-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'lexical-test-llm',
    model: 'lexical-test-model',
    tenantId: 'lexical-tenant',
    userId: 'lexical-user',
    autoCapture: false,
    autoRecall: false,
    ...(options.tokenizer === undefined ? {} : { lexicalTokenizer: options.tokenizer }),
    ...(options.tokenizerConfig === undefined ? {} : { tokenizer: options.tokenizerConfig }),
    ...(options.provider === undefined ? {} : { embeddingProvider: options.provider }),
    ...(options.maxInputChars === undefined ? {} : { maxInputChars: options.maxInputChars }),
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
  readonly validUntil?: string
  readonly provider?: ScriptedProvider
  readonly tags?: readonly string[]
  readonly meta?: Readonly<Record<string, string>>
}): MemoryRecord {
  const owner = options.owner ?? scope('record-session')
  const description = options.provider?.describe()
  const content = options.content
  const now = '2026-08-23T00:00:00.000Z'
  return {
    schemaVersion: 1,
    id: options.id as MemoryId,
    scope: owner,
    layer: options.layer ?? 'l2_fact',
    content,
    status: options.status ?? 'active',
    visibility: options.visibility ?? 'recallable',
    sourceType: 'explicit',
    confidence: 1,
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
    embedding: description === undefined
      ? { spaceId: HASH_EMBEDDING_SPACE_ID, dimensions: HASH_EMBEDDING_DIMENSIONS, vector: hashEmbedding(content) }
      : { spaceId: description.spaceId, dimensions: description.dimensions, vector: [1, 0, 0] },
  }
}

async function importRecords(ctx: Context, records: readonly MemoryRecord[]): Promise<void> {
  const byOwner = new Map<string, MemoryRecord[]>()
  for (const item of records) {
    const key = JSON.stringify([item.scope.tenantId, item.scope.userId, item.scope.agentId])
    byOwner.set(key, [...byOwner.get(key) ?? [], item])
  }
  for (const values of byOwner.values()) {
    const first = values[0]
    if (first !== undefined) await ctx.memory.import(first.scope, values)
  }
}

function throwingTokenizer(secret = 'tokenizer-secret-upstream-body'): Tokenizer {
  return { tokenize: text => {
    if (text === '') return []
    throw new Error(secret)
  } }
}

type HostileOutputKind = 'array-is-array' | 'length' | 'iterator' | 'element' | 'element-length'

function hostileTokenOutput(kind: HostileOutputKind, secret: string): readonly string[] {
  if (kind === 'array-is-array') {
    const target: string[] = []
    Object.defineProperty(target, 'hiddenSecret', { value: secret, enumerable: false })
    const revoked = Proxy.revocable(target, {})
    revoked.revoke()
    return revoked.proxy
  }
  if (kind === 'length') {
    return new Proxy<string[]>([], {
      get: (target, property, receiver) => {
        if (property === 'length') throw new Error(secret)
        return Reflect.get(target, property, receiver) as unknown
      },
    })
  }
  if (kind === 'iterator') {
    return new Proxy<string[]>([], {
      get: (target, property, receiver) => {
        if (property === Symbol.iterator) throw new Error(secret)
        return Reflect.get(target, property, receiver) as unknown
      },
    })
  }
  if (kind === 'element') {
    return new Proxy<string[]>(['safe-token'], {
      get: (target, property, receiver) => {
        if (property === '0') throw new Error(secret)
        return Reflect.get(target, property, receiver) as unknown
      },
    })
  }
  const hostileElement = new Proxy(new String('safe-token'), {
    get: (target, property, receiver) => {
      if (property === 'length') throw new Error(secret)
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  return [hostileElement as unknown as string]
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-102 search lexical channel boundaries', () => {
  it('mounts a custom-only tokenizer through Cordis/JSON and rejects both explicit loader combinations', async () => {
    const custom: Tokenizer = { tokenize: text => text === '' ? [] : ['shared-token'] }
    const provider = new ScriptedProvider()
    const customOnly = await setup({ tokenizer: custom, provider })
    await importRecords(customOnly, [record({ id: 'custom-only-hit', content: 'custom mount document', provider })])
    provider.implementation = async () => { throw new Error('semantic unavailable') }
    const result = await customOnly.memory.search({ scope: scope('custom-only'), query: 'custom mount query' })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('custom-only-hit')
    expect(result.channels.normal[0]?.matchedBy).toEqual(['lexical'])

    for (const kind of ['legacy', 'cjk-bigram'] as const) {
      let failure: unknown
      try { await setup({ tokenizer: custom, tokenizerConfig: { kind } }) } catch (error) { failure = error }
      expect(failure, kind).toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }))
    }
  })

  it('rejects an over-limit search query before tokenizer or embedding provider calls', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return text === '' ? [] : ['x'] } }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider, maxInputChars: 3 })
    await importRecords(ctx, [record({ id: 'over-limit-record', content: 'allowed', provider })])
    provider.calls.splice(0)
    seen.splice(0)

    await expect(ctx.memory.search({ scope: scope('over-limit'), query: '四个字符' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(seen).toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('pre-filters status, visibility, validity, layer, and session before exposing text to the tokenizer', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return text === '' ? [] : ['shared'] } }
    const ctx = await setup({ tokenizer })
    const queryScope = scope('SESSION_SCOPE_SENTINEL', {
      tenantId: 'TENANT_SCOPE_SENTINEL',
      userId: 'USER_SCOPE_SENTINEL',
      agentId: 'AGENT_SCOPE_SENTINEL',
    })
    await importRecords(ctx, [
      record({ id: 'VISIBLE_ID_SENTINEL', content: 'VISIBLE_CONTENT', owner: queryScope, tags: ['VISIBLE_TAG'], meta: { private: 'VISIBLE_META_SENTINEL' } }),
      record({ id: 'DELETED_ID_SENTINEL', content: 'DELETED_SECRET', owner: queryScope, status: 'deleted', visibility: 'source_only' }),
      record({ id: 'HIDDEN_ID_SENTINEL', content: 'HIDDEN_SECRET', owner: queryScope, visibility: 'source_only' }),
      record({ id: 'EXPIRED_ID_SENTINEL', content: 'EXPIRED_SECRET', owner: queryScope, validUntil: '2020-01-01T00:00:00.000Z' }),
      record({ id: 'LAYER_ID_SENTINEL', content: 'LAYER_SECRET', owner: queryScope, layer: 'l4_identity' }),
      record({ id: 'SESSION_ID_SENTINEL', content: 'SESSION_SECRET', owner: { ...queryScope, sessionId: 'OTHER_SESSION_SENTINEL' } }),
    ])

    await ctx.memory.search({ scope: queryScope, query: 'QUERY_TEXT', layers: ['l2_fact'], sessionOnly: true })
    expect(seen).toContain('QUERY_TEXT')
    expect(seen.some(text => text.includes('VISIBLE_CONTENT') && text.includes('visible_tag'))).toBe(true)
    expect(seen.join('\n')).not.toMatch(/DELETED_SECRET|HIDDEN_SECRET|EXPIRED_SECRET|LAYER_SECRET|SESSION_SECRET/u)
    expect(seen.join('\n')).not.toMatch(/(?:VISIBLE|DELETED|HIDDEN|EXPIRED|LAYER|SESSION)_ID_SENTINEL|SCOPE_SENTINEL|META_SENTINEL|OTHER_SESSION_SENTINEL/u)
  })

  it('selects default CJK bigram versus explicit legacy through public service search behavior', async () => {
    const cjkProvider = new ScriptedProvider()
    const legacyProvider = new ScriptedProvider()
    const cjk = await setup({ provider: cjkProvider })
    const legacy = await setup({ provider: legacyProvider, tokenizerConfig: { kind: 'legacy' } })
    await importRecords(cjk, [record({ id: 'default-cjk-hit', content: '数据库备份演练', provider: cjkProvider })])
    await importRecords(legacy, [record({ id: 'legacy-miss', content: '数据库备份演练', provider: legacyProvider })])
    cjkProvider.implementation = async () => { throw new Error('semantic unavailable') }
    legacyProvider.implementation = async () => { throw new Error('semantic unavailable') }

    const cjkResult = await cjk.memory.search({ scope: scope('mode-cjk'), query: '数据备份' })
    const legacyResult = await legacy.memory.search({ scope: scope('mode-legacy'), query: '数据备份' })
    expect(cjkResult.channels.normal.map(hit => hit.memory.id)).toContain('default-cjk-hit')
    expect(legacyResult.channels.normal.map(hit => hit.memory.id)).not.toContain('legacy-miss')
  })

  it('short-circuits an empty and foreign-owner candidate set before both channels', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return [] } }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    await importRecords(ctx, [record({ id: 'foreign', content: 'foreign secret', owner: scope('foreign', { userId: 'other-user' }), provider })])
    provider.calls.splice(0)
    seen.splice(0)

    const result = await ctx.memory.search({ scope: scope('empty'), query: 'query' })
    expect(result.channels).toEqual({ profile: [], normal: [] })
    expect(seen).toEqual([])
    expect(provider.calls).toEqual([])
  })

  it('uses the same tokenizer for normal/profile candidates and content plus normalized tags', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return text === '' ? [] : ['shared'] } }
    const ctx = await setup({ tokenizer })
    await importRecords(ctx, [
      record({ id: 'normal', content: '普通通道内容', tags: ['NormalTag'] }),
      record({ id: 'profile', content: '画像通道内容', layer: 'l4_identity', tags: ['ProfileTag'] }),
    ])
    const result = await ctx.memory.search({ scope: scope('query-session'), query: '共享查询', limit: 10, profileLimit: 10 })

    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('normal')
    expect(result.channels.profile.map(hit => hit.memory.id)).toContain('profile')
    expect(seen.some(text => text.includes('普通通道内容') && text.includes('normaltag'))).toBe(true)
    expect(seen.some(text => text.includes('画像通道内容') && text.includes('profiletag'))).toBe(true)
  })

  it('uses the configured tokenizer for both channels when the trained semantic provider is unavailable', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return text === '' ? [] : ['shared'] } }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    await importRecords(ctx, [
      record({ id: 'provider-normal', content: '普通故障候选', provider }),
      record({ id: 'provider-profile', content: '画像故障候选', layer: 'l4_identity', provider }),
    ])
    provider.calls.splice(0)
    provider.implementation = async () => { throw new Error('semantic provider unavailable') }

    const result = await ctx.memory.search({ scope: scope('provider-failure'), query: '故障查询', limit: 10, profileLimit: 10 })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('provider-normal')
    expect(result.channels.profile.map(hit => hit.memory.id)).toContain('provider-profile')
    expect(result.channels.normal[0]?.matchedBy).toEqual(['lexical'])
    expect(result.channels.profile[0]?.matchedBy).toEqual(['lexical', 'profile'])
    expect(seen.some(text => text.includes('普通故障候选'))).toBe(true)
    expect(seen.some(text => text.includes('画像故障候选'))).toBe(true)
    expect(result.diagnostics.degradedChannels).toContain('semantic:provider-unavailable')
  })

  it('closes only lexical on tokenizer failure, preserving semantic hits with a stable redacted diagnostic', async () => {
    const secret = 'lexical-search-secret-response-body'
    const ctx = await setup({ tokenizer: throwingTokenizer(secret) })
    await importRecords(ctx, [record({ id: 'semantic-hit', content: 'Jade Lantern deployment codename' })])

    const result = await ctx.memory.search({ scope: scope('semantic-search'), query: 'Jade Lantern deployment codename' })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('semantic-hit')
    expect(result.channels.normal[0]?.matchedBy).toContain('semantic')
    expect(result.channels.normal[0]?.matchedBy).not.toContain('lexical')
    expect(result.diagnostics.degradedChannels).toContain('lexical:tokenizer-unavailable')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('closes only lexical when document tokenization fails after a valid query tokenization', async () => {
    const secret = 'document-tokenizer-secret-response'
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => {
      seen.push(text)
      if (text === '') return []
      if (text.includes('document failure target')) throw new Error(secret)
      return ['jade']
    } }
    const ctx = await setup({ tokenizer })
    await importRecords(ctx, [record({ id: 'document-semantic-hit', content: 'document failure target Jade Lantern' })])

    const result = await ctx.memory.search({ scope: scope('document-tokenization'), query: 'Jade Lantern' })
    expect(seen).toContain('Jade Lantern')
    expect(seen.some(text => text.includes('document failure target'))).toBe(true)
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('document-semantic-hit')
    expect(result.channels.normal[0]?.matchedBy).toContain('semantic')
    expect(result.channels.normal[0]?.matchedBy).not.toContain('lexical')
    expect(result.diagnostics.degradedChannels).toContain('lexical:tokenizer-unavailable')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    'array-is-array',
    'length',
    'iterator',
    'element',
    'element-length',
  ] as const)('contains hostile custom-token output at the %s access point during search', async (kind) => {
    const secret = `hostile-${kind}-tokenizer-secret`
    const tokenizer: Tokenizer = { tokenize: text => text === '' ? [] : hostileTokenOutput(kind, secret) }
    const ctx = await setup({ tokenizer })
    const searchScope = scope(`hostile-${kind}`)
    await importRecords(ctx, [record({ id: `hostile-${kind}-semantic-hit`, content: 'Jade Lantern exact semantic target', owner: searchScope })])

    const result = await ctx.memory.search({ scope: searchScope, query: 'Jade Lantern exact semantic target' })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain(`hostile-${kind}-semantic-hit`)
    expect(result.channels.normal[0]?.matchedBy).toContain('semantic')
    expect(result.channels.normal[0]?.matchedBy).not.toContain('lexical')
    expect(result.diagnostics.degradedChannels).toContain('lexical:tokenizer-unavailable')
    const visible = inspect({ result, exported: ctx.memory.export(searchScope), health: ctx.memory.health() }, {
      depth: 20,
      showHidden: true,
    })
    expect(visible).not.toContain(secret)
    expect(visible).not.toMatch(/\bcause\b/u)
  })

  it.each([
    ['empty token', ['']],
    ['oversized token', ['x'.repeat(257)]],
    ['too many tokens', Array<string>(100_001).fill('x')],
    ['non-string token', ['ok', 42]],
  ])('maps runtime query %s output to a fixed redacted lexical diagnostic', async (_label, output) => {
    const tokenizer: Tokenizer = { tokenize: text => text === '' ? [] : output as unknown as string[] }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    await importRecords(ctx, [record({ id: 'invalid-output-record', content: 'runtime output target', provider })])
    provider.implementation = async () => { throw new Error('semantic secret') }

    const result = await ctx.memory.search({ scope: scope('runtime-output'), query: 'sensitive query' })
    expect(result.channels).toEqual({ profile: [], normal: [] })
    expect(result.diagnostics.degradedChannels).toEqual(expect.arrayContaining([
      'lexical:tokenizer-unavailable',
      'semantic:provider-unavailable',
    ]))
    expect(JSON.stringify(result)).not.toMatch(/sensitive query|semantic secret/u)

    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: 'runtime output candidate', layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)
    const receipt = await ctx.memory.add({
      scope: scope('runtime-output'),
      content: 'runtime output capture',
      mode: 'extract',
      idempotencyKey: `invalid-output-${_label}`,
    })
    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [], warnings: ['lexical tokenizer failed'] })
    expect(ctx.memory.get(receipt.rawMemoryId, scope('runtime-output'))).toMatchObject({
      layer: 'l1_raw',
      status: 'active',
      visibility: 'recallable',
    })
  })

  it.each([
    ['256 UTF-16 code units', ['x'.repeat(256)]],
    ['100000 tokens', Array<string>(100_000).fill('x')],
  ])('accepts the exact custom tokenizer $label boundary through lexical-only search', async (_label, output) => {
    const tokenizer: Tokenizer = { tokenize: text => text === '' ? [] : output }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    await importRecords(ctx, [record({ id: 'boundary-hit', content: 'boundary document', provider })])
    provider.implementation = async () => { throw new Error('semantic unavailable') }

    const result = await ctx.memory.search({ scope: scope('boundary'), query: 'boundary query' })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('boundary-hit')
    expect(result.channels.normal[0]?.matchedBy).toEqual(['lexical'])
  })

  it('copies each custom tokenizer array immediately before later calls can mutate it', async () => {
    const shared = ['stable-token']
    let nonEmptyCalls = 0
    const tokenizer: Tokenizer = { tokenize: text => {
      if (text === '') return []
      nonEmptyCalls += 1
      if (nonEmptyCalls === 1) return shared
      shared[0] = 'mutated-after-query'
      return ['stable-token']
    } }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    await importRecords(ctx, [record({ id: 'copied-array-hit', content: 'copy target', provider })])
    provider.implementation = async () => { throw new Error('semantic unavailable') }

    const result = await ctx.memory.search({ scope: scope('copy-array'), query: 'copy query' })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain('copied-array-hit')
  })

  it('returns empty channels and both diagnostics when tokenizer and semantic provider fail', async () => {
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer: throwingTokenizer(), provider })
    await importRecords(ctx, [record({ id: 'double-failure', content: 'Jade Lantern', provider })])
    provider.implementation = async () => { throw new Error('provider-secret-body') }

    const result = await ctx.memory.search({ scope: scope('double-failure'), query: 'Jade Lantern' })
    expect(result.channels).toEqual({ profile: [], normal: [] })
    expect(result.diagnostics.degradedChannels).toEqual(expect.arrayContaining([
      'lexical:tokenizer-unavailable',
      'semantic:provider-unavailable',
    ]))
    expect(JSON.stringify(result)).not.toMatch(/tokenizer-secret|provider-secret/u)
  })

  it('keeps a nonblank punctuation-only query valid and returns no lexical results', async () => {
    const ctx = await setup({ tokenizerConfig: { kind: 'cjk-bigram' } })
    await importRecords(ctx, [record({ id: 'punctuation-record', content: '数据库备份' })])
    const result = await ctx.memory.search({ scope: scope('punctuation'), query: '，。_😀' })
    expect(result.channels).toEqual({ profile: [], normal: [] })
  })
})

describe('MEM-102 degraded raw and reconciliation channel policy', () => {
  it('recalls a trained degraded zero-placeholder raw through the configured tokenizer', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return text === '' ? [] : ['紫藤门'] } }
    const provider = new ScriptedProvider()
    provider.implementation = async () => { throw new Error('embedding unavailable') }
    const ctx = await setup({ tokenizer, provider })
    const receipt = await ctx.memory.add({ scope: scope('degraded'), content: '紧急集合点是紫藤门', idempotencyKey: 'degraded' })
    expect(receipt.status).toBe('degraded')
    seen.splice(0)

    const result = await ctx.memory.search({ scope: scope('degraded'), query: '集合点紫藤门' })
    expect(result.channels.normal.map(hit => hit.memory.id)).toContain(receipt.rawMemoryId)
    expect(seen.some(text => text.includes('紧急集合点是紫藤门'))).toBe(true)
  })

  it('uses semantic reconciliation candidates when tokenizer fails', async () => {
    const attempted: string[] = []
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer: { tokenize: text => {
      if (text === '') return []
      attempted.push(text)
      throw new Error('semantic fallback tokenizer failure')
    } }, provider })
    await ctx.memory.add({ scope: scope('reconcile-semantic'), content: '发布窗口是十月', idempotencyKey: 'seed' })
    const candidate = ctx.memory.list({ scope: scope('reconcile-semantic'), layers: ['l2_fact'] })[0]
    if (candidate === undefined) throw new Error('missing reconciliation seed')
    expect(hashEmbedding('十月仍是发布窗口').some(value => value !== 0)).toBe(true)
    expect(candidate.embedding.vector.some(value => value !== 0)).toBe(true)
    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: '十月仍是发布窗口', layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
      JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'f1', duplicateOf: candidate.id }] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)

    const receipt = await ctx.memory.add({ scope: scope('reconcile-semantic'), content: '用户确认十月仍是发布窗口', mode: 'extract', idempotencyKey: 'extract' })
    expect(receipt.status).toBe('completed')
    expect(adapter.responses).toEqual([])
    expect(JSON.stringify(adapter.calls[1])).toContain(candidate.id)
    expect(attempted).toContain('十月仍是发布窗口')
  })

  it.each([
    {
      label: 'zero query with a nonzero candidate',
      slug: 'zero-query',
      extractedContent: '😀',
      candidateContent: 'existing nonzero candidate',
      queryNonzero: false,
      candidateNonzero: true,
    },
    {
      label: 'nonzero query with only a zero candidate',
      slug: 'zero-candidate',
      extractedContent: 'updated nonzero candidate',
      candidateContent: '😀',
      queryNonzero: true,
      candidateNonzero: false,
    },
  ])('degrades without a second LLM call for $label when lexical fails', async ({
    slug,
    extractedContent,
    candidateContent,
    queryNonzero,
    candidateNonzero,
  }) => {
    const ctx = await setup({ tokenizer: throwingTokenizer(`zero-signal-${slug}-tokenizer-secret`) })
    const reconcileScope = scope(`reconcile-${slug}`)
    const candidate = record({ id: `${slug}-candidate`, content: candidateContent, owner: reconcileScope })
    expect(hashEmbedding(extractedContent).some(value => value !== 0)).toBe(queryNonzero)
    expect(candidate.embedding.vector.some(value => value !== 0)).toBe(candidateNonzero)
    await importRecords(ctx, [candidate])
    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: extractedContent, layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)

    const receipt = await ctx.memory.add({
      scope: reconcileScope,
      content: `evidence for ${slug}`,
      mode: 'extract',
      idempotencyKey: `${slug}-extract`,
    })
    expect(receipt).toMatchObject({
      status: 'degraded',
      createdMemoryIds: [],
      warnings: ['lexical tokenizer failed'],
    })
    expect(adapter.calls).toHaveLength(1)
    expect(ctx.memory.get(receipt.rawMemoryId, reconcileScope)).toMatchObject({
      layer: 'l1_raw',
      status: 'active',
      visibility: 'recallable',
    })
    expect(ctx.memory.list({ scope: reconcileScope, layers: ['l2_fact'] }).map(item => item.id)).toEqual([candidate.id])
  })

  it('uses configured lexical reconciliation candidates when only semantic query embedding fails', async () => {
    const seen: string[] = []
    const tokenizer: Tokenizer = { tokenize: text => { seen.push(text); return text === '' ? [] : ['十月'] } }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    await ctx.memory.add({ scope: scope('reconcile-lexical'), content: '发布窗口是十月', idempotencyKey: 'seed' })
    const candidate = ctx.memory.list({ scope: scope('reconcile-lexical'), layers: ['l2_fact'] })[0]
    if (candidate === undefined) throw new Error('missing lexical reconciliation seed')
    const extractedContent = '十月仍是发布窗口'
    provider.implementation = async texts => {
      if (texts.length === 1 && texts[0] === extractedContent) throw new Error('reconcile semantic unavailable')
      return texts.map(() => [1, 0, 0])
    }
    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: extractedContent, layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
      JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'f1', duplicateOf: candidate.id }] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)

    const receipt = await ctx.memory.add({ scope: scope('reconcile-lexical'), content: '用户确认十月仍是发布窗口', mode: 'extract', idempotencyKey: 'extract' })
    expect(receipt.status).toBe('completed')
    expect(adapter.responses).toEqual([])
    expect(JSON.stringify(adapter.calls[1])).toContain(candidate.id)
    expect(seen).toContain(extractedContent)
    expect(seen.some(text => text.includes(candidate.content))).toBe(true)
  })

  it('degrades accepted extraction when reconciliation tokenizer and semantic channels both fail', async () => {
    const secret = 'reconcile-tokenizer-secret-body'
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer: throwingTokenizer(secret), provider })
    await ctx.memory.add({ scope: scope('reconcile-double'), content: '发布窗口是十月', idempotencyKey: 'seed' })
    provider.implementation = async () => { throw new Error('reconcile-provider-secret-body') }
    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: '十月仍是发布窗口', layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)

    const receipt = await ctx.memory.add({ scope: scope('reconcile-double'), content: '用户确认十月仍是发布窗口', mode: 'extract', idempotencyKey: 'extract' })
    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [], warnings: ['lexical tokenizer failed'] })
    expect(adapter.calls).toHaveLength(1)
    expect(ctx.memory.get(receipt.rawMemoryId, scope('reconcile-double'))).toMatchObject({ layer: 'l1_raw', status: 'active', visibility: 'recallable' })
    expect(JSON.stringify(receipt)).not.toMatch(/secret-body/u)
  })

  it('persists only a fixed tokenizer warning when a hostile output throws during reconciliation validation', async () => {
    const secret = 'reconcile-hostile-length-proxy-secret'
    const tokenizer: Tokenizer = {
      tokenize: text => text === '' ? [] : hostileTokenOutput('length', secret),
    }
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer, provider })
    const reconcileScope = scope('reconcile-hostile-output')
    await importRecords(ctx, [record({ id: 'hostile-reconcile-candidate', content: 'existing candidate', owner: reconcileScope, provider })])
    provider.implementation = async () => { throw new Error('semantic-reconcile-secret') }
    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: 'updated candidate', layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)
    const input = {
      scope: reconcileScope,
      content: 'updated candidate evidence',
      mode: 'extract' as const,
      idempotencyKey: 'hostile-reconcile-extract',
    }

    const receipt = await ctx.memory.add(input)
    const durable = await ctx.memory.add(input)
    expect(receipt).toMatchObject({ status: 'degraded', createdMemoryIds: [], warnings: ['lexical tokenizer failed'] })
    expect(durable).toEqual(receipt)
    expect(adapter.calls).toHaveLength(1)
    expect(ctx.memory.get(receipt.rawMemoryId, reconcileScope)).toMatchObject({
      layer: 'l1_raw',
      status: 'active',
      visibility: 'recallable',
    })
    const visible = inspect({ receipt, durable, exported: ctx.memory.export(reconcileScope), health: ctx.memory.health() }, {
      depth: 20,
      showHidden: true,
    })
    expect(visible).not.toMatch(/reconcile-hostile-length-proxy-secret|semantic-reconcile-secret|\bcause\b/u)
  })

  it('propagates caller abort unchanged even when lexical tokenization is unavailable', async () => {
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer: throwingTokenizer(), provider })
    await importRecords(ctx, [record({ id: 'abort-record', content: 'Jade Lantern', provider })])
    provider.implementation = async (_texts, signal) => await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const controller = new AbortController()
    const pending = ctx.memory.search({ scope: scope('abort'), query: 'Jade Lantern' }, controller.signal)
    const reason = new Error('caller abort sentinel')
    controller.abort(reason)

    let failure: unknown
    try { await pending } catch (error) { failure = error }
    expect(failure).toBe(reason)
    expect(failure).not.toBeInstanceOf(MemoryError)
  })

  it('propagates caller abort unchanged from reconciliation instead of converting it to tokenizer degradation', async () => {
    const provider = new ScriptedProvider()
    const ctx = await setup({ tokenizer: throwingTokenizer(), provider })
    await ctx.memory.add({ scope: scope('reconcile-abort'), content: '发布窗口是十月', idempotencyKey: 'seed' })
    const extractedContent = '十月仍是发布窗口'
    let embeddingStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { embeddingStarted = resolve })
    provider.implementation = async (texts, signal) => {
      if (texts.length === 1 && texts[0] === extractedContent) {
        embeddingStarted?.()
        return await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      return texts.map(() => [1, 0, 0])
    }
    const adapter = new JsonAdapter([
      JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f1', content: extractedContent, layer: 'l2_fact', tags: [], confidence: 0.9, evidenceTurnIndexes: [1] }], identities: [] }),
    ])
    ctx.llm.registerAdapter(['lexical-test-llm'], adapter)
    const controller = new AbortController()
    const pending = ctx.memory.add({ scope: scope('reconcile-abort'), content: '用户确认十月仍是发布窗口', mode: 'extract', idempotencyKey: 'extract' }, controller.signal)
    await started
    const reason = new Error('reconciliation caller abort sentinel')
    controller.abort(reason)

    let failure: unknown
    try { await pending } catch (error) { failure = error }
    expect(failure).toBe(reason)
    expect(adapter.calls).toHaveLength(1)
    const raw = ctx.memory.list({ scope: scope('reconcile-abort'), layers: ['l1_raw'] })
      .find(item => item.content === '用户确认十月仍是发布窗口')
    expect(raw).toMatchObject({ layer: 'l1_raw', status: 'active', visibility: 'recallable' })
    const durable = await ctx.memory.add({
      scope: scope('reconcile-abort'),
      content: '用户确认十月仍是发布窗口',
      mode: 'extract',
      idempotencyKey: 'extract',
    })
    expect(durable).toMatchObject({
      rawMemoryId: raw?.id,
      status: 'degraded',
      createdMemoryIds: [],
    })
    expect(durable.warnings).toHaveLength(1)
    expect(adapter.calls).toHaveLength(1)
  })
})
