import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import * as memory from '../src/index.ts'
import type { Config as MemoryConfig } from '../src/index.ts'

interface Tokenizer {
  tokenize(text: string): readonly string[]
}

type TokenizerConstructor = new () => Tokenizer

const LEGACY_PATTERN = /[a-zA-Z0-9]+|[\u3400-\u9fff]+/gu
const DIMENSIONS = 256
const SPACE_ID = 'dsh-memory/hash-token-char-v1/256/l2'
const workspace = fileURLToPath(new URL('..', import.meta.url))

function legacyOracleTokens(text: string): string[] {
  return Array.from(text.matchAll(LEGACY_PATTERN), match => match[0].toLowerCase())
}

function legacyHashOracle(text: string): number[] {
  const vector = Array<number>(DIMENSIONS).fill(0)
  const features: string[] = []
  for (const token of legacyOracleTokens(text)) {
    features.push(`t:${token}`)
    const points = Array.from(token)
    for (let index = 0; index + 1 < points.length; index += 1) {
      features.push(`b:${points[index]}${points[index + 1]}`)
    }
  }
  for (const feature of features) {
    let hash = 2166136261
    for (const point of feature) {
      hash ^= point.codePointAt(0) ?? 0
      hash = Math.imul(hash, 16777619)
    }
    const unsigned = hash >>> 0
    const index = unsigned % DIMENSIONS
    vector[index] = (vector[index] ?? 0) + ((unsigned & 1) === 0 ? 1 : -1)
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map(value => value / norm)
}

function cjkTokenizer(): Tokenizer {
  const Constructor = (memory as unknown as { CjkBigramTokenizer?: TokenizerConstructor }).CjkBigramTokenizer
  expect(Constructor, 'CjkBigramTokenizer public export').toBeTypeOf('function')
  if (Constructor === undefined) throw new Error('CjkBigramTokenizer is not implemented')
  return new Constructor()
}

function baseConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    provider: 'tokenizer-test-provider',
    model: 'tokenizer-test-model',
    userId: 'tokenizer-test-user',
    autoCapture: false,
    autoRecall: false,
    ...overrides,
  }
}

describe('MEM-102 default CJK bigram tokenizer', () => {
  it.each([
    ['数据库备份演练', ['数据', '据库', '库备', '备份', '份演', '演练']],
    ['API接口v2.0，ZED编辑器', ['api', '接口', 'v2', '0', 'zed', '编辑', '辑器']],
    ['数', ['数']],
    ['甲乙，丙丁', ['甲乙', '丙丁']],
    ['ABC-def_123', ['abc', 'def', '123']],
  ])('tokenizes %s by the frozen source-order rules', (input, expected) => {
    const tokenizer = cjkTokenizer()
    expect(tokenizer.tokenize(input)).toEqual(expected)
    expect(memory.tokenize(input)).toEqual(expected)
  })

  it('treats punctuation, whitespace, emoji, underscore, full-width Latin, and supplementary Han as delimiters', () => {
    expect(cjkTokenizer().tokenize('甲😀乙 _ ＡＢＣ 𠀀 丙丁')).toEqual(['甲', '乙', '丙丁'])
  })

  it('preserves duplicate tokens and returns no tokens for blank or punctuation-only input', () => {
    const tokenizer = cjkTokenizer()
    expect(tokenizer.tokenize('甲乙，甲乙 API api')).toEqual(['甲乙', '甲乙', 'api', 'api'])
    expect(tokenizer.tokenize('')).toEqual([])
    expect(tokenizer.tokenize(' \n，。_😀')).toEqual([])
  })
})

describe('MEM-102 portable-hash isolation', () => {
  it.each([
    '',
    '数据库备份演练',
    'API接口v2.0，ZED编辑器',
    'ABC-def_123',
    '甲乙，丙丁',
    'How should 林岚 review backup-plan_v2?',
  ])('keeps the pre-MEM-102 regex/FNV vector byte-exact for %j', (input) => {
    expect(memory.hashEmbedding(input)).toEqual(legacyHashOracle(input))
  })

  it('matches the independent oracle for fixed Golden corpus samples without using another production tokenizer', async () => {
    const dataset = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(
      new URL('../evaluation/golden/v1/retrieval.json', import.meta.url),
      'utf8',
    ))) as { corpora: Array<{ records: Array<{ content: string }> }> }
    const samples = dataset.corpora.flatMap(corpus => corpus.records).slice(0, 12)
    for (const sample of samples) expect(memory.hashEmbedding(sample.content)).toEqual(legacyHashOracle(sample.content))
  })

  it('freezes the literal portable hash descriptor and independent batch output order', async () => {
    expect(memory.HASH_EMBEDDING_SPACE_ID).toBe(SPACE_ID)
    expect(memory.HASH_EMBEDDING_DIMENSIONS).toBe(DIMENSIONS)
    const provider = new memory.HashEmbeddingProvider()
    expect(provider.describe()).toEqual({
      spaceId: SPACE_ID,
      dimensions: DIMENSIONS,
      maxBatchSize: 256,
      normalization: 'l2',
      quality: 'portable-hash',
    })
    const texts = ['数据库备份演练', '', 'API接口v2.0，ZED编辑器', 'ABC-def_123']
    expect(await provider.embedBatch(texts)).toEqual(texts.map(legacyHashOracle))
  })
})

describe('MEM-102 tokenizer configuration and validation', () => {
  it('exports the public tokenizer types and TOKENIZATION_FAILED code from the root TypeScript entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-tokenizer-types-'))
    const sourcePath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const fixture = join(root, 'public-types.ts')
    try {
      await writeFile(fixture, [
        `import MemoryService, { CjkBigramTokenizer, MemoryError, type Config, type LexicalTokenizer, type TokenizerConfig, type MemoryErrorCode } from ${JSON.stringify(sourcePath)}`,
        'const tokenizer: LexicalTokenizer = new CjkBigramTokenizer()',
        "const tokenizerConfig: TokenizerConfig = { kind: 'legacy' }",
        "const programmaticConfig: Config = { provider: 'provider', model: 'model', lexicalTokenizer: tokenizer }",
        "const loaderConfig: Config = { provider: 'provider', model: 'model', tokenizer: tokenizerConfig }",
        "const code: MemoryErrorCode = 'TOKENIZATION_FAILED'",
        "const error = new MemoryError(code, 'lexical tokenizer failed')",
        'void [MemoryService, programmaticConfig, loaderConfig, error]',
      ].join('\n'), 'utf8')
      const result = spawnSync('pnpm', [
        'exec', 'tsc', '--ignoreConfig', '--noEmit', '--allowImportingTsExtensions', '--module', 'nodenext',
        '--moduleResolution', 'nodenext', '--target', 'es2023', '--lib', 'es2023,dom',
        '--types', 'node', '--strict', '--skipLibCheck', fixture,
      ], { cwd: workspace, encoding: 'utf8' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('exposes a hidden programmatic tokenizer and a non-materializing two-member loader union in Schemastery', () => {
    const schema = memory.Config as unknown as {
      dict?: Record<string, { readonly type?: string; readonly meta?: Record<string, unknown>; readonly list?: readonly { readonly dict?: Record<string, { readonly value?: unknown }> }[] }>
    }
    const lexical = schema.dict?.lexicalTokenizer
    const loader = schema.dict?.tokenizer
    expect(lexical?.meta?.hidden).toBe(true)
    expect(loader?.type).toBe('union')
    expect(loader?.meta?.default).toBeUndefined()
    expect(loader?.list?.map(item => item.dict?.kind?.value)).toEqual(['cjk-bigram', 'legacy'])
    expect((memory.Config(baseConfig()) as unknown as { tokenizer?: unknown }).tokenizer).toBeUndefined()
    expect(memory.resolveConfig(baseConfig()).tokenizer).toEqual({ kind: 'cjk-bigram' })
    expect((memory.Config(baseConfig({ tokenizer: { kind: 'legacy' } } as Partial<MemoryConfig>)) as unknown as { tokenizer?: unknown }).tokenizer).toEqual({ kind: 'legacy' })
    expect(() => memory.Config(baseConfig({ tokenizer: { kind: 'other' } } as Partial<MemoryConfig>))).toThrow()
  })

  it('accepts a trusted custom tokenizer but rejects combining it with loader tokenizer config', () => {
    const custom: Tokenizer = { tokenize: () => [] }
    expect(() => memory.resolveConfig(baseConfig({ lexicalTokenizer: custom } as Partial<MemoryConfig>))).not.toThrow()
    for (const kind of ['legacy', 'cjk-bigram'] as const) {
      expect(() => memory.resolveConfig(baseConfig({
        lexicalTokenizer: custom,
        tokenizer: { kind },
      } as Partial<MemoryConfig>)), kind).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
    }
  })

  it.each([
    ['null', null],
    ['missing callable', {}],
  ])('maps structurally invalid custom tokenizer %s to INVALID_INPUT', (_label, lexicalTokenizer) => {
    let failure: unknown
    try {
      memory.resolveConfig(baseConfig({ lexicalTokenizer } as Partial<MemoryConfig>))
    } catch (error) {
      failure = error
    }
    expect(failure).toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }))
  })

  it.each([
    ['preflight throw', { tokenize: () => { throw new Error('preflight-secret') } }],
    ['non-empty preflight', { tokenize: () => ['secret-preflight-output'] }],
    ['non-array preflight', { tokenize: () => new Set<string>() }],
  ])('maps %s to fixed redacted TOKENIZATION_FAILED semantics', (_label, lexicalTokenizer) => {
    let failure: unknown
    try {
      memory.resolveConfig(baseConfig({ lexicalTokenizer } as Partial<MemoryConfig>))
    } catch (error) {
      failure = error
    }
    expect(failure).toEqual(expect.objectContaining({
      code: 'TOKENIZATION_FAILED',
      message: 'lexical tokenizer failed',
    }))
    expect(inspect(failure, { depth: 10, showHidden: true })).not.toMatch(/preflight-secret|secret-preflight-output/u)
  })

  it('redacts deep causes and non-enumerable tokenizer secrets from preflight failures', () => {
    const secret = 'deep-non-enumerable-tokenizer-secret'
    const nested = new Error(secret)
    Object.defineProperty(nested, 'privatePayload', { value: { secret }, enumerable: false })
    const upstream = new Error('outer-tokenizer-failure', { cause: nested })
    Object.defineProperty(upstream, 'hiddenResponse', { value: nested, enumerable: false })
    let failure: unknown
    try {
      memory.resolveConfig(baseConfig({ lexicalTokenizer: { tokenize: () => { throw upstream } } } as Partial<MemoryConfig>))
    } catch (error) {
      failure = error
    }
    expect(failure).toEqual(expect.objectContaining({ code: 'TOKENIZATION_FAILED', message: 'lexical tokenizer failed' }))
    expect(inspect(failure, { depth: 20, showHidden: true })).not.toContain(secret)
    expect((failure as { cause?: unknown }).cause).toBeUndefined()
  })

  it('redacts a throwing tokenize getter before callable preflight inspection', () => {
    const secret = 'throwing-tokenize-getter-deep-secret'
    const nested = new Error(secret)
    Object.defineProperty(nested, 'hiddenPayload', { value: { secret }, enumerable: false })
    const tokenizer = Object.defineProperty({}, 'tokenize', {
      enumerable: false,
      get: () => { throw new Error('getter-wrapper-secret', { cause: nested }) },
    })
    let failure: unknown
    try {
      memory.resolveConfig(baseConfig({ lexicalTokenizer: tokenizer } as Partial<MemoryConfig>))
    } catch (error) {
      failure = error
    }
    expect(failure).toEqual(expect.objectContaining({
      code: 'TOKENIZATION_FAILED',
      message: 'lexical tokenizer failed',
    }))
    expect((failure as { cause?: unknown }).cause).toBeUndefined()
    expect(inspect(failure, { depth: 20, showHidden: true })).not.toMatch(/getter-wrapper-secret|throwing-tokenize-getter-deep-secret/u)
  })

  it('supports the backward-compatible bm25 tokenizer argument for query and documents', () => {
    const tokenizer = cjkTokenizer()
    const scores = memory.bm25(tokenizer.tokenize('数据备份'), ['每周执行数据库备份演练', '会议纪要'], 1.5, 0.75, tokenizer)
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBe(0)
  })
})
