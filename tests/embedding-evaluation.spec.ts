import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MemoryService, {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
  hashEmbedding,
} from '../src/index.ts'
import type { MemoryId, MemoryRecord, MemoryScope } from '../src/types.ts'

type Language = 'zh' | 'en'
type Bucket = 'synonym' | 'exact'
type Split = 'baseline' | 'holdout'

interface OwnerFixture {
  readonly tenantId: string
  readonly userId: string
  readonly agentId: string
}

interface RecordFixture {
  readonly id: string
  readonly language: Language
  readonly owner: OwnerFixture
  readonly sourceSessionId: string
  readonly content: string
  readonly tags: readonly string[]
  readonly status: 'active' | 'deleted'
  readonly visibility: 'recallable' | 'source_only'
  readonly createdAt: string
}

interface QueryFixture {
  readonly id: string
  readonly language: Language
  readonly bucket: Bucket
  readonly split: Split
  readonly owner: OwnerFixture
  readonly sessionId: string
  readonly query: string
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
}

interface EmbeddingDataset {
  readonly schemaVersion: 1
  readonly datasetId: 'dsh-memory-embedding'
  readonly datasetVersion: '1.0.0'
  readonly referenceCommit: string
  readonly evaluationTime: string
  readonly records: readonly RecordFixture[]
  readonly queries: readonly QueryFixture[]
}

interface RetrievalMetric {
  readonly recallAt5: number
  readonly recallAt10: number
  readonly mrrAt10: number
}

interface EmbeddingReport {
  readonly schemaVersion: 1
  readonly dataset: { readonly id: string; readonly version: string; readonly referenceCommit: string }
  readonly runner: {
    readonly version: 1
    readonly repeats: number
    readonly mode: 'offline-hash' | 'live'
    readonly externalNetwork: boolean
  }
  readonly provider: {
    readonly quality: 'portable-hash' | 'trained'
    readonly model: string | null
    readonly spaceId: string
    readonly dimensions: number
    readonly normalization: 'l2'
  }
  readonly metrics: { readonly synonym: RetrievalMetric; readonly exact: RetrievalMetric }
  readonly buckets: readonly (RetrievalMetric & {
    readonly bucket: Bucket
    readonly language: Language
    readonly queryCount: number
  })[]
  readonly cases: readonly {
    readonly id: string
    readonly language: Language
    readonly bucket: Bucket
    readonly split: Split
    readonly relevantIds: readonly string[]
    readonly forbiddenIds: readonly string[]
    readonly returnedIds: readonly string[]
    readonly firstRelevantRank: number | null
    readonly recallAt5: number
    readonly recallAt10: number
    readonly reciprocalRank: number
    readonly forbiddenHits: readonly string[]
  }[]
  readonly hardChecks: {
    readonly scopeLeaks: number
    readonly forbiddenHits: number
    readonly duplicateResultIds: number
  }
}

interface EmbeddingGates {
  readonly schemaVersion: 1
  readonly dataset: EmbeddingReport['dataset']
  readonly offline: { readonly metrics: EmbeddingReport['metrics'] }
  readonly live: {
    readonly relativeSynonymRecallAt10Floor: number
    readonly exactRecallAt10Floor: number
  }
  readonly hardChecks: EmbeddingReport['hardChecks']
}

interface EmbeddingMetricsModule {
  validateEmbeddingDataset(value: unknown): void
  validateEmbeddingReport(value: unknown): void
  canonicalJson(value: unknown): string
  evaluateEmbeddingGates(
    baseline: EmbeddingReport,
    live: EmbeddingReport,
    gates: EmbeddingGates,
  ): { readonly passed: boolean; readonly relativeSynonymRecallAt10: number; readonly failures: readonly string[] }
  computeEmbeddingMetrics(cases: readonly {
    readonly id: string
    readonly language: Language
    readonly bucket: Bucket
    readonly split: Split
    readonly relevantIds: readonly string[]
    readonly forbiddenIds: readonly string[]
    readonly returnedIds: readonly string[]
    readonly scopeLeaks: number
  }[]): Pick<EmbeddingReport, 'metrics' | 'buckets' | 'cases' | 'hardChecks'>
}

interface EmbeddingRunnerModule {
  runEmbedding(options: {
    readonly datasetPath: string
    readonly repeats: number
    readonly mode: 'offline-hash'
  }): Promise<EmbeddingReport>
}

interface BuiltMemoryPrototype {
  import(scope: MemoryScope, records: readonly MemoryRecord[]): Promise<number>
  search(input: { readonly scope: MemoryScope; readonly query: string }): Promise<unknown>
  add(input: unknown, signal?: AbortSignal): Promise<unknown>
}

interface BuiltMemoryModule {
  readonly default: { readonly prototype: BuiltMemoryPrototype }
}

const workspace = fileURLToPath(new URL('..', import.meta.url))
const datasetPath = fileURLToPath(new URL('../evaluation/embedding/v1/cases.json', import.meta.url))
const datasetSchemaPath = fileURLToPath(new URL('../evaluation/embedding/v1/dataset.schema.json', import.meta.url))
const reportSchemaPath = fileURLToPath(new URL('../evaluation/embedding/report.schema.json', import.meta.url))
const baselinePath = fileURLToPath(new URL('../evaluation/embedding/v1/baseline.hash-v1.json', import.meta.url))
const gatesPath = fileURLToPath(new URL('../evaluation/embedding/v1/gates.json', import.meta.url))
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const metricsUrl = new URL('../evaluation/embedding-metrics.mjs', import.meta.url)
const runnerUrl = new URL('../evaluation/run-embedding.mjs', import.meta.url)
const runnerPath = fileURLToPath(runnerUrl)
const builtMemoryUrl = new URL('../lib/index.js', import.meta.url)
const contexts: Context[] = []
const roots: string[] = []

async function readDataset(): Promise<EmbeddingDataset> {
  return JSON.parse(await readFile(datasetPath, 'utf8')) as EmbeddingDataset
}

async function loadMetrics(): Promise<EmbeddingMetricsModule> {
  return await import(/* @vite-ignore */ metricsUrl.href) as EmbeddingMetricsModule
}

async function loadRunner(): Promise<EmbeddingRunnerModule> {
  return await import(/* @vite-ignore */ runnerUrl.href) as EmbeddingRunnerModule
}

async function loadBuiltMemory(): Promise<BuiltMemoryModule> {
  return await import(builtMemoryUrl.href) as BuiltMemoryModule
}

function ownerKey(owner: OwnerFixture): string {
  return JSON.stringify([owner.tenantId, owner.userId, owner.agentId])
}

function scope(owner: OwnerFixture, sessionId: string): MemoryScope {
  return { ...owner, sessionId }
}

function materializeRecord(record: RecordFixture): MemoryRecord {
  return {
    schemaVersion: 1,
    id: record.id as MemoryId,
    scope: scope(record.owner, record.sourceSessionId),
    layer: 'l2_fact',
    content: record.content,
    status: record.status,
    visibility: record.visibility,
    sourceType: 'explicit',
    confidence: 1,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    revision: 1,
    supersedes: [],
    supersededBy: [],
    consolidates: [],
    sourceMemoryIds: [],
    sourceSessionId: record.sourceSessionId,
    sourceTurnIndexes: [],
    tags: record.tags,
    meta: {},
    embedding: {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: hashEmbedding(record.content),
    },
  }
}

async function setupHashMemory(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-fixture-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, {
    provider: 'missing-evaluation-provider',
    model: 'missing-evaluation-model',
    userId: 'unused-evaluation-user',
    autoCapture: false,
    autoRecall: false,
  })
  return ctx
}

function assertDatasetFixture(dataset: EmbeddingDataset): void {
  expect(dataset).toMatchObject({
    schemaVersion: 1,
    datasetId: 'dsh-memory-embedding',
    datasetVersion: '1.0.0',
    referenceCommit: 'cf9234c4038289f966deef1303edb8a03635da97',
    evaluationTime: '2026-08-23T00:00:00.000Z',
  })
  expect(new Set(dataset.records.map(record => record.id)).size).toBe(dataset.records.length)
  expect(new Set(dataset.queries.map(query => query.id)).size).toBe(dataset.queries.length)
  expect(dataset.records.filter(record => record.id.startsWith('emb-noise-')).length).toBeGreaterThanOrEqual(6)
  expect(dataset.records.every(record => record.tags.length === 0)).toBe(true)

  const records = new Map(dataset.records.map(record => [record.id, record]))
  for (const query of dataset.queries) {
    expect(query.query).not.toContain(query.id)
    expect(query.relevantIds.length, query.id).toBeGreaterThan(0)
    for (const id of [...query.relevantIds, ...query.forbiddenIds]) {
      expect(records.has(id), `${query.id} -> ${id}`).toBe(true)
    }
    for (const id of query.relevantIds) {
      expect(records.get(id)?.language, `${query.id} language`).toBe(query.language)
      expect(ownerKey(records.get(id)?.owner as OwnerFixture), `${query.id} owner`).toBe(ownerKey(query.owner))
    }
  }

  for (const bucket of ['synonym', 'exact'] as const) {
    const zh = dataset.queries.filter(query => query.bucket === bucket && query.language === 'zh')
    const en = dataset.queries.filter(query => query.bucket === bucket && query.language === 'en')
    expect(zh.length, `${bucket}/zh`).toBe(en.length)
    expect(zh.length, `${bucket}/zh`).toBeGreaterThanOrEqual(bucket === 'synonym' ? 10 : 3)
    for (const cell of [zh, en]) {
      expect(new Set(cell.map(query => query.split))).toEqual(new Set(['baseline', 'holdout']))
    }
  }
}

function round(value: number): number {
  return Number(value.toFixed(6))
}

function independentMetric(cases: readonly EmbeddingReport['cases'][number][]): RetrievalMetric {
  return {
    recallAt5: round(cases.reduce((sum, item) => sum + item.recallAt5, 0) / cases.length),
    recallAt10: round(cases.reduce((sum, item) => sum + item.recallAt10, 0) / cases.length),
    mrrAt10: round(cases.reduce((sum, item) => sum + item.reciprocalRank, 0) / cases.length),
  }
}

async function independentHashEvaluation(
  dataset: EmbeddingDataset,
): Promise<Pick<EmbeddingReport, 'metrics' | 'buckets' | 'cases' | 'hardChecks'>> {
  const ctx = await setupHashMemory()
  const groups = new Map<string, RecordFixture[]>()
  for (const record of dataset.records) {
    const key = ownerKey(record.owner)
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  for (const records of groups.values()) {
    const first = records[0]
    if (first === undefined) continue
    await ctx.memory.import(scope(first.owner, first.sourceSessionId), records.map(materializeRecord))
  }

  const recordsById = new Map(dataset.records.map(record => [record.id, record]))
  const cases: EmbeddingReport['cases'][number][] = []
  let scopeLeaks = 0
  let forbiddenHits = 0
  let duplicateResultIds = 0
  for (const query of dataset.queries) {
    const result = await ctx.memory.search({
      scope: scope(query.owner, query.sessionId),
      query: query.query,
      limit: 10,
      profileLimit: 0,
    })
    const hits = [...result.channels.normal, ...result.channels.profile]
    const returnedIds = result.channels.normal.map(hit => hit.memory.id)
    duplicateResultIds += returnedIds.length - new Set(returnedIds).size
    for (const hit of hits) {
      const fixture = recordsById.get(hit.memory.id)
      if (fixture === undefined
        || ownerKey(fixture.owner) !== ownerKey(query.owner)
        || hit.memory.status !== 'active'
        || hit.memory.visibility !== 'recallable') scopeLeaks += 1
    }
    const relevant = new Set(query.relevantIds)
    const ranks = returnedIds.map((id, index) => relevant.has(id) ? index + 1 : null).filter((rank): rank is number => rank !== null)
    const first = ranks[0] ?? null
    const caseForbiddenHits = [...new Set(returnedIds.filter(id => query.forbiddenIds.includes(id)))]
    forbiddenHits += caseForbiddenHits.length
    cases.push({
      id: query.id,
      language: query.language,
      bucket: query.bucket,
      split: query.split,
      relevantIds: query.relevantIds,
      forbiddenIds: query.forbiddenIds,
      returnedIds,
      firstRelevantRank: first,
      recallAt5: round(query.relevantIds.filter(id => returnedIds.slice(0, 5).includes(id as MemoryId)).length / query.relevantIds.length),
      recallAt10: round(query.relevantIds.filter(id => returnedIds.slice(0, 10).includes(id as MemoryId)).length / query.relevantIds.length),
      reciprocalRank: first === null ? 0 : round(1 / first),
      forbiddenHits: caseForbiddenHits,
    })
  }

  return {
    metrics: {
      synonym: independentMetric(cases.filter(item => item.bucket === 'synonym')),
      exact: independentMetric(cases.filter(item => item.bucket === 'exact')),
    },
    buckets: (['synonym', 'exact'] as const).flatMap(bucket =>
      (['zh', 'en'] as const).map(language => {
      const cell = cases.filter(item => item.bucket === bucket && item.language === language)
        return { bucket, language, queryCount: cell.length, ...independentMetric(cell) }
      })),
    cases,
    hardChecks: { scopeLeaks, forbiddenHits, duplicateResultIds },
  }
}

async function hashBaseline(dataset: EmbeddingDataset): Promise<Record<`${Bucket}/${Language}`, RetrievalMetric>> {
  const result = await independentHashEvaluation(dataset)
  return Object.fromEntries(result.buckets.map(bucket => [
    `${bucket.bucket}/${bucket.language}`,
    { recallAt5: bucket.recallAt5, recallAt10: bucket.recallAt10, mrrAt10: bucket.mrrAt10 },
  ])) as Record<`${Bucket}/${Language}`, RetrievalMetric>
}

function report(dataset: EmbeddingDataset, options: {
  readonly synonymRecall: number
  readonly exactRecall: number
  readonly quality?: 'portable-hash' | 'trained'
  readonly hardChecks?: EmbeddingReport['hardChecks']
}): EmbeddingReport {
  const synonym = { recallAt5: options.synonymRecall, recallAt10: options.synonymRecall, mrrAt10: options.synonymRecall }
  const exact = { recallAt5: options.exactRecall, recallAt10: options.exactRecall, mrrAt10: options.exactRecall }
  const quality = options.quality ?? 'portable-hash'
  const cellIndex = new Map<string, number>()
  return {
    schemaVersion: 1,
    dataset: { id: dataset.datasetId, version: dataset.datasetVersion, referenceCommit: dataset.referenceCommit },
    runner: { version: 1, repeats: 1, mode: quality === 'trained' ? 'live' : 'offline-hash', externalNetwork: quality === 'trained' },
    provider: {
      quality,
      model: quality === 'trained' ? 'fixture-trained-model' : null,
      spaceId: quality === 'trained' ? 'test/fixture-trained/3/l2' : HASH_EMBEDDING_SPACE_ID,
      dimensions: quality === 'trained' ? 3 : HASH_EMBEDDING_DIMENSIONS,
      normalization: 'l2',
    },
    metrics: { synonym, exact },
    buckets: (['synonym', 'exact'] as const).flatMap(bucket => (['zh', 'en'] as const).map(language => ({
      bucket,
      language,
      queryCount: dataset.queries.filter(query => query.bucket === bucket && query.language === language).length,
      ...(bucket === 'synonym' ? synonym : exact),
    }))),
    cases: dataset.queries.map(query => {
      const key = `${query.bucket}/${query.language}`
      const index = cellIndex.get(key) ?? 0
      cellIndex.set(key, index + 1)
      const cellSize = dataset.queries.filter(candidate =>
        candidate.bucket === query.bucket && candidate.language === query.language).length
      const value = query.bucket === 'synonym' ? options.synonymRecall : options.exactRecall
      const hit = index < Math.round(cellSize * value)
      return {
        id: query.id,
        language: query.language,
        bucket: query.bucket,
        split: query.split,
        relevantIds: query.relevantIds,
        forbiddenIds: query.forbiddenIds,
        returnedIds: hit ? query.relevantIds : [],
        firstRelevantRank: hit ? 1 : null,
        recallAt5: hit ? 1 : 0,
        recallAt10: hit ? 1 : 0,
        reciprocalRank: hit ? 1 : 0,
        forbiddenHits: [],
      }
    }),
    hardChecks: options.hardChecks ?? { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
  }
}

function gateConfig(
  baseline: EmbeddingReport,
  overrides: {
    readonly relativeSynonymRecallAt10Floor?: number
    readonly exactRecallAt10Floor?: number
    readonly hardChecks?: EmbeddingReport['hardChecks']
  } = {},
): EmbeddingGates {
  return {
    schemaVersion: 1,
    dataset: baseline.dataset,
    offline: { metrics: baseline.metrics },
    live: {
      relativeSynonymRecallAt10Floor: overrides.relativeSynonymRecallAt10Floor ?? 0.2,
      exactRecallAt10Floor: overrides.exactRecallAt10Floor ?? baseline.metrics.exact.recallAt10,
    },
    hardChecks: overrides.hardChecks ?? { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
  }
}

async function temporaryJson(value: unknown, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-eval-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

async function temporaryLivePreload(
  rules: readonly { readonly query: string; readonly relevantId: string; readonly action: 'ensure' | 'remove' }[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-gate-preload-'))
  roots.push(root)
  const path = join(root, 'preload.mjs')
  await writeFile(path, [
    `import MemoryService from ${JSON.stringify(builtMemoryUrl.href)}`,
    `const rules = new Map(${JSON.stringify(rules)}.map(rule => [rule.query, rule]))`,
    'const originalSearch = MemoryService.prototype.search',
    'MemoryService.prototype.search = async function (input, signal) {',
    '  const result = await originalSearch.call(this, input, signal)',
    '  const rule = rules.get(input.query)',
    '  if (rule === undefined) return result',
    '  let normal = result.channels.normal.filter(hit => hit.memory.id !== rule.relevantId)',
    '  if (rule.action === "ensure") {',
    '    const memory = this.get(rule.relevantId, input.scope)',
    '    if (memory === undefined) throw new Error(`missing gate fixture memory ${rule.relevantId}`)',
    '    normal = [{ memory, score: 1, matchedBy: ["semantic"] }, ...normal].slice(0, 10)',
    '  }',
    '  return { ...result, channels: { ...result.channels, normal } }',
    '}',
    'globalThis.fetch = async (_url, init) => {',
    '  const body = JSON.parse(String(init.body))',
    '  const input = Array.isArray(body.input) ? body.input : [body.input]',
    '  const data = input.map((_text, index) => ({ object: "embedding", index, embedding: [1, 2, 3] }))',
    '  return new Response(JSON.stringify({ object: "list", model: body.model, data }))',
    '}',
    '',
  ].join('\n'), 'utf8')
  return path
}

async function temporaryReturnedIdsPreload(
  rules: readonly { readonly query: string; readonly returnedIds: readonly string[] }[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-metric-preload-'))
  roots.push(root)
  const path = join(root, 'preload.mjs')
  await writeFile(path, [
    `import MemoryService from ${JSON.stringify(builtMemoryUrl.href)}`,
    `const rules = new Map(${JSON.stringify(rules)}.map(rule => [rule.query, rule.returnedIds]))`,
    'const originalSearch = MemoryService.prototype.search',
    'MemoryService.prototype.search = async function (input, signal) {',
    '  const result = await originalSearch.call(this, input, signal)',
    '  const returnedIds = rules.get(input.query)',
    '  if (returnedIds === undefined) return result',
    '  const normal = returnedIds.map(id => {',
    '    const memory = this.get(id, input.scope)',
    '    if (memory === undefined) throw new Error(`missing metric fixture memory ${id}`)',
    '    return { memory, score: 1, matchedBy: ["semantic"] }',
    '  })',
    '  return { ...result, channels: { ...result.channels, normal } }',
    '}',
    'globalThis.fetch = async (_url, init) => {',
    '  const body = JSON.parse(String(init.body))',
    '  const input = Array.isArray(body.input) ? body.input : [body.input]',
    '  const data = input.map((_text, index) => ({ object: "embedding", index, embedding: [1, 2, 3] }))',
    '  return new Response(JSON.stringify({ object: "list", model: body.model, data }))',
    '}',
    '',
  ].join('\n'), 'utf8')
  return path
}

function runCli(args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}) {
  const env = { ...process.env }
  for (const key of ['DASHSCOPE_API_URL', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) delete env[key]
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  })
}

function shellWords(command: string): string[] {
  return [...command.matchAll(/'([^']*)'|"((?:\\.|[^"])*)"|([^\s]+)/gu)]
    .map(match => match[1] ?? match[2]?.replace(/\\([\\"])/gu, '$1') ?? match[3] as string)
}

function shellOption(words: readonly string[], start: number, name: string): string | undefined {
  for (let index = start; index < words.length; index += 1) {
    const word = words[index]
    if (word === name) return words[index + 1]
    if (word?.startsWith(`${name}=`)) return word.slice(name.length + 1)
  }
  return undefined
}

beforeAll(() => {
  const build = spawnSync('pnpm', ['build'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (build.status !== 0) {
    throw new Error(`embedding evaluation precondition build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`)
  }
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-101 embedding dataset fixture', () => {
  it('is a fixed balanced bilingual corpus with label-free shared distractors', async () => {
    const dataset = await readDataset()
    assertDatasetFixture(dataset)
    expect(JSON.parse(await readFile(datasetSchemaPath, 'utf8'))).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { datasetId: { const: 'dsh-memory-embedding' } },
    })
    expect(JSON.parse(await readFile(reportSchemaPath, 'utf8'))).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { schemaVersion: { const: 1 } },
    })
  })

  it('has a real hash baseline that leaves measurable synonym headroom while exact queries remain perfect', async () => {
    const dataset = await readDataset()
    assertDatasetFixture(dataset)
    const baseline = await hashBaseline(dataset)
    const synonymMacro = (baseline['synonym/zh'].recallAt10 + baseline['synonym/en'].recallAt10) / 2
    const exactMacro = (baseline['exact/zh'].recallAt10 + baseline['exact/en'].recallAt10) / 2

    expect(baseline['synonym/zh'].recallAt10).toBe(0.3)
    expect(baseline['synonym/en'].recallAt10).toBe(0.7)
    expect(synonymMacro).toBe(0.5)
    expect(baseline['exact/zh'].recallAt10).toBe(1)
    expect(baseline['exact/en'].recallAt10).toBe(1)
    expect(exactMacro).toBe(1)
  }, 120_000)
})

describe('MEM-101 embedding metrics contracts', () => {
  it('accepts the checked-in dataset and report and rejects semantic dataset/report violations', async () => {
    const dataset = await readDataset()
    const metrics = await loadMetrics()
    expect(() => metrics.validateEmbeddingDataset(dataset)).not.toThrow()
    expect(() => metrics.validateEmbeddingReport(report(dataset, { synonymRecall: 0.5, exactRecall: 1 }))).not.toThrow()

    const duplicate = structuredClone(dataset) as { queries: QueryFixture[] } & Omit<EmbeddingDataset, 'queries'>
    const first = duplicate.queries[0]
    if (first === undefined) throw new Error('missing duplicate query fixture')
    duplicate.queries.push(structuredClone(first))
    expect(() => metrics.validateEmbeddingDataset(duplicate)).toThrow(/duplicate.*query|query.*duplicate/i)

    const leakedTags = structuredClone(dataset) as { records: RecordFixture[] } & Omit<EmbeddingDataset, 'records'>
    const tagged = leakedTags.records[0]
    if (tagged === undefined) throw new Error('missing tag fixture')
    leakedTags.records[0] = { ...tagged, tags: [dataset.queries[0]?.id ?? 'answer-label'] }
    expect(() => metrics.validateEmbeddingDataset(leakedTags)).toThrow(/tag|label/i)

    const invalidReport = { ...report(dataset, { synonymRecall: 0.5, exactRecall: 1 }), apiKey: 'must-not-be-reportable' }
    expect(() => metrics.validateEmbeddingReport(invalidReport)).toThrow(/report|property|apiKey/i)

    const inconsistentAggregate = structuredClone(report(dataset, { synonymRecall: 0.5, exactRecall: 1 }))
    ;(inconsistentAggregate.metrics.synonym as { recallAt10: number }).recallAt10 = 0.55
    expect(() => metrics.validateEmbeddingReport(inconsistentAggregate)).toThrow(/aggregate|metric|case|recallAt10|inconsistent/i)

    const inconsistentCase = structuredClone(report(dataset, { synonymRecall: 0.5, exactRecall: 1 }))
    const hitCase = inconsistentCase.cases.find(item => item.recallAt10 === 1)
    if (hitCase === undefined) throw new Error('missing hit report fixture')
    ;(hitCase as { returnedIds: string[] }).returnedIds = []
    expect(() => metrics.validateEmbeddingReport(inconsistentCase)).toThrow(/returnedIds|rank|recall|case|inconsistent/i)

    const provenanceMismatches = [
      { ...report(dataset, { synonymRecall: 0.5, exactRecall: 1 }), runner: { version: 1 as const, repeats: 1, mode: 'offline-hash' as const, externalNetwork: true } },
      { ...report(dataset, { synonymRecall: 0.5, exactRecall: 1, quality: 'trained' }), runner: { version: 1 as const, repeats: 1, mode: 'live' as const, externalNetwork: false } },
      { ...report(dataset, { synonymRecall: 0.5, exactRecall: 1, quality: 'trained' }), provider: { quality: 'portable-hash' as const, model: 'fixture-trained-model', spaceId: HASH_EMBEDDING_SPACE_ID, dimensions: HASH_EMBEDDING_DIMENSIONS, normalization: 'l2' as const } },
      { ...report(dataset, { synonymRecall: 0.5, exactRecall: 1, quality: 'trained' }), provider: { quality: 'trained' as const, model: null, spaceId: 'test/fixture-trained/3/l2', dimensions: 3, normalization: 'l2' as const } },
    ]
    for (const mismatch of provenanceMismatches) {
      expect(() => metrics.validateEmbeddingReport(mismatch)).toThrow(/mode|network|quality|model|provider|provenance/i)
    }
  })

  it('computes ranking, macro metrics, and hard checks from returned IDs rather than report labels', async () => {
    const { computeEmbeddingMetrics } = await loadMetrics()
    const measured = computeEmbeddingMetrics([
      {
        id: 'sentinel-synonym-zh', language: 'zh', bucket: 'synonym', split: 'baseline',
        relevantIds: ['rel-a', 'rel-b'], forbiddenIds: ['forbid'],
        returnedIds: ['noise', 'rel-a', 'rel-a', 'forbid'], scopeLeaks: 1,
      },
      {
        id: 'sentinel-synonym-en', language: 'en', bucket: 'synonym', split: 'holdout',
        relevantIds: ['rel-c'], forbiddenIds: [], returnedIds: [], scopeLeaks: 0,
      },
      {
        id: 'sentinel-exact-zh', language: 'zh', bucket: 'exact', split: 'baseline',
        relevantIds: ['rel-d'], forbiddenIds: [], returnedIds: ['rel-d'], scopeLeaks: 0,
      },
      {
        id: 'sentinel-exact-en', language: 'en', bucket: 'exact', split: 'holdout',
        relevantIds: ['rel-e'], forbiddenIds: [], returnedIds: ['noise', 'rel-e'], scopeLeaks: 0,
      },
    ])

    expect(measured.metrics).toEqual({
      synonym: { recallAt5: 0.25, recallAt10: 0.25, mrrAt10: 0.25 },
      exact: { recallAt5: 1, recallAt10: 1, mrrAt10: 0.75 },
    })
    expect(measured.buckets).toEqual([
      { bucket: 'synonym', language: 'zh', queryCount: 1, recallAt5: 0.5, recallAt10: 0.5, mrrAt10: 0.5 },
      { bucket: 'synonym', language: 'en', queryCount: 1, recallAt5: 0, recallAt10: 0, mrrAt10: 0 },
      { bucket: 'exact', language: 'zh', queryCount: 1, recallAt5: 1, recallAt10: 1, mrrAt10: 1 },
      { bucket: 'exact', language: 'en', queryCount: 1, recallAt5: 1, recallAt10: 1, mrrAt10: 0.5 },
    ])
    expect(measured.cases[0]).toMatchObject({
      firstRelevantRank: 2,
      recallAt5: 0.5,
      recallAt10: 0.5,
      reciprocalRank: 0.5,
      forbiddenHits: ['forbid'],
    })
    expect(measured.hardChecks).toEqual({ scopeLeaks: 1, forbiddenHits: 1, duplicateResultIds: 1 })
  })

  it('implements the relative synonym and exact non-regression gates without rounding away failures', async () => {
    const dataset = await readDataset()
    const { evaluateEmbeddingGates } = await loadMetrics()
    const baseline = report(dataset, { synonymRecall: 0.5, exactRecall: 0.9 })
    const passing = report(dataset, { synonymRecall: 0.6, exactRecall: 0.9, quality: 'trained' })
    const synonymRegression = report(dataset, { synonymRecall: 0.599999, exactRecall: 0.9, quality: 'trained' })
    const exactRegression = report(dataset, { synonymRecall: 0.6, exactRecall: 0.899999, quality: 'trained' })
    const hardFailure = report(dataset, {
      synonymRecall: 0.6,
      exactRecall: 0.9,
      quality: 'trained',
      hardChecks: { scopeLeaks: 1, forbiddenHits: 0, duplicateResultIds: 0 },
    })
    const gates = gateConfig(baseline)

    expect(evaluateEmbeddingGates(baseline, passing, gates)).toEqual({
      passed: true,
      relativeSynonymRecallAt10: 0.2,
      failures: [],
    })
    expect(evaluateEmbeddingGates(baseline, synonymRegression, gates)).toMatchObject({
      passed: false,
      relativeSynonymRecallAt10: 0.199998,
    })
    expect(evaluateEmbeddingGates(baseline, exactRegression, gates)).toMatchObject({ passed: false })
    expect(evaluateEmbeddingGates(baseline, hardFailure, gates)).toMatchObject({ passed: false })
  })

  it('uses supplied relative, exact, and hard-check thresholds instead of compiled constants', async () => {
    const dataset = await readDataset()
    const { evaluateEmbeddingGates } = await loadMetrics()
    const baseline = report(dataset, { synonymRecall: 0.5, exactRecall: 0.9 })
    const relativeBoundary = report(dataset, { synonymRecall: 0.6, exactRecall: 0.9, quality: 'trained' })
    const exactBoundary = report(dataset, { synonymRecall: 0.7, exactRecall: 0.9, quality: 'trained' })
    const allowedHardCount = report(dataset, {
      synonymRecall: 0.7,
      exactRecall: 0.9,
      quality: 'trained',
      hardChecks: { scopeLeaks: 1, forbiddenHits: 2, duplicateResultIds: 3 },
    })

    expect(evaluateEmbeddingGates(baseline, relativeBoundary, gateConfig(baseline, {
      relativeSynonymRecallAt10Floor: 0.200001,
    }))).toMatchObject({ passed: false })
    expect(evaluateEmbeddingGates(baseline, relativeBoundary, gateConfig(baseline, {
      relativeSynonymRecallAt10Floor: 0.199999,
    }))).toMatchObject({ passed: true })
    expect(evaluateEmbeddingGates(baseline, exactBoundary, gateConfig(baseline, {
      exactRecallAt10Floor: 0.900001,
    }))).toMatchObject({ passed: false })
    expect(evaluateEmbeddingGates(baseline, allowedHardCount, gateConfig(baseline, {
      hardChecks: { scopeLeaks: 1, forbiddenHits: 2, duplicateResultIds: 3 },
    }))).toMatchObject({ passed: true })
  })
})

describe('MEM-101 embedding runner and authorization boundary', () => {
  it('runs offline through public import/search with no credentials or fetch calls', async () => {
    const preload = await temporaryJson({}, 'placeholder.json')
    const preloadPath = preload.replace(/placeholder\.json$/u, 'offline-preload.mjs')
    await writeFile(preloadPath, [
      "globalThis.fetch = () => { throw new Error('offline embedding evaluation attempted network access') }",
      "for (const key of ['DASHSCOPE_API_URL','DASHSCOPE_API_KEY','OPENAI_API_KEY','DEEPSEEK_API_KEY']) {",
      "  if (process.env[key] !== undefined) throw new Error(`offline embedding evaluation retained ${key}`)",
      '}',
    ].join('\n'), 'utf8')
    const result = runCli(['--dataset', datasetPath, '--repeat', '1', '--report-only'], {
      NODE_OPTIONS: `--import=${preloadPath}`,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as EmbeddingReport
    expect(parsed).toMatchObject({
      runner: { mode: 'offline-hash', externalNetwork: false },
      provider: {
        quality: 'portable-hash',
        model: null,
        spaceId: HASH_EMBEDDING_SPACE_ID,
        dimensions: HASH_EMBEDDING_DIMENSIONS,
      },
      hardChecks: { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
    })
  }, 120_000)

  it('uses exit 1 for invalid input and exit 2 for completed hard-check failures', async () => {
    const dataset = await readDataset()
    const duplicate = structuredClone(dataset) as { queries: QueryFixture[] } & Omit<EmbeddingDataset, 'queries'>
    const first = duplicate.queries[0]
    if (first === undefined) throw new Error('missing invalid CLI fixture')
    duplicate.queries.push(structuredClone(first))
    const invalidPath = await temporaryJson(duplicate, 'invalid-cases.json')
    const invalid = runCli(['--dataset', invalidPath, '--repeat', '1', '--report-only'])
    expect(invalid.status).toBe(1)
    expect(invalid.stdout).toBe('')
    expect(invalid.stderr).toMatch(/embedding: invalid dataset:/i)
    expect(invalid.stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/i)

    const forbidden = structuredClone(dataset) as { queries: QueryFixture[] } & Omit<EmbeddingDataset, 'queries'>
    const target = forbidden.queries[0]
    if (target === undefined) throw new Error('missing hard-check CLI fixture')
    forbidden.queries[0] = {
      ...target,
      query: '用户周末在家整理纸质照片。',
      forbiddenIds: [...target.forbiddenIds, 'emb-noise-zh-weekend'],
    }
    const forbiddenPath = await temporaryJson(forbidden, 'forbidden-cases.json')
    const failed = runCli(['--dataset', forbiddenPath, '--repeat', '1', '--report-only'])
    expect(failed.status).toBe(2)
    expect(failed.stderr).toMatch(/embedding: hard check failed:/i)
    expect(JSON.parse(failed.stdout)).toMatchObject({ hardChecks: { forbiddenHits: expect.any(Number) } })
  }, 120_000)

  it('requires both live-model and explicit network authorization before any live request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-auth-trap-'))
    roots.push(root)
    const preloadPath = join(root, 'fetch-trap.mjs')
    await writeFile(preloadPath, "globalThis.fetch = () => { throw new Error('live authorization boundary attempted fetch') }\n", 'utf8')
    const trappedEnv = { NODE_OPTIONS: `--import=${preloadPath}` }
    const modelOnly = runCli(['--dataset', datasetPath, '--live-model', 'fixture-model', '--report-only'], trappedEnv)
    const networkOnly = runCli(['--dataset', datasetPath, '--allow-network', '--report-only'], trappedEnv)

    for (const result of [modelOnly, networkOnly]) {
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/--live-model.*--allow-network|--allow-network.*--live-model/i)
      expect(result.stderr).not.toContain('live authorization boundary attempted fetch')
    }
  })

  it('emits a valid live report without endpoint, credential, headers, vectors, or temp paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-live-preload-'))
    roots.push(root)
    const preloadPath = join(root, 'live-preload.mjs')
    await writeFile(preloadPath, [
      'globalThis.fetch = async (_url, init) => {',
      '  const body = JSON.parse(String(init.body))',
      '  const input = Array.isArray(body.input) ? body.input : [body.input]',
      '  const data = input.map((text, index) => {',
      '    let sum = 0',
      '    for (const point of String(text)) sum = (sum + point.codePointAt(0)) % 97',
      '    return { object: "embedding", index, embedding: [1 + (sum % 3), 1 + (sum % 5), 1 + (sum % 7)] }',
      '  })',
      '  return new Response(JSON.stringify({ object: "list", model: body.model, data }))',
      '}',
    ].join('\n'), 'utf8')
    const secret = 'live-super-secret-do-not-report'
    const endpoint = 'https://embedding.fixture.invalid/v1'
    const result = runCli([
      '--dataset', datasetPath,
      '--repeat', '1',
      '--live-model', 'fixture-trained-model',
      '--allow-network',
      '--space-id', 'test/fixture-trained/3/l2',
      '--dimensions', '3',
      '--report-only',
    ], {
      NODE_OPTIONS: `--import=${preloadPath}`,
      DASHSCOPE_API_URL: endpoint,
      DASHSCOPE_API_KEY: secret,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const metrics = await loadMetrics()
    const parsed = JSON.parse(result.stdout) as EmbeddingReport
    expect(() => metrics.validateEmbeddingReport(parsed)).not.toThrow()
    expect(parsed).toMatchObject({
      runner: { mode: 'live', externalNetwork: true },
      provider: { quality: 'trained', model: 'fixture-trained-model', dimensions: 3 },
    })
    for (const forbidden of [secret, endpoint, 'authorization', 'bearer', 'embedding:', preloadPath, root]) {
      expect(result.stdout.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
    expect(JSON.stringify(parsed)).not.toMatch(/api.?key|request.?header|response.?body|\bvector\b/i)
  }, 120_000)

  it('provides the same deterministic offline report programmatically', async () => {
    const dataset = await readDataset()
    const oracle = await independentHashEvaluation(dataset)
    const built = await loadBuiltMemory()
    const importSpy = vi.spyOn(built.default.prototype, 'import')
    const searchSpy = vi.spyOn(built.default.prototype, 'search')
    const addSpy = vi.spyOn(built.default.prototype, 'add')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('programmatic offline embedding evaluation attempted network access')
    })
    const { runEmbedding } = await loadRunner()
    const first = await runEmbedding({ datasetPath, repeats: 1, mode: 'offline-hash' })
    const second = await runEmbedding({ datasetPath, repeats: 1, mode: 'offline-hash' })
    const { canonicalJson, validateEmbeddingReport } = await loadMetrics()

    expect(() => validateEmbeddingReport(first)).not.toThrow()
    expect(canonicalJson(second)).toBe(canonicalJson(first))
    expect(first.cases).toEqual(oracle.cases)
    expect(first.metrics).toEqual(oracle.metrics)
    expect(first.buckets).toEqual(oracle.buckets)
    expect(first.hardChecks).toEqual(oracle.hardChecks)
    expect(importSpy).toHaveBeenCalled()
    expect(searchSpy).toHaveBeenCalledTimes(dataset.queries.length * 2)
    expect(addSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(canonicalJson(first)).not.toMatch(/dsh-memory-embedding-eval-|\/tmp\//u)
  }, 120_000)
})

describe('MEM-101 frozen baseline, gates, and package command', () => {
  it('freezes the repeats=2 public-runner hash report and exact bilingual baseline cells', async () => {
    const [{ runEmbedding }, { canonicalJson, validateEmbeddingReport }, baselineText] = await Promise.all([
      loadRunner(),
      loadMetrics(),
      readFile(baselinePath, 'utf8'),
    ])
    const baseline = JSON.parse(baselineText) as EmbeddingReport
    const current = await runEmbedding({ datasetPath, repeats: 2, mode: 'offline-hash' })

    expect(() => validateEmbeddingReport(baseline)).not.toThrow()
    expect(canonicalJson(current)).toBe(canonicalJson(baseline))
    expect(baseline.runner).toMatchObject({ repeats: 2, mode: 'offline-hash', externalNetwork: false })
    expect(baseline.provider).toMatchObject({
      quality: 'portable-hash',
      model: null,
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
    })
    expect(baseline.metrics.synonym.recallAt10).toBe(0.5)
    expect(baseline.metrics.exact.recallAt10).toBe(1)
    expect(baseline.buckets.find(cell => cell.bucket === 'synonym' && cell.language === 'zh')?.recallAt10).toBe(0.3)
    expect(baseline.buckets.find(cell => cell.bucket === 'synonym' && cell.language === 'en')?.recallAt10).toBe(0.7)
    expect(baseline.buckets.filter(cell => cell.bucket === 'exact').map(cell => cell.recallAt10)).toEqual([1, 1])
  }, 120_000)

  it('derives offline and live gates from the checked-in baseline instead of weakening its metrics', async () => {
    const [baseline, gates] = await Promise.all([
      readFile(baselinePath, 'utf8').then(text => JSON.parse(text) as EmbeddingReport),
      readFile(gatesPath, 'utf8').then(text => JSON.parse(text) as {
        readonly schemaVersion: 1
        readonly dataset: EmbeddingReport['dataset']
        readonly offline: { readonly metrics: EmbeddingReport['metrics'] }
        readonly live: {
          readonly relativeSynonymRecallAt10Floor: number
          readonly exactRecallAt10Floor: number
        }
        readonly hardChecks: EmbeddingReport['hardChecks']
      }),
    ])

    expect(gates).toEqual({
      schemaVersion: 1,
      dataset: baseline.dataset,
      offline: { metrics: baseline.metrics },
      live: {
        relativeSynonymRecallAt10Floor: 0.2,
        exactRecallAt10Floor: baseline.metrics.exact.recallAt10,
      },
      hardChecks: { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
    })
  })

  it('wires the fixed dataset, baseline, gates, and repeats into eval:embedding', async () => {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>
    }
    const script = manifest.scripts?.['eval:embedding']
    expect(script).toBeTypeOf('string')
    const words = shellWords(script as string)
    const buildIndex = words.findIndex((word, index) => word === 'pnpm'
      && (words[index + 1] === 'build' || (words[index + 1] === 'run' && words[index + 2] === 'build')))
    const runnerIndex = words.findIndex((word, index) => word === 'node'
      && words[index + 1]?.replace(/^\.\//u, '') === 'evaluation/run-embedding.mjs')
    expect(buildIndex).toBeGreaterThanOrEqual(0)
    expect(runnerIndex).toBeGreaterThan(buildIndex)
    expect(words.slice(buildIndex, runnerIndex)).toContain('&&')
    expect(shellOption(words, runnerIndex, '--dataset')).toBe('evaluation/embedding/v1/cases.json')
    expect(shellOption(words, runnerIndex, '--baseline')).toBe('evaluation/embedding/v1/baseline.hash-v1.json')
    expect(shellOption(words, runnerIndex, '--gates')).toBe('evaluation/embedding/v1/gates.json')
    expect(shellOption(words, runnerIndex, '--repeat')).toBe('2')
  })

  it('wires the bounded single-observation DashScope command into eval:embedding:live', async () => {
    const [manifestText, readme, readmeZh] = await Promise.all([
      readFile(packagePath, 'utf8'),
      readFile(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8'),
      readFile(fileURLToPath(new URL('../README.zh.md', import.meta.url)), 'utf8'),
    ])
    const manifest = JSON.parse(manifestText) as {
      readonly scripts?: Readonly<Record<string, string>>
    }
    const script = manifest.scripts?.['eval:embedding:live']
    expect(script).toBeTypeOf('string')
    const words = shellWords(script as string)
    const buildIndex = words.findIndex((word, index) => word === 'pnpm'
      && (words[index + 1] === 'build' || (words[index + 1] === 'run' && words[index + 2] === 'build')))
    const runnerIndex = words.findIndex((word, index) => word === 'node'
      && words[index + 1]?.replace(/^\.\//u, '') === 'evaluation/run-embedding.mjs')
    expect(buildIndex).toBeGreaterThanOrEqual(0)
    expect(runnerIndex).toBeGreaterThan(buildIndex)
    expect(words.slice(buildIndex, runnerIndex)).toContain('&&')
    expect(shellOption(words, runnerIndex, '--dataset')).toBe('evaluation/embedding/v1/cases.json')
    expect(shellOption(words, runnerIndex, '--baseline')).toBe('evaluation/embedding/v1/baseline.hash-v1.json')
    expect(shellOption(words, runnerIndex, '--gates')).toBe('evaluation/embedding/v1/gates.json')
    expect(shellOption(words, runnerIndex, '--live-model')).toBe('qwen3.7-text-embedding')
    expect(words.slice(runnerIndex)).toContain('--allow-network')
    expect(shellOption(words, runnerIndex, '--space-id')).toBe('dashscope/qwen3.7-text-embedding/1024/l2')
    expect(shellOption(words, runnerIndex, '--dimensions')).toBe('1024')
    expect(shellOption(words, runnerIndex, '--batch-size')).toBe('16')
    expect(shellOption(words, runnerIndex, '--repeat')).toBe('1')

    for (const documentation of [readme, readmeZh]) {
      expect(documentation).toContain('pnpm run eval:embedding:live')
      expect(documentation).toMatch(/(?:batch(?:\s+size)?\D{0,24}16|16\D{0,24}batch|批(?:次|量)\D{0,24}16|16\D{0,24}批(?:次|量))/iu)
      expect(documentation).toMatch(/(?:single|one)\D{0,30}(?:observation|run)|(?:单次|一次)\D{0,30}(?:观测|运行)|repeat\D{0,12}1/iu)
    }
  })

  it('loads the checked-in baseline and gates in offline CLI mode', () => {
    const result = runCli([
      '--dataset', datasetPath,
      '--baseline', baselinePath,
      '--gates', gatesPath,
      '--repeat', '2',
    ])
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toMatchObject({
      runner: { mode: 'offline-hash', repeats: 2 },
      metrics: { synonym: { recallAt10: 0.5 }, exact: { recallAt10: 1 } },
    })
  }, 120_000)

  it('maps a relative synonym quality-gate miss to exit 2', async () => {
    const dataset = structuredClone(await readDataset()) as {
      records: RecordFixture[]
      queries: QueryFixture[]
    } & Omit<EmbeddingDataset, 'records' | 'queries'>
    const records = new Map(dataset.records.map(record => [record.id, record]))
    const synonymQueries = dataset.queries.filter(query => query.bucket === 'synonym')
    const denominators = [...Array<number>(16).fill(5), 21, 68, 10, 11]
    const numerators = [...Array<number>(16).fill(3), 10, 1, 10, 10]
    const rules: Array<{ query: string; returnedIds: string[] }> = []
    for (const [index, query] of synonymQueries.entries()) {
      const template = records.get(query.relevantIds[0] as string)
      const denominator = denominators[index]
      const numerator = numerators[index]
      if (template === undefined || denominator === undefined || numerator === undefined) {
        throw new Error(`missing relative gate fixture cell ${query.id}`)
      }
      const relevantIds = [template.id]
      for (let offset = 1; offset < denominator; offset += 1) {
        const id = `${template.id}-relative-${offset}`
        relevantIds.push(id)
        dataset.records.push({ ...template, id })
      }
      dataset.queries[dataset.queries.findIndex(candidate => candidate.id === query.id)] = { ...query, relevantIds }
      rules.push({ query: query.query, returnedIds: relevantIds.slice(0, numerator) })
    }
    for (const query of dataset.queries.filter(query => query.bucket === 'exact')) {
      rules.push({ query: query.query, returnedIds: [query.relevantIds[0] as string] })
    }
    const relativeDatasetPath = await temporaryJson(dataset, 'relative-cases.json')
    const preloadPath = await temporaryReturnedIdsPreload(rules)
    const args = [
      '--dataset', relativeDatasetPath,
      '--baseline', baselinePath,
      '--gates', gatesPath,
      '--repeat', '1',
      '--live-model', 'fixture-trained-model',
      '--allow-network',
      '--space-id', 'test/fixture-trained/3/l2',
      '--dimensions', '3',
    ]
    const environment = {
      NODE_OPTIONS: `--import=${preloadPath}`,
      DASHSCOPE_API_URL: 'https://embedding.fixture.invalid/v1',
      DASHSCOPE_API_KEY: 'relative-gate-secret',
    }
    const result = runCli(args, environment)

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/relative.*synonym|synonym.*relative/i)
    expect(JSON.parse(result.stdout)).toMatchObject({
      metrics: { synonym: { recallAt10: 0.599999 }, exact: { recallAt10: 1 } },
    })

    const relaxed = JSON.parse(await readFile(gatesPath, 'utf8')) as EmbeddingGates
    const relaxedPath = await temporaryJson({
      ...relaxed,
      live: { ...relaxed.live, relativeSynonymRecallAt10Floor: 0.19 },
    }, 'relative-relaxed-gates.json')
    const relaxedResult = runCli(args.map(argument => argument === gatesPath ? relaxedPath : argument), environment)
    expect(relaxedResult.status).toBe(0)
    expect(relaxedResult.stderr).toBe('')
  }, 120_000)

  it('maps exact-match regression to exit 2 even when synonym quality improves', async () => {
    const dataset = await readDataset()
    const exactQueries = dataset.queries.filter(query => query.bucket === 'exact')
    const firstExact = exactQueries[0]
    if (firstExact === undefined) throw new Error('missing exact gate fixture')
    const rules = dataset.queries.map(query => ({
      query: query.query,
      relevantId: query.relevantIds[0] as string,
      action: (query.id === firstExact.id ? 'remove' : 'ensure') as 'ensure' | 'remove',
    }))
    const preloadPath = await temporaryLivePreload(rules)
    const args = [
      '--dataset', datasetPath,
      '--baseline', baselinePath,
      '--gates', gatesPath,
      '--repeat', '1',
      '--live-model', 'fixture-trained-model',
      '--allow-network',
      '--space-id', 'test/fixture-trained/3/l2',
      '--dimensions', '3',
    ]
    const environment = {
      NODE_OPTIONS: `--import=${preloadPath}`,
      DASHSCOPE_API_URL: 'https://embedding.fixture.invalid/v1',
      DASHSCOPE_API_KEY: 'exact-gate-secret',
    }
    const result = runCli(args, environment)

    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/exact.*regression|exact.*gate|exact.*floor/i)
    expect(JSON.parse(result.stdout)).toMatchObject({
      metrics: { synonym: { recallAt10: 1 }, exact: { recallAt10: 0.833333 } },
    })

    const relaxed = JSON.parse(await readFile(gatesPath, 'utf8')) as EmbeddingGates
    const relaxedPath = await temporaryJson({
      ...relaxed,
      live: { ...relaxed.live, exactRecallAt10Floor: 0.8 },
    }, 'exact-relaxed-gates.json')
    const relaxedResult = runCli(args.map(argument => argument === gatesPath ? relaxedPath : argument), environment)
    expect(relaxedResult.status).toBe(0)
    expect(relaxedResult.stderr).toBe('')
  }, 120_000)

  it('uses a supplied hard-check allowance to change runner exit 2 to success', async () => {
    const dataset = structuredClone(await readDataset()) as {
      records: RecordFixture[]
      queries: QueryFixture[]
    } & Omit<EmbeddingDataset, 'records' | 'queries'>
    const target = dataset.queries[0]
    if (target === undefined) throw new Error('missing hard-check gate query fixture')
    const distractor = dataset.records.find(record =>
      ownerKey(record.owner) === ownerKey(target.owner)
      && record.status === 'active'
      && record.visibility === 'recallable'
      && !target.relevantIds.includes(record.id))
    if (distractor === undefined) throw new Error('missing same-owner hard-check gate distractor')
    dataset.queries[0] = {
      ...target,
      forbiddenIds: [...new Set([...target.forbiddenIds, distractor.id])],
    }
    const rules = dataset.queries.map(query => ({
      query: query.query,
      returnedIds: query.id === target.id
        ? [query.relevantIds[0] as string, distractor.id]
        : [query.relevantIds[0] as string],
    }))
    const hardDatasetPath = await temporaryJson(dataset, 'hard-threshold-cases.json')
    const preloadPath = await temporaryReturnedIdsPreload(rules)
    const args = [
      '--dataset', hardDatasetPath,
      '--baseline', baselinePath,
      '--gates', gatesPath,
      '--repeat', '1',
      '--live-model', 'fixture-trained-model',
      '--allow-network',
      '--space-id', 'test/fixture-trained/3/l2',
      '--dimensions', '3',
    ]
    const environment = {
      NODE_OPTIONS: `--import=${preloadPath}`,
      DASHSCOPE_API_URL: 'https://embedding.fixture.invalid/v1',
      DASHSCOPE_API_KEY: 'hard-gate-secret',
    }

    const strictResult = runCli(args, environment)
    expect(strictResult.status).toBe(2)
    expect(JSON.parse(strictResult.stdout)).toMatchObject({
      hardChecks: { scopeLeaks: 0, forbiddenHits: 1, duplicateResultIds: 0 },
    })

    const relaxed = JSON.parse(await readFile(gatesPath, 'utf8')) as EmbeddingGates
    const relaxedPath = await temporaryJson({
      ...relaxed,
      hardChecks: { ...relaxed.hardChecks, forbiddenHits: 1 },
    }, 'hard-relaxed-gates.json')
    const relaxedResult = runCli(args.map(argument => argument === gatesPath ? relaxedPath : argument), environment)
    expect(relaxedResult.status).toBe(0)
    expect(relaxedResult.stderr).toBe('')
  }, 120_000)
})
