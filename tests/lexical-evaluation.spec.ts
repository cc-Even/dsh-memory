import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MemoryRecord, MemoryScope, SearchMemoryInput, SearchResult } from '../src/types.ts'

type Bucket = 'continuous_cjk' | 'mixed_language' | 'punctuation_boundary' | 'short_term'
type Split = 'baseline' | 'holdout'

interface Owner { readonly tenantId: string; readonly userId: string; readonly agentId: string }
interface GroupRecord { readonly id: string; readonly content: string }
interface ScoredQuery { readonly id: string; readonly bucket: Bucket; readonly split: Split; readonly query: string; readonly relevantIds: readonly string[] }
interface Group {
  readonly id: string
  readonly owner: Owner
  readonly sourceSessionId: string
  readonly records: readonly GroupRecord[]
  readonly sharedInterference: readonly GroupRecord[]
  readonly distractorCodes: Readonly<Record<Exclude<Bucket, 'mixed_language'>, readonly string[]>>
  readonly distractorIds: Readonly<Record<Exclude<Bucket, 'mixed_language'>, readonly string[]>>
  readonly queries: readonly ScoredQuery[]
}
interface FilterRecord extends GroupRecord {
  readonly owner: Owner
  readonly sourceSessionId: string
  readonly status: 'active' | 'deleted'
  readonly visibility: 'recallable' | 'source_only'
  readonly validUntil?: string
}
interface FilterQuery {
  readonly id: string
  readonly owner: Owner
  readonly sessionId: string
  readonly sessionOnly: boolean
  readonly query: string
  readonly forbiddenIds: readonly string[]
}
interface Dataset {
  readonly schemaVersion: 1
  readonly datasetId: 'dsh-memory-lexical'
  readonly datasetVersion: '1.0.0'
  readonly referenceCommit: string
  readonly evaluationTime: string
  readonly groups: readonly Group[]
  readonly filterRecords: readonly FilterRecord[]
  readonly filterQueries: readonly FilterQuery[]
}
interface CaseMetric {
  readonly id: string
  readonly bucket: Bucket | 'filter'
  readonly split: Split | 'filter'
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
  readonly returnedIds: readonly string[]
  readonly firstRelevantRank: number | null
  readonly recallAt5: number | null
  readonly recallAt10: number | null
  readonly reciprocalRank: number | null
  readonly forbiddenHits: readonly string[]
}
interface MetricTriple { readonly recallAt5: number; readonly recallAt10: number; readonly mrrAt10: number }
interface ModeReport {
  readonly tokenizer: { readonly kind: 'legacy' | 'cjk-bigram'; readonly implementation: string }
  readonly metrics: MetricTriple
  readonly buckets: readonly (MetricTriple & { readonly bucket: Bucket; readonly queryCount: 6 })[]
  readonly cases: readonly CaseMetric[]
  readonly hardChecks: { readonly scopeLeaks: number; readonly forbiddenHits: number; readonly duplicateResultIds: number }
}
interface LexicalReport {
  readonly schemaVersion: 1
  readonly dataset: { readonly id: string; readonly version: string; readonly referenceCommit: string }
  readonly runner: { readonly version: 1; readonly repeats: number; readonly externalNetwork: false }
  readonly embeddingSpace: { readonly id: string; readonly dimensions: 256 }
  readonly modes: { readonly legacy: ModeReport; readonly cjkBigram: ModeReport }
  readonly delta: MetricTriple
}
interface RunnerModule { runLexical(options: { readonly datasetPath: string; readonly repeats: number }): Promise<LexicalReport> }
interface MetricsModule {
  canonicalJson(value: unknown): string
  validateLexicalDataset(value: unknown): void
  validateLexicalReport(value: unknown): void
  computeLexicalMetrics(legacy: readonly RawCase[], cjkBigram: readonly RawCase[]): Pick<LexicalReport, 'modes' | 'delta'>
  evaluateLexicalGates(report: LexicalReport, gates: unknown): { readonly passed: boolean; readonly failures: readonly string[] }
}
interface RawCase {
  readonly id: string
  readonly bucket: Bucket | 'filter'
  readonly split: Split | 'filter'
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
  readonly returnedIds: readonly string[]
  readonly scopeLeaks: number
}
interface MutableRawCase {
  id: string
  bucket: Bucket | 'filter'
  split: Split | 'filter'
  relevantIds: string[]
  forbiddenIds: string[]
  returnedIds: string[]
  scopeLeaks: number
}
interface BuiltPrototype {
  readonly config: { readonly tokenizer: { readonly kind: 'legacy' | 'cjk-bigram' } }
  import(scope: MemoryScope, records: readonly MemoryRecord[]): Promise<number>
  search(input: SearchMemoryInput, signal?: AbortSignal): Promise<SearchResult>
  add(input: unknown, signal?: AbortSignal): Promise<unknown>
}
interface BuiltModule { readonly default: { readonly prototype: BuiltPrototype } }

const workspace = fileURLToPath(new URL('..', import.meta.url))
const datasetPath = fileURLToPath(new URL('../evaluation/lexical/v1/cases.json', import.meta.url))
const datasetSchemaPath = fileURLToPath(new URL('../evaluation/lexical/v1/dataset.schema.json', import.meta.url))
const reportSchemaPath = fileURLToPath(new URL('../evaluation/lexical/report.schema.json', import.meta.url))
const baselinePath = fileURLToPath(new URL('../evaluation/lexical/v1/baseline.hash-legacy-v1.json', import.meta.url))
const gatesPath = fileURLToPath(new URL('../evaluation/lexical/v1/gates.json', import.meta.url))
const runnerUrl = new URL('../evaluation/run-lexical.mjs', import.meta.url)
const runnerPath = fileURLToPath(runnerUrl)
const metricsUrl = new URL('../evaluation/lexical-metrics.mjs', import.meta.url)
const builtUrl = new URL('../lib/index.js', import.meta.url)
const embeddingRunnerUrl = new URL('../evaluation/run-embedding.mjs', import.meta.url)
const embeddingDatasetPath = fileURLToPath(new URL('../evaluation/embedding/v1/cases.json', import.meta.url))
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const roots: string[] = []

async function dataset(): Promise<Dataset> {
  return JSON.parse(await readFile(datasetPath, 'utf8')) as Dataset
}
async function runner(): Promise<RunnerModule> { return await import(/* @vite-ignore */ runnerUrl.href) as RunnerModule }
async function metrics(): Promise<MetricsModule> { return await import(/* @vite-ignore */ metricsUrl.href) as MetricsModule }
async function built(): Promise<BuiltModule> { return await import(builtUrl.href) as BuiltModule }

function ownerKey(owner: Owner): string { return JSON.stringify([owner.tenantId, owner.userId, owner.agentId]) }
function noiseId(group: Group, bucket: Exclude<Bucket, 'mixed_language'>, index: number): string {
  const id = group.distractorIds[bucket][index]
  if (id === undefined) throw new Error(`missing explicit distractor id for ${group.id}/${bucket}/${index}`)
  return id
}
function expandedRecords(group: Group): GroupRecord[] {
  return [
    ...group.records,
    ...group.sharedInterference,
    ...(['continuous_cjk', 'punctuation_boundary', 'short_term'] as const).flatMap(bucket =>
      group.distractorCodes[bucket].map((content, index) => ({ id: noiseId(group, bucket, index), content }))),
  ]
}

const LEGACY_PATTERN = /[a-zA-Z0-9]+|[\u3400-\u9fff]+/gu
function legacyTokens(text: string): string[] {
  return Array.from(text.matchAll(LEGACY_PATTERN), match => match[0].toLowerCase())
}
function bigramTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(LEGACY_PATTERN)) {
    const run = match[0]
    if (/^[A-Za-z0-9]+$/u.test(run)) tokens.push(run.toLowerCase())
    else {
      const points = Array.from(run)
      if (points.length === 1) tokens.push(points[0] as string)
      else for (let index = 0; index + 1 < points.length; index += 1) tokens.push(`${points[index]}${points[index + 1]}`)
    }
  }
  return tokens
}
function hashOracle(text: string): number[] {
  const vector = Array<number>(256).fill(0)
  const features: string[] = []
  for (const token of legacyTokens(text)) {
    features.push(`t:${token}`)
    const points = Array.from(token)
    for (let index = 0; index + 1 < points.length; index += 1) features.push(`b:${points[index]}${points[index + 1]}`)
  }
  for (const feature of features) {
    let hash = 2166136261
    for (const point of feature) { hash ^= point.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619) }
    const unsigned = hash >>> 0
    const index = unsigned % 256
    vector[index] = (vector[index] ?? 0) + ((unsigned & 1) === 0 ? 1 : -1)
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map(value => value / norm)
}
function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  for (let index = 0; index < left.length; index += 1) dot += (left[index] ?? 0) * (right[index] ?? 0)
  return dot
}
function bm25(query: readonly string[], documents: readonly string[], tokenize: (text: string) => readonly string[]): number[] {
  if (query.length === 0) return documents.map(() => 0)
  const tokenized = documents.map(tokenize)
  const lengths = tokenized.map(tokens => tokens.length)
  const average = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1
  const terms = [...new Set(query)]
  const frequencies = tokenized.map((tokens) => {
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    return counts
  })
  return tokenized.map((_, index) => terms.reduce((score, term) => {
    const frequency = frequencies[index]?.get(term) ?? 0
    if (frequency === 0) return score
    const df = frequencies.filter(counts => counts.has(term)).length
    const inverse = Math.log((documents.length - df + 0.5) / (df + 0.5) + 1)
    const denominator = frequency + 1.5 * (1 - 0.75 + 0.75 * (lengths[index] ?? 0) / average)
    return score + inverse * frequency * 2.5 / denominator
  }, 0))
}
function oracleRank(query: string, records: readonly GroupRecord[], tokenize: (text: string) => readonly string[]): string[] {
  const queryVector = hashOracle(query)
  const semantic = records.map(record => ({ id: record.id, score: cosine(queryVector, hashOracle(record.content)) }))
    .filter(item => item.score >= 0.08).sort((left, right) => right.score - left.score)
  const lexicalScores = bm25(tokenize(query), records.map(record => record.content), tokenize)
  const lexical = records.map((record, index) => ({ id: record.id, score: lexicalScores[index] ?? 0 }))
    .filter(item => item.score > 0).sort((left, right) => right.score - left.score)
  const fused = new Map<string, number>()
  semantic.forEach((item, index) => fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (61 + index)))
  lexical.forEach((item, index) => fused.set(item.id, (fused.get(item.id) ?? 0) + 0.8 / (61 + index)))
  return [...fused].sort((left, right) => right[1] - left[1]).slice(0, 10).map(([id]) => id)
}
function round(value: number): number { return Number(value.toFixed(6)) }
function oracleMetrics(value: Dataset, tokenize: (text: string) => readonly string[]): { metrics: MetricTriple; buckets: Record<Bucket, MetricTriple> } {
  const cases = value.groups.flatMap(group => group.queries.map(query => {
    const returned = oracleRank(query.query, expandedRecords(group), tokenize)
    const rank = returned.findIndex(id => query.relevantIds.includes(id)) + 1
    return { bucket: query.bucket, hit5: rank > 0 && rank <= 5 ? 1 : 0, hit10: rank > 0 ? 1 : 0, rr: rank > 0 ? 1 / rank : 0 }
  }))
  const aggregate = (items: typeof cases): MetricTriple => ({
    recallAt5: round(items.reduce((sum, item) => sum + item.hit5, 0) / items.length),
    recallAt10: round(items.reduce((sum, item) => sum + item.hit10, 0) / items.length),
    mrrAt10: round(items.reduce((sum, item) => sum + item.rr, 0) / items.length),
  })
  return {
    metrics: aggregate(cases),
    buckets: Object.fromEntries((['continuous_cjk', 'mixed_language', 'punctuation_boundary', 'short_term'] as const)
      .map(bucket => [bucket, aggregate(cases.filter(item => item.bucket === bucket))])) as Record<Bucket, MetricTriple>,
  }
}

function zeroBuckets(): ModeReport['buckets'] {
  return (['continuous_cjk', 'mixed_language', 'punctuation_boundary', 'short_term'] as const)
    .map(bucket => ({ bucket, queryCount: 6 as const, recallAt5: 0, recallAt10: 0, mrrAt10: 0 }))
}

function validReportFixture(value: Dataset): LexicalReport {
  const cases: CaseMetric[] = [
    ...value.groups.flatMap(group => group.queries.map(query => ({
      id: query.id,
      bucket: query.bucket,
      split: query.split,
      relevantIds: [...query.relevantIds],
      forbiddenIds: [],
      returnedIds: [],
      firstRelevantRank: null,
      recallAt5: 0,
      recallAt10: 0,
      reciprocalRank: 0,
      forbiddenHits: [],
    }))),
    ...value.filterQueries.map(query => ({
      id: query.id,
      bucket: 'filter' as const,
      split: 'filter' as const,
      relevantIds: [],
      forbiddenIds: [...query.forbiddenIds],
      returnedIds: [],
      firstRelevantRank: null,
      recallAt5: null,
      recallAt10: null,
      reciprocalRank: null,
      forbiddenHits: [],
    })),
  ]
  const mode = (kind: 'legacy' | 'cjk-bigram', implementation: string): ModeReport => ({
    tokenizer: { kind, implementation },
    metrics: { recallAt5: 0, recallAt10: 0, mrrAt10: 0 },
    buckets: zeroBuckets(),
    cases: structuredClone(cases),
    hardChecks: { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
  })
  return {
    schemaVersion: 1,
    dataset: { id: value.datasetId, version: value.datasetVersion, referenceCommit: value.referenceCommit },
    runner: { version: 1, repeats: 1, externalNetwork: false },
    embeddingSpace: { id: 'dsh-memory/hash-token-char-v1/256/l2', dimensions: 256 },
    modes: { legacy: mode('legacy', 'LegacyTokenizer'), cjkBigram: mode('cjk-bigram', 'CjkBigramTokenizer') },
    delta: { recallAt5: 0, recallAt10: 0, mrrAt10: 0 },
  }
}

function mutableRawCases(mode: ModeReport): MutableRawCase[] {
  return mode.cases.map(item => ({
    id: item.id,
    bucket: item.bucket,
    split: item.split,
    relevantIds: [...item.relevantIds],
    forbiddenIds: [...item.forbiddenIds],
    returnedIds: [...item.returnedIds],
    scopeLeaks: 0,
  }))
}

async function temporaryJson(value: unknown, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lexical-eval-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}
function runCli(args: readonly string[]) {
  const env = { ...process.env }
  for (const key of ['DASHSCOPE_API_URL', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) delete env[key]
  return spawnSync(process.execPath, [runnerPath, ...args], { cwd: workspace, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024 })
}
function collectKeys(value: unknown, result: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, result)
  else if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { result.push(key); collectKeys(item, result) }
  return result
}

beforeAll(() => {
  const build = spawnSync('pnpm', ['build'], { cwd: workspace, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (build.status !== 0) throw new Error(`lexical evaluation precondition build failed\n${build.stdout}\n${build.stderr}`)
}, 120_000)
afterEach(() => vi.restoreAllMocks())
afterAll(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('MEM-102 frozen lexical dataset', () => {
  it('is self-consistent with 24 scored queries, four balanced buckets, both splits, and six filter negatives', async () => {
    const value = await dataset()
    expect(value).toMatchObject({ schemaVersion: 1, datasetId: 'dsh-memory-lexical', datasetVersion: '1.0.0', referenceCommit: '2dc101db4d368866051af62d18897d6889511400' })
    expect(value.groups).toHaveLength(6)
    const queries = value.groups.flatMap(group => group.queries)
    expect(queries).toHaveLength(24)
    expect(value.filterQueries).toHaveLength(6)
    expect(value.filterRecords).toHaveLength(6)
    for (const bucket of ['continuous_cjk', 'mixed_language', 'punctuation_boundary', 'short_term'] as const) {
      const cell = queries.filter(query => query.bucket === bucket)
      expect(cell).toHaveLength(6)
      expect(new Set(cell.map(query => query.split))).toEqual(new Set(['baseline', 'holdout']))
    }
    expect(value.groups.every(group => expandedRecords(group).length === 42)).toBe(true)
    const recordIds = value.groups.flatMap(group => expandedRecords(group).map(record => record.id))
      .concat(value.filterRecords.map(record => record.id))
    const queryIds = queries.map(query => query.id).concat(value.filterQueries.map(query => query.id))
    expect(recordIds).toHaveLength(258)
    expect(new Set(recordIds).size).toBe(recordIds.length)
    expect(new Set(queryIds).size).toBe(queryIds.length)
    expect(recordIds.every(id => /^r[0-9a-f]{12}$/u.test(id))).toBe(true)
    expect(queryIds.every(id => /^q[0-9]{4}$/u.test(id))).toBe(true)
    expect(recordIds.join('\n')).not.toMatch(/rel|noise|filter|continuous|mixed|punctuation|short/iu)
    expect(new Set(value.groups.flatMap(group => Object.values(group.distractorCodes).flat())).size).toBe(216)
    expect(new Set(value.groups.flatMap(group => Object.values(group.distractorIds).flat())).size).toBe(216)

    expect(value.filterRecords[0]?.owner.userId).not.toBe('lexical-filter-user')
    expect(value.filterRecords[1]?.owner.tenantId).not.toBe('lexical-tenant')
    expect(value.filterRecords[2]?.owner.agentId).not.toBe('lexical-agent')
    expect(value.filterQueries.find(query => query.id === 'q9004')).toMatchObject({ sessionOnly: true, sessionId: 'filter-current' })
    expect(value.filterRecords[3]?.sourceSessionId).toBe('filter-old')
    expect(value.filterRecords[4]).toMatchObject({ status: 'deleted', visibility: 'source_only' })
    expect(Date.parse(value.filterRecords[5]?.validUntil ?? '')).toBeLessThan(Date.parse(value.evaluationTime))
  })

  it('keeps labels out of record content/tags and has no dangling or cross-owner relevant/forbidden reference', async () => {
    const value = await dataset()
    const contents = value.groups.flatMap(group => expandedRecords(group).map(record => record.content))
      .concat(value.filterRecords.map(record => record.content))
    const labels = [
      ...value.groups.map(group => group.id),
      ...value.groups.flatMap(group => group.queries.flatMap(query => [query.id, query.bucket, query.split, ...query.relevantIds])),
      ...value.filterQueries.flatMap(query => [query.id, ...query.forbiddenIds]),
    ]
    for (const content of contents) for (const label of labels) expect(content).not.toContain(label)
    for (const group of value.groups) {
      const ids = new Set(expandedRecords(group).map(record => record.id))
      for (const query of group.queries) for (const id of query.relevantIds) expect(ids.has(id), `${query.id} -> ${id}`).toBe(true)
    }
    const filters = new Map(value.filterRecords.map(record => [record.id, record]))
    for (const query of value.filterQueries) for (const id of query.forbiddenIds) expect(filters.has(id), `${query.id} -> ${id}`).toBe(true)
  })

  it('ships strict versioned dataset/report schemas for the compact fixture and two-mode report', async () => {
    const [datasetSchema, reportSchema] = await Promise.all([
      readFile(datasetSchemaPath, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>),
      readFile(reportSchemaPath, 'utf8').then(text => JSON.parse(text) as Record<string, unknown>),
    ])
    expect(datasetSchema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', additionalProperties: false })
    expect(reportSchema).toMatchObject({ $schema: 'https://json-schema.org/draft/2020-12/schema', additionalProperties: false })
    expect(JSON.stringify(datasetSchema)).toContain('dsh-memory-lexical')
    expect(JSON.stringify(reportSchema)).toContain('cjkBigram')
  })

  it('rejects malformed dataset roots, nested extras, missing fields, counts, enums, duplicates, and dangling references', async () => {
    const utility = await metrics()
    const value = await dataset()
    expect(() => utility.validateLexicalDataset(value)).not.toThrow()

    const rootExtra = structuredClone(value) as unknown as Record<string, unknown>
    rootExtra.unexpected = true
    const nestedExtra = structuredClone(value) as unknown as { groups: Array<Record<string, unknown>> }
    ;(nestedExtra.groups[0] as Record<string, unknown>).unexpected = true
    const missing = structuredClone(value) as unknown as Record<string, unknown>
    delete missing.evaluationTime
    const wrongCount = structuredClone(value) as unknown as { groups: unknown[] }
    wrongCount.groups.pop()
    const tooManyGroups = structuredClone(value) as unknown as {
      groups: Array<Group & {
        id: string
        owner: { userId: string }
        sourceSessionId: string
        records: Array<{ id: string }>
        sharedInterference: Array<{ id: string }>
        distractorCodes: Record<Exclude<Bucket, 'mixed_language'>, string[]>
        distractorIds: Record<Exclude<Bucket, 'mixed_language'>, string[]>
        queries: Array<{ id: string; relevantIds: string[] }>
      }>
    }
    const seventh = structuredClone(tooManyGroups.groups[0])
    if (seventh === undefined) throw new Error('missing seventh-group fixture')
    seventh.id = 'g07'
    seventh.owner.userId = 'lexical-user-07'
    seventh.sourceSessionId = 'lexical-source-07'
    const seventhIds = [...seventh.records, ...seventh.sharedInterference, ...Object.values(seventh.distractorIds).flat()]
      .map((_record, index) => `rffffffffff${String(index + 1).padStart(2, '0')}`)
    const seventhMap = new Map([
      ...seventh.records.map(record => record.id),
      ...seventh.sharedInterference.map(record => record.id),
      ...Object.values(seventh.distractorIds).flat(),
    ].map((id, index) => [id, seventhIds[index] as string]))
    for (const record of [...seventh.records, ...seventh.sharedInterference]) record.id = seventhMap.get(record.id) ?? record.id
    let seventhOffset = seventh.records.length + seventh.sharedInterference.length
    for (const bucket of ['continuous_cjk', 'punctuation_boundary', 'short_term'] as const) {
      seventh.distractorIds[bucket] = seventh.distractorIds[bucket].map(() => seventhIds[seventhOffset++] as string)
      seventh.distractorCodes[bucket] = seventh.distractorCodes[bucket].map((_code, index) => `z${bucket[0]}${String(index).padStart(3, '0')}`)
    }
    seventh.queries.forEach((query, index) => {
      query.id = `q07${String(index + 1).padStart(2, '0')}`
      query.relevantIds = query.relevantIds.map(id => seventhMap.get(id) ?? id)
    })
    tooManyGroups.groups.push(seventh)
    const tooManyFilterRecords = structuredClone(value) as unknown as { filterRecords: Array<FilterRecord> }
    tooManyFilterRecords.filterRecords.push({
      ...(structuredClone(tooManyFilterRecords.filterRecords[0]) as FilterRecord),
      id: 'rffffffffffff',
      content: '额外过滤记录只用于数量校验',
    })
    const tooManyFilterQueries = structuredClone(value) as unknown as { filterQueries: Array<FilterQuery> }
    tooManyFilterQueries.filterQueries.push({
      ...(structuredClone(tooManyFilterQueries.filterQueries[0]) as FilterQuery),
      id: 'q9999',
    })
    const wrongEnum = structuredClone(value) as unknown as { groups: Array<{ queries: Array<{ bucket: string }> }> }
    ;(wrongEnum.groups[0]?.queries[0] as { bucket: string }).bucket = 'unknown_bucket'
    const duplicateRecordId = structuredClone(value) as unknown as { groups: Array<{ distractorIds: Record<Exclude<Bucket, 'mixed_language'>, string[]> }> }
    const noiseIds = duplicateRecordId.groups[0]?.distractorIds.continuous_cjk
    if (noiseIds?.[0] === undefined) throw new Error('missing duplicate record fixture')
    noiseIds[1] = noiseIds[0]
    const duplicateQueryId = structuredClone(value) as unknown as { groups: Array<{ queries: Array<{ id: string }> }> }
    const firstQueryId = duplicateQueryId.groups[0]?.queries[0]?.id
    if (firstQueryId === undefined || duplicateQueryId.groups[0]?.queries[1] === undefined) throw new Error('missing duplicate query fixture')
    duplicateQueryId.groups[0].queries[1].id = firstQueryId
    const dangling = structuredClone(value) as unknown as { groups: Array<{ queries: Array<{ relevantIds: string[] }> }> }
    ;(dangling.groups[0]?.queries[0] as { relevantIds: string[] }).relevantIds = ['r9999']

    for (const [label, invalid] of Object.entries({
      rootExtra,
      nestedExtra,
      missing,
      wrongCount,
      tooManyGroups,
      tooManyFilterRecords,
      tooManyFilterQueries,
      wrongEnum,
      duplicateRecordId,
      duplicateQueryId,
      dangling,
    })) {
      expect(() => utility.validateLexicalDataset(invalid), label).toThrow()
    }
  })

  it('rejects malformed reports while accepting null filter scores and negative deltas', async () => {
    const utility = await metrics()
    const seed = validReportFixture(await dataset())
    const legacy = mutableRawCases(seed.modes.legacy)
    const cjkBigram = mutableRawCases(seed.modes.cjkBigram)
    const firstScored = legacy.find(item => item.bucket !== 'filter')
    const firstRelevant = firstScored?.relevantIds[0]
    if (firstScored === undefined || firstRelevant === undefined) throw new Error('missing negative-delta fixture')
    firstScored.returnedIds = [firstRelevant]
    const measured = utility.computeLexicalMetrics(legacy, cjkBigram)
    const valid: LexicalReport = { ...seed, ...measured }
    expect(valid.delta.recallAt5).toBeLessThan(0)
    expect(valid.delta.recallAt10).toBeLessThan(0)
    expect(valid.delta.mrrAt10).toBeLessThan(0)
    expect(() => utility.validateLexicalReport(valid)).not.toThrow()

    const rootExtra = structuredClone(valid) as unknown as Record<string, unknown>
    rootExtra.unexpected = true
    const nestedExtra = structuredClone(valid) as unknown as { modes: { legacy: { metrics: Record<string, unknown> } } }
    nestedExtra.modes.legacy.metrics.unexpected = true
    const missing = structuredClone(valid) as unknown as { modes: { legacy: Record<string, unknown> } }
    delete missing.modes.legacy.hardChecks
    const duplicateBucket = structuredClone(valid) as unknown as { modes: { legacy: { buckets: Array<{ bucket: string }> } } }
    const firstBucket = duplicateBucket.modes.legacy.buckets[0]
    if (firstBucket === undefined) throw new Error('missing bucket fixture')
    duplicateBucket.modes.legacy.buckets[1] = structuredClone(firstBucket)
    const wrongCaseCount = structuredClone(valid) as unknown as { modes: { legacy: { cases: Array<Record<string, unknown>> } } }
    const scoredCopy = structuredClone(wrongCaseCount.modes.legacy.cases[0])
    wrongCaseCount.modes.legacy.cases[29] = scoredCopy
    const duplicateCaseId = structuredClone(valid) as unknown as { modes: { legacy: { cases: Array<{ id: string }> }; cjkBigram: { cases: Array<{ id: string }> } } }
    const firstCaseId = duplicateCaseId.modes.legacy.cases[0]?.id
    if (firstCaseId === undefined || duplicateCaseId.modes.legacy.cases[1] === undefined) throw new Error('missing duplicate case fixture')
    duplicateCaseId.modes.legacy.cases[1].id = firstCaseId
    if (duplicateCaseId.modes.cjkBigram.cases[1] === undefined) throw new Error('missing duplicate CJK case fixture')
    duplicateCaseId.modes.cjkBigram.cases[1].id = firstCaseId
    const wrongNull = structuredClone(valid) as unknown as { modes: { legacy: { cases: Array<{ bucket: string; recallAt5: number | null }> } } }
    const filterCase = wrongNull.modes.legacy.cases.find(item => item.bucket === 'filter')
    if (filterCase === undefined) throw new Error('missing filter case fixture')
    filterCase.recallAt5 = 0
    const negativeMode = structuredClone(valid) as unknown as { modes: { legacy: { metrics: { recallAt10: number } } } }
    negativeMode.modes.legacy.metrics.recallAt10 = -0.000001
    const swapped = structuredClone(valid) as unknown as { modes: { legacy: { tokenizer: { kind: string } }; cjkBigram: { tokenizer: { kind: string } } } }
    swapped.modes.legacy.tokenizer.kind = 'cjk-bigram'
    swapped.modes.cjkBigram.tokenizer.kind = 'legacy'
    const excessiveDelta = structuredClone(valid) as unknown as { delta: { recallAt10: number } }
    excessiveDelta.delta.recallAt10 = -1.000001

    for (const [label, invalid] of Object.entries({
      rootExtra,
      nestedExtra,
      missing,
      duplicateBucket,
      wrongCaseCount,
      duplicateCaseId,
      wrongNull,
      negativeMode,
      swapped,
      excessiveDelta,
    })) {
      expect(() => utility.validateLexicalReport(invalid), label).toThrow()
    }
  })

  it('rejects forged deltas and any cross-mode case identity or label misalignment', async () => {
    const utility = await metrics()
    const frozenGates = JSON.parse(await readFile(gatesPath, 'utf8')) as unknown
    const current = await (await runner()).runLexical({ datasetPath, repeats: 1 })

    for (const key of ['recallAt5', 'recallAt10', 'mrrAt10'] as const) {
      const forged = structuredClone(current) as LexicalReport & { delta: Record<typeof key, number> }
      const original = forged.delta[key]
      forged.delta[key] = round(original < 0.999999 ? original + 0.000001 : original - 0.000001)
      expect.soft(forged.delta[key], key).not.toBe(original)
      expect.soft(() => utility.validateLexicalReport(forged), `validate forged delta.${key}`).toThrow()
      let gatePassed = false
      try { gatePassed = utility.evaluateLexicalGates(forged, frozenGates).passed } catch {}
      expect.soft(gatePassed, `gate forged delta.${key}`).toBe(false)
    }

    const legacy = mutableRawCases(current.modes.legacy)
    const mismatchMutations: Array<readonly [string, (cases: MutableRawCase[]) => void]> = [
      ['id', (cases) => {
        const item = cases[0]
        if (item === undefined) throw new Error('missing id mismatch case')
        item.id = 'q-mode-mismatch'
      }],
      ['bucket', (cases) => {
        const left = cases.find(item => item.bucket === 'continuous_cjk')
        const right = cases.find(item => item.bucket === 'mixed_language')
        if (left === undefined || right === undefined) throw new Error('missing bucket mismatch cases')
        const bucket = left.bucket
        left.bucket = right.bucket
        right.bucket = bucket
      }],
      ['split', (cases) => {
        const left = cases.find(item => item.bucket !== 'filter' && item.split === 'baseline')
        const right = cases.find(item => item.bucket !== 'filter' && item.split === 'holdout')
        if (left === undefined || right === undefined) throw new Error('missing split mismatch cases')
        const split = left.split
        left.split = right.split
        right.split = split
      }],
      ['relevantIds', (cases) => {
        const item = cases.find(candidate => candidate.bucket !== 'filter')
        if (item === undefined) throw new Error('missing relevant mismatch case')
        item.relevantIds = ['rffffffffffff']
      }],
      ['forbiddenIds', (cases) => {
        const item = cases.find(candidate => candidate.bucket === 'filter')
        if (item === undefined) throw new Error('missing forbidden mismatch case')
        item.forbiddenIds = ['rffffffffffff']
      }],
    ]
    for (const [label, mutate] of mismatchMutations) {
      const cjkBigram = mutableRawCases(current.modes.cjkBigram)
      mutate(cjkBigram)
      const measured = utility.computeLexicalMetrics(legacy, cjkBigram)
      const forged: LexicalReport = { ...structuredClone(current), ...measured }
      expect.soft(() => utility.validateLexicalReport(forged), `cross-mode ${label}`).toThrow()
    }
  }, 120_000)

  it('has independently simulated legacy headroom and meets every frozen bigram candidate threshold', async () => {
    const value = await dataset()
    const legacy = oracleMetrics(value, legacyTokens)
    const cjk = oracleMetrics(value, bigramTokens)
    expect(legacy.metrics).toEqual({ recallAt5: 0.25, recallAt10: 0.25, mrrAt10: 0.25 })
    expect(cjk.metrics).toEqual({ recallAt5: 1, recallAt10: 1, mrrAt10: 0.979167 })
    expect(cjk.metrics.recallAt10).toBeGreaterThanOrEqual(0.9)
    expect(cjk.metrics.mrrAt10).toBeGreaterThanOrEqual(0.75)
    expect(cjk.metrics.recallAt10 - legacy.metrics.recallAt10).toBeGreaterThanOrEqual(0.2)
    expect(cjk.metrics.mrrAt10 - legacy.metrics.mrrAt10).toBeGreaterThanOrEqual(0.15)
    expect(Object.values(cjk.buckets).every(cell => cell.recallAt10 >= 0.833333)).toBe(true)
    expect(legacy.metrics.recallAt10).toBeGreaterThan(0)
    expect(legacy.metrics.recallAt10).toBeLessThanOrEqual(0.7)
    expect(legacy.metrics.mrrAt10).toBeGreaterThan(0)
    expect(legacy.metrics.mrrAt10).toBeLessThanOrEqual(0.65)
  })
})

describe('MEM-102 lexical metrics and runner anti-hardcode contract', () => {
  it('independently recomputes macro Recall/MRR, delta, and hard checks from returned IDs', async () => {
    const raw: RawCase[] = [
      { id: 'a', bucket: 'continuous_cjk', split: 'baseline', relevantIds: ['r1', 'r2'], forbiddenIds: ['f'], returnedIds: ['x', 'r1', 'r1', 'f'], scopeLeaks: 1 },
      { id: 'b', bucket: 'continuous_cjk', split: 'holdout', relevantIds: ['r3'], forbiddenIds: [], returnedIds: [], scopeLeaks: 0 },
      { id: 'c', bucket: 'mixed_language', split: 'baseline', relevantIds: ['r4'], forbiddenIds: [], returnedIds: ['r4'], scopeLeaks: 0 },
      { id: 'd', bucket: 'punctuation_boundary', split: 'baseline', relevantIds: ['r5'], forbiddenIds: [], returnedIds: ['x', 'r5'], scopeLeaks: 0 },
      { id: 'e', bucket: 'short_term', split: 'baseline', relevantIds: ['r6'], forbiddenIds: [], returnedIds: ['r6'], scopeLeaks: 0 },
      { id: 'filter', bucket: 'filter', split: 'filter', relevantIds: [], forbiddenIds: ['blocked'], returnedIds: [], scopeLeaks: 0 },
    ]
    const changed = structuredClone(raw)
    changed[0] = { ...(changed[0] as RawCase), returnedIds: ['r1', 'r2'] }
    const measured = (await metrics()).computeLexicalMetrics(raw, changed)
    expect(measured.modes.legacy.hardChecks).toEqual({ scopeLeaks: 1, forbiddenHits: 1, duplicateResultIds: 1 })
    expect(measured.modes.legacy.cases[0]).toMatchObject({ firstRelevantRank: 2, recallAt5: 0.5, recallAt10: 0.5, reciprocalRank: 0.5 })
    expect(measured.modes.cjkBigram.cases[0]).toMatchObject({ firstRelevantRank: 1, recallAt10: 1, reciprocalRank: 1 })
    expect(measured.modes.legacy.cases.find(item => item.id === 'filter')).toMatchObject({
      firstRelevantRank: null,
      recallAt5: null,
      recallAt10: null,
      reciprocalRank: null,
    })
    expect(measured.modes.legacy.metrics).toEqual({ recallAt5: 0.7, recallAt10: 0.7, mrrAt10: 0.6 })
    expect(measured.modes.cjkBigram.metrics).toEqual({ recallAt5: 0.8, recallAt10: 0.8, mrrAt10: 0.7 })
    expect(measured.modes.legacy.buckets).toEqual([
      { bucket: 'continuous_cjk', queryCount: 2, recallAt5: 0.25, recallAt10: 0.25, mrrAt10: 0.25 },
      { bucket: 'mixed_language', queryCount: 1, recallAt5: 1, recallAt10: 1, mrrAt10: 1 },
      { bucket: 'punctuation_boundary', queryCount: 1, recallAt5: 1, recallAt10: 1, mrrAt10: 0.5 },
      { bucket: 'short_term', queryCount: 1, recallAt5: 1, recallAt10: 1, mrrAt10: 1 },
    ])
    expect(measured.delta).toEqual({ recallAt5: 0.1, recallAt10: 0.1, mrrAt10: 0.1 })
  })

  it('uses public import/search for both modes without add, private ranking, credentials, or network', async () => {
    const module = await built()
    const imported = new Map<string, MemoryRecord[]>()
    const searched = new Map<string, SearchMemoryInput[]>()
    const originalImport = module.default.prototype.import
    const originalSearch = module.default.prototype.search
    const importSpy = vi.spyOn(module.default.prototype, 'import').mockImplementation(async function (this: BuiltPrototype, scope, records) {
      const kind = this.config.tokenizer.kind
      imported.set(kind, [...imported.get(kind) ?? [], ...structuredClone(records)])
      return await originalImport.call(this, scope, records)
    })
    const searchSpy = vi.spyOn(module.default.prototype, 'search').mockImplementation(async function (this: BuiltPrototype, input, signal) {
      const kind = this.config.tokenizer.kind
      searched.set(kind, [...searched.get(kind) ?? [], structuredClone(input)])
      return await originalSearch.call(this, input, signal)
    })
    const addSpy = vi.spyOn(module.default.prototype, 'add')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('lexical runner attempted network') })
    const report = await (await runner()).runLexical({ datasetPath, repeats: 1 })
    const value = await dataset()
    const expectedRecords = new Map<string, {
      owner: Owner
      sourceSessionId: string
      content: string
      status: 'active' | 'deleted'
      visibility: 'recallable' | 'source_only'
      validUntil?: string
    }>()
    for (const group of value.groups) for (const fixture of expandedRecords(group)) {
      expectedRecords.set(fixture.id, {
        owner: group.owner,
        sourceSessionId: group.sourceSessionId,
        content: fixture.content,
        status: 'active',
        visibility: 'recallable',
      })
    }
    for (const fixture of value.filterRecords) expectedRecords.set(fixture.id, fixture)

    expect(report.modes.legacy.cases).toHaveLength(30)
    expect(report.modes.cjkBigram.cases).toHaveLength(30)
    for (const mode of Object.values(report.modes)) {
      const scored = mode.cases.filter(item => item.bucket !== 'filter')
      const filters = mode.cases.filter(item => item.bucket === 'filter')
      expect(scored).toHaveLength(24)
      expect(filters).toHaveLength(6)
      expect(scored.every(item => typeof item.recallAt5 === 'number'
        && typeof item.recallAt10 === 'number' && typeof item.reciprocalRank === 'number')).toBe(true)
      expect(filters.every(item => item.firstRelevantRank === null && item.recallAt5 === null
        && item.recallAt10 === null && item.reciprocalRank === null)).toBe(true)
      expect(mode.metrics).toEqual({
        recallAt5: round(scored.reduce((sum, item) => sum + (item.recallAt5 ?? 0), 0) / 24),
        recallAt10: round(scored.reduce((sum, item) => sum + (item.recallAt10 ?? 0), 0) / 24),
        mrrAt10: round(scored.reduce((sum, item) => sum + (item.reciprocalRank ?? 0), 0) / 24),
      })
    }
    expect(importSpy).toHaveBeenCalledTimes(new Set([...expectedRecords.values()].map(item => ownerKey(item.owner))).size * 2)
    expect(searchSpy).toHaveBeenCalledTimes(60)
    for (const kind of ['legacy', 'cjk-bigram'] as const) {
      const records = imported.get(kind) ?? []
      expect(records, `${kind} imports`).toHaveLength(258)
      expect(new Set(records.map(record => record.id))).toEqual(new Set(expectedRecords.keys()))
      for (const actual of records) {
        const expected = expectedRecords.get(actual.id)
        expect(expected, actual.id).toBeDefined()
        if (expected === undefined) continue
        expect(actual.scope).toEqual({ ...expected.owner, sessionId: expected.sourceSessionId })
        expect(actual).toMatchObject({
          id: actual.id,
          layer: 'l2_fact',
          content: expected.content,
          status: expected.status,
          visibility: expected.visibility,
          sourceSessionId: expected.sourceSessionId,
          tags: [],
          meta: {},
          embedding: { spaceId: 'dsh-memory/hash-token-char-v1/256/l2', dimensions: 256 },
        })
        expect(actual.validUntil).toBe(expected.validUntil)
        expect(actual.embedding.vector).toEqual(hashOracle(expected.content))
      }
      const calls = searched.get(kind) ?? []
      expect(calls, `${kind} searches`).toHaveLength(30)
      const expectedQueries = [
        ...value.groups.flatMap(group => group.queries.map(query => ({
          query: query.query,
          scope: { ...group.owner, sessionId: group.sourceSessionId },
          sessionOnly: false,
        }))),
        ...value.filterQueries.map(query => ({
          query: query.query,
          scope: { ...query.owner, sessionId: query.sessionId },
          sessionOnly: query.sessionOnly,
        })),
      ]
      expect(calls.map(call => ({ query: call.query, scope: call.scope, sessionOnly: call.sessionOnly ?? false })))
        .toEqual(expectedQueries)
    }
    expect(addSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  }, 120_000)

  it('keeps returned IDs independent of relevant/forbidden labels while allowing only scores to change', async () => {
    const api = await runner()
    const original = await api.runLexical({ datasetPath, repeats: 1 })
    const relabeled = structuredClone(await dataset()) as Dataset & { groups: Group[] }
    const group = relabeled.groups[0]
    const query = group?.queries[0]
    if (group === undefined || query === undefined) throw new Error('missing relabel fixture')
    ;(group.queries as ScoredQuery[])[0] = { ...query, relevantIds: [noiseId(group, 'continuous_cjk', 9)] }
    const relabeledPath = await temporaryJson(relabeled, 'cases.json')
    const changed = await api.runLexical({ datasetPath: relabeledPath, repeats: 1 })
    for (const mode of ['legacy', 'cjkBigram'] as const) {
      const before = original.modes[mode].cases.find(item => item.id === query.id)
      const after = changed.modes[mode].cases.find(item => item.id === query.id)
      expect(after?.returnedIds).toEqual(before?.returnedIds)
      expect([before?.recallAt10, after?.recallAt10]).toEqual(mode === 'legacy' ? [0, 1] : [1, 0])
    }

    const filterCase = original.modes.cjkBigram.cases.find(item => item.bucket === 'filter' && item.returnedIds.length > 0)
    if (filterCase === undefined) throw new Error('filter fixture must expose one allowed same-owner distractor')
    const returnedId = filterCase.returnedIds[0]
    if (returnedId === undefined) throw new Error('missing allowed filter distractor')
    const forbiddenRelabeled = structuredClone(await dataset()) as Dataset & { filterQueries: FilterQuery[] }
    const filterIndex = forbiddenRelabeled.filterQueries.findIndex(item => item.id === filterCase.id)
    const filterQuery = forbiddenRelabeled.filterQueries[filterIndex]
    if (filterQuery === undefined) throw new Error('missing forbidden relabel query')
    forbiddenRelabeled.filterQueries[filterIndex] = { ...filterQuery, forbiddenIds: [returnedId] }
    const forbiddenPath = await temporaryJson(forbiddenRelabeled, 'forbidden-cases.json')
    const forbiddenChanged = await api.runLexical({ datasetPath: forbiddenPath, repeats: 1 })
    for (const mode of ['legacy', 'cjkBigram'] as const) {
      const before = original.modes[mode].cases.find(item => item.id === filterCase.id)
      const after = forbiddenChanged.modes[mode].cases.find(item => item.id === filterCase.id)
      expect(after?.returnedIds).toEqual(before?.returnedIds)
    }
    expect(forbiddenChanged.modes.cjkBigram.hardChecks.forbiddenHits)
      .toBeGreaterThan(original.modes.cjkBigram.hardChecks.forbiddenHits)
    const frozenGates = JSON.parse(await readFile(gatesPath, 'utf8')) as unknown
    const forbiddenGateResult = (await metrics()).evaluateLexicalGates(forbiddenChanged, frozenGates)
    expect(forbiddenGateResult.passed).toBe(false)
    expect(forbiddenGateResult.failures.join('\n')).toContain('forbiddenHits')
    const forbiddenCli = runCli(['--dataset', forbiddenPath, '--baseline', baselinePath, '--gates', gatesPath, '--repeat', '1'])
    expect(forbiddenCli.status).toBe(2)
  }, 120_000)

  it('keeps every returned order invariant under an equivalent opaque rewrite of all 258 record IDs', async () => {
    const api = await runner()
    const utility = await metrics()
    const originalDataset = await dataset()
    const originalReport = await api.runLexical({ datasetPath, repeats: 1 })
    const rewritten = structuredClone(originalDataset) as unknown as {
      groups: Array<{
        records: Array<{ id: string }>
        sharedInterference: Array<{ id: string }>
        distractorIds: Record<Exclude<Bucket, 'mixed_language'>, string[]>
        queries: Array<{ relevantIds: string[] }>
      }>
      filterRecords: Array<{ id: string }>
      filterQueries: Array<{ forbiddenIds: string[] }>
    }
    const allIds = originalDataset.groups.flatMap(group => expandedRecords(group).map(record => record.id))
      .concat(originalDataset.filterRecords.map(record => record.id))
    const idMap = new Map(allIds.map((id, index) => [id, allIds[(index + 73) % allIds.length] as string]))
    for (const group of rewritten.groups) {
      for (const record of [...group.records, ...group.sharedInterference]) record.id = idMap.get(record.id) ?? record.id
      for (const bucket of ['continuous_cjk', 'punctuation_boundary', 'short_term'] as const) {
        group.distractorIds[bucket] = group.distractorIds[bucket].map(id => idMap.get(id) ?? id)
      }
    }
    for (const record of rewritten.filterRecords) record.id = idMap.get(record.id) ?? record.id
    for (const group of rewritten.groups) for (const query of group.queries) {
      query.relevantIds = query.relevantIds.map(id => idMap.get(id) ?? id)
    }
    for (const query of rewritten.filterQueries) query.forbiddenIds = query.forbiddenIds.map(id => idMap.get(id) ?? id)
    expect(idMap.size).toBe(258)
    expect([...idMap].every(([before, after]) => before !== after)).toBe(true)
    const originalRelevant = new Set(originalDataset.groups.flatMap(group => group.queries.flatMap(query => query.relevantIds)))
    const originalNoise = new Set(originalDataset.groups.flatMap(group => [
      ...group.sharedInterference.map(record => record.id),
      ...Object.values(group.distractorIds).flat(),
    ]))
    const originalFilter = new Set(originalDataset.filterRecords.map(record => record.id))
    expect([...originalRelevant].map(id => idMap.get(id)).some(id => id !== undefined && originalNoise.has(id))).toBe(true)
    expect([...originalFilter].map(id => idMap.get(id)).every(id => id !== undefined && originalNoise.has(id))).toBe(true)
    expect([...idMap.values()].every(id => /^r[0-9a-f]{12}$/u.test(id))).toBe(true)
    const roleShapes = [originalRelevant, originalNoise, originalFilter].map(ids =>
      new Set([...ids].map(id => id.replace(/[0-9a-f]/gu, 'x'))))
    expect(roleShapes).toEqual([new Set(['rxxxxxxxxxxxx']), new Set(['rxxxxxxxxxxxx']), new Set(['rxxxxxxxxxxxx'])])
    expect(() => utility.validateLexicalDataset(rewritten)).not.toThrow()

    const rewrittenPath = await temporaryJson(rewritten, 'opaque-cases.json')
    const rewrittenReport = await api.runLexical({ datasetPath: rewrittenPath, repeats: 1 })
    const inverse = new Map([...idMap].map(([before, after]) => [after, before]))
    for (const kind of ['legacy', 'cjkBigram'] as const) {
      for (const before of originalReport.modes[kind].cases) {
        const after = rewrittenReport.modes[kind].cases.find(item => item.id === before.id)
        expect(after?.returnedIds.map(id => inverse.get(id) ?? id), `${kind}:${before.id}`).toEqual(before.returnedIds)
      }
    }
  }, 120_000)

  it('derives case order and aggregate metrics from a patched public search result', async () => {
    const module = await built()
    const originalSearch = module.default.prototype.search
    const baseline = await (await runner()).runLexical({ datasetPath, repeats: 1 })
    vi.spyOn(module.default.prototype, 'search').mockImplementation(async function (this: BuiltPrototype, input, signal) {
      const result = await originalSearch.call(this, input, signal)
      if (input.query !== 'API接口校验') return result
      return { ...result, channels: { ...result.channels, normal: [...result.channels.normal].reverse() } }
    })
    const patched = await (await runner()).runLexical({ datasetPath, repeats: 1 })
    const before = baseline.modes.cjkBigram.cases.find(item => item.id === 'q0102')
    const after = patched.modes.cjkBigram.cases.find(item => item.id === 'q0102')
    expect(after?.returnedIds).toEqual([...(before?.returnedIds ?? [])].reverse())
    expect(after?.reciprocalRank).not.toBe(before?.reciprocalRank)
    expect(patched.modes.cjkBigram.metrics.mrrAt10).not.toBe(baseline.modes.cjkBigram.metrics.mrrAt10)
  }, 120_000)

  it('derives duplicate and scope-leak hard checks from patched foreign and hidden public hits', async () => {
    const module = await built()
    const originalSearch = module.default.prototype.search
    const baseline = await (await runner()).runLexical({ datasetPath, repeats: 1 })
    vi.spyOn(module.default.prototype, 'search').mockImplementation(async function (this: BuiltPrototype, input, signal) {
      const result = await originalSearch.call(this, input, signal)
      if (input.query !== '数据备份') return result
      const first = result.channels.normal[0]
      if (first === undefined) throw new Error('hard-check patch requires one public hit')
      const foreign = {
        ...first,
        memory: {
          ...first.memory,
          id: 'r8801',
          scope: { ...first.memory.scope, userId: 'foreign-patched-user' },
        },
      }
      const hidden = {
        ...first,
        memory: { ...first.memory, id: 'r8802', visibility: 'source_only' as const },
      }
      return {
        ...result,
        channels: { ...result.channels, normal: [first, first, foreign, hidden, ...result.channels.normal.slice(1)] },
      } as SearchResult
    })
    const patched = await (await runner()).runLexical({ datasetPath, repeats: 1 })
    for (const kind of ['legacy', 'cjkBigram'] as const) {
      expect(patched.modes[kind].hardChecks.duplicateResultIds)
        .toBeGreaterThan(baseline.modes[kind].hardChecks.duplicateResultIds)
      expect(patched.modes[kind].hardChecks.scopeLeaks)
        .toBeGreaterThanOrEqual(baseline.modes[kind].hardChecks.scopeLeaks + 2)
    }
    const frozenGates = JSON.parse(await readFile(gatesPath, 'utf8')) as unknown
    const gateResult = (await metrics()).evaluateLexicalGates(patched, frozenGates)
    expect(gateResult.passed).toBe(false)
    expect(gateResult.failures.join('\n')).toContain('scopeLeaks')
    expect(gateResult.failures.join('\n')).toContain('duplicateResultIds')
  }, 120_000)

  it('uses fresh MemoryService instances for every repeat and emits byte-identical canonical reports', async () => {
    const module = await built()
    const receivers = new Set<unknown>()
    const originalImport = module.default.prototype.import
    vi.spyOn(module.default.prototype, 'import').mockImplementation(async function (this: BuiltPrototype, scope, records) {
      receivers.add(this)
      return await originalImport.call(this, scope, records)
    })
    const api = await runner()
    const report = await api.runLexical({ datasetPath, repeats: 2 })
    const again = await api.runLexical({ datasetPath, repeats: 2 })
    const canonical = (await metrics()).canonicalJson
    expect(receivers.size).toBeGreaterThanOrEqual(8)
    expect(canonical(again)).toBe(canonical(report))
  }, 120_000)

  it('freezes the repeat=2 canonical public-runner report as the real legacy baseline', async () => {
    const api = await runner()
    const utility = await metrics()
    const [baseline, current] = await Promise.all([
      readFile(baselinePath, 'utf8').then(text => JSON.parse(text) as LexicalReport),
      api.runLexical({ datasetPath, repeats: 2 }),
    ])
    expect(() => utility.validateLexicalReport(baseline)).not.toThrow()
    expect(utility.canonicalJson(current)).toBe(utility.canonicalJson(baseline))
    expect(baseline.modes.legacy.metrics).toEqual({ recallAt5: 0.25, recallAt10: 0.25, mrrAt10: 0.25 })
    expect(baseline.modes.cjkBigram.metrics).toEqual({ recallAt5: 1, recallAt10: 1, mrrAt10: 0.979167 })
  }, 120_000)

  it('freezes the candidate quality/headroom limits and zero-tolerance hard gates without weakening them', async () => {
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as LexicalReport
    const gates = JSON.parse(await readFile(gatesPath, 'utf8')) as unknown
    expect(gates).toEqual({
      schemaVersion: 1,
      dataset: baseline.dataset,
      quality: {
        cjkRecallAt10Floor: 0.9,
        cjkMrrAt10Floor: 0.75,
        recallAt10DeltaFloor: 0.2,
        mrrAt10DeltaFloor: 0.15,
        bucketRecallAt10Floor: 0.833333,
        legacyRecallAt10MinimumExclusive: 0,
        legacyRecallAt10Maximum: 0.7,
        legacyMrrAt10MinimumExclusive: 0,
        legacyMrrAt10Maximum: 0.65,
      },
      hardChecks: { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
    })
  })

  it('emits no request IDs, time, temp path, secret, exception text, or complete vectors', async () => {
    const report = await (await runner()).runLexical({ datasetPath, repeats: 1 })
    const text = (await metrics()).canonicalJson(report)
    const keys = collectKeys(report)
    expect(keys).not.toContain('requestId')
    expect(keys).not.toContain('generatedAt')
    expect(keys).not.toContain('vector')
    expect(text).not.toMatch(/dsh-memory-lexical-eval-|\/tmp\/|api.?key|authorization|bearer|secret|exception|stack/iu)
  }, 120_000)
})

describe('MEM-102 lexical CLI, gates, and production isolation', () => {
  it('maps success, invalid runtime input, and a completed quality miss to exits 0, 1, and 2', async () => {
    const success = runCli(['--dataset', datasetPath, '--baseline', baselinePath, '--gates', gatesPath, '--repeat', '2'])
    expect(success.status).toBe(0)
    expect(success.stderr).toBe('')
    const invalid = runCli(['--dataset', '/definitely/missing/lexical-cases.json', '--repeat', '1', '--report-only'])
    expect(invalid.status).toBe(1)
    expect(invalid.stdout).toBe('')

    const invalidGates = JSON.parse(await readFile(gatesPath, 'utf8')) as { quality: { cjkRecallAt10Floor: unknown } }
    invalidGates.quality.cjkRecallAt10Floor = 'not-a-number'
    const invalidGatesPath = await temporaryJson(invalidGates, 'invalid-gates.json')
    const invalidGateResult = runCli(['--dataset', datasetPath, '--baseline', baselinePath, '--gates', invalidGatesPath, '--repeat', '1'])
    expect(invalidGateResult.status).toBe(1)
    expect(invalidGateResult.stdout).toBe('')

    const validGates = JSON.parse(await readFile(gatesPath, 'utf8')) as { hardChecks: Record<string, number> }
    for (const [index, [key, invalidValue]] of [
      ['scopeLeaks', -1],
      ['scopeLeaks', 0.5],
      ['forbiddenHits', -1],
      ['forbiddenHits', 0.5],
      ['duplicateResultIds', -1],
      ['duplicateResultIds', 0.5],
    ].entries()) {
      const invalidHardGates = structuredClone(validGates)
      invalidHardGates.hardChecks[key as string] = invalidValue as number
      const invalidHardPath = await temporaryJson(invalidHardGates, `invalid-hard-gates-${index}.json`)
      const invalidHardResult = runCli(['--dataset', datasetPath, '--baseline', baselinePath, '--gates', invalidHardPath, '--repeat', '1'])
      expect(invalidHardResult.status, `${String(key)}=${String(invalidValue)}`).toBe(1)
      expect(invalidHardResult.stdout).toBe('')
    }

    const gates = JSON.parse(await readFile(gatesPath, 'utf8')) as { quality: { cjkRecallAt10Floor: number } }
    gates.quality.cjkRecallAt10Floor = 1.000001
    const raisedPath = await temporaryJson(gates, 'gates.json')
    const failed = runCli(['--dataset', datasetPath, '--baseline', baselinePath, '--gates', raisedPath, '--repeat', '1'])
    expect(failed.status).toBe(2)
    expect(() => JSON.parse(failed.stdout) as unknown).not.toThrow()
  }, 120_000)

  it('binds baseline provenance, dataset, embedding space, and the complete legacy mode without pinning CJK output', async () => {
    const utility = await metrics()
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as LexicalReport
    const invalidProvenance: Array<readonly [string, (copy: LexicalReport) => void]> = [
      ['runner repeats', (copy) => { (copy.runner as { repeats: number }).repeats = 1 }],
      ['runner version', (copy) => { (copy.runner as { version: number }).version = 2 }],
      ['external network', (copy) => { (copy.runner as { externalNetwork: boolean }).externalNetwork = true }],
      ['legacy tokenizer provenance', (copy) => {
        (copy.modes.legacy.tokenizer as { implementation: string }).implementation = 'ForgedLegacyTokenizer'
      }],
      ['CJK tokenizer provenance', (copy) => {
        (copy.modes.cjkBigram.tokenizer as { implementation: string }).implementation = 'ForgedCjkTokenizer'
      }],
      ['embedding space', (copy) => {
        (copy.embeddingSpace as { id: string }).id = 'forged/hash-space/256/l2'
      }],
      ['dataset provenance', (copy) => {
        (copy.dataset as { referenceCommit: string }).referenceCommit = 'a'.repeat(40)
      }],
    ]
    for (const [index, [label, mutate]] of invalidProvenance.entries()) {
      const forged = structuredClone(baseline)
      mutate(forged)
      const path = await temporaryJson(forged, `forged-baseline-provenance-${index}.json`)
      const result = runCli(['--dataset', datasetPath, '--baseline', path, '--gates', gatesPath, '--repeat', '1'])
      expect.soft(result.status, `${label}: ${result.stderr}`).toBe(1)
      if (result.status === 1) {
        expect.soft(result.stdout, label).toBe('')
        expect.soft(result.stderr, label).toMatch(/lexical: invalid baseline:/i)
      }
    }

    const legacyRaw = mutableRawCases(baseline.modes.legacy)
    const cjkRaw = mutableRawCases(baseline.modes.cjkBigram)
    const legacyHit = legacyRaw.find(item => item.bucket !== 'filter'
      && item.returnedIds.some(id => item.relevantIds.includes(id)))
    if (legacyHit === undefined) throw new Error('baseline must contain a measurable legacy hit')
    legacyHit.returnedIds = []
    const changedLegacyMetrics = utility.computeLexicalMetrics(legacyRaw, cjkRaw)
    const forgedLegacyMetrics: LexicalReport = { ...structuredClone(baseline), ...changedLegacyMetrics }
    expect(() => utility.validateLexicalReport(forgedLegacyMetrics)).not.toThrow()
    expect(forgedLegacyMetrics.modes.legacy.metrics).not.toEqual(baseline.modes.legacy.metrics)
    const forgedLegacyMetricsPath = await temporaryJson(forgedLegacyMetrics, 'forged-baseline-legacy-metrics.json')
    const metricsRegression = runCli([
      '--dataset', datasetPath, '--baseline', forgedLegacyMetricsPath, '--gates', gatesPath, '--repeat', '1',
    ])
    expect.soft(metricsRegression.status, metricsRegression.stderr).toBe(2)
    expect.soft(() => JSON.parse(metricsRegression.stdout) as unknown).not.toThrow()

    const reorderedLegacyCases = structuredClone(baseline)
    for (const mode of Object.values(reorderedLegacyCases.modes)) {
      const cases = mode.cases as CaseMetric[]
      const first = cases[0]
      const second = cases[1]
      if (first === undefined || second === undefined) throw new Error('baseline must contain reorderable cases')
      cases[0] = second
      cases[1] = first
    }
    expect(() => utility.validateLexicalReport(reorderedLegacyCases)).not.toThrow()
    expect(reorderedLegacyCases.modes.legacy.cases).not.toEqual(baseline.modes.legacy.cases)
    const reorderedPath = await temporaryJson(reorderedLegacyCases, 'forged-baseline-legacy-cases.json')
    const casesRegression = runCli(['--dataset', datasetPath, '--baseline', reorderedPath, '--gates', gatesPath, '--repeat', '1'])
    expect.soft(casesRegression.status, casesRegression.stderr).toBe(2)
    expect.soft(() => JSON.parse(casesRegression.stdout) as unknown).not.toThrow()

    const changedLegacyHardCheck = structuredClone(baseline)
    ;(changedLegacyHardCheck.modes.legacy.hardChecks as { scopeLeaks: number }).scopeLeaks = 1
    expect(() => utility.validateLexicalReport(changedLegacyHardCheck)).not.toThrow()
    const hardCheckPath = await temporaryJson(changedLegacyHardCheck, 'forged-baseline-legacy-hard-check.json')
    const hardCheckRegression = runCli(['--dataset', datasetPath, '--baseline', hardCheckPath, '--gates', gatesPath, '--repeat', '1'])
    expect.soft(hardCheckRegression.status, hardCheckRegression.stderr).toBe(2)
    expect.soft(() => JSON.parse(hardCheckRegression.stdout) as unknown).not.toThrow()

    const alternativeCjkRaw = mutableRawCases(baseline.modes.cjkBigram)
    const cjkHit = alternativeCjkRaw.find(item => item.bucket !== 'filter'
      && item.returnedIds.some(id => item.relevantIds.includes(id)))
    if (cjkHit === undefined) throw new Error('baseline must contain a measurable CJK hit')
    cjkHit.returnedIds = []
    const changedCjkMetrics = utility.computeLexicalMetrics(mutableRawCases(baseline.modes.legacy), alternativeCjkRaw)
    const alternativeCjkBaseline: LexicalReport = { ...structuredClone(baseline), ...changedCjkMetrics }
    expect(() => utility.validateLexicalReport(alternativeCjkBaseline)).not.toThrow()
    expect(utility.canonicalJson(alternativeCjkBaseline.modes.legacy))
      .toBe(utility.canonicalJson(baseline.modes.legacy))
    expect(alternativeCjkBaseline.modes.cjkBigram).not.toEqual(baseline.modes.cjkBigram)
    const alternativeCjkPath = await temporaryJson(alternativeCjkBaseline, 'alternative-baseline-cjk.json')
    const unpinnedCjk = runCli(['--dataset', datasetPath, '--baseline', alternativeCjkPath, '--gates', gatesPath, '--repeat', '1'])
    expect.soft(unpinnedCjk.status, unpinnedCjk.stderr).toBe(0)
    expect.soft(unpinnedCjk.stderr).toBe('')
  }, 120_000)

  it('uses every supplied quality/headroom/bucket/hard gate rather than compiled constants', async () => {
    const gates = JSON.parse(await readFile(gatesPath, 'utf8')) as {
      quality: Record<string, number>
      hardChecks: Record<string, number>
    }
    const mutations: Array<(copy: typeof gates) => void> = [
      copy => { copy.quality.cjkRecallAt10Floor = 1.000001 },
      copy => { copy.quality.cjkMrrAt10Floor = 0.979168 },
      copy => { copy.quality.recallAt10DeltaFloor = 0.750001 },
      copy => { copy.quality.mrrAt10DeltaFloor = 0.729168 },
      copy => { copy.quality.bucketRecallAt10Floor = 1.000001 },
      copy => { copy.quality.legacyRecallAt10MinimumExclusive = 0.250001 },
      copy => { copy.quality.legacyRecallAt10Maximum = 0.249999 },
      copy => { copy.quality.legacyMrrAt10MinimumExclusive = 0.250001 },
      copy => { copy.quality.legacyMrrAt10Maximum = 0.249999 },
    ]
    expect(mutations).toHaveLength(9)
    for (const [index, mutate] of mutations.entries()) {
      const copy = structuredClone(gates)
      mutate(copy)
      const path = await temporaryJson(copy, `gates-${index}.json`)
      const result = runCli(['--dataset', datasetPath, '--baseline', baselinePath, '--gates', path, '--repeat', '1'])
      expect(result.status, `mutation ${index}: ${result.stderr}`).toBe(2)
    }
  }, 120_000)

  it('wires build, fixed dataset, baseline, gates, and repeat=2 into eval:lexical', async () => {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts?: Record<string, string> }
    const script = manifest.scripts?.['eval:lexical']
    expect(script).toBe('pnpm run build && node evaluation/run-lexical.mjs --dataset evaluation/lexical/v1/cases.json --baseline evaluation/lexical/v1/baseline.hash-legacy-v1.json --gates evaluation/lexical/v1/gates.json --repeat 2')
    expect(script).not.toMatch(/API[_-]?KEY|TOKEN|SECRET|allow-network/iu)
  })

  it('runs the public embedding evaluator with actual service instances configured in legacy mode', async () => {
    const module = await built()
    const kinds: unknown[] = []
    const originalImport = module.default.prototype.import
    const originalSearch = module.default.prototype.search
    vi.spyOn(module.default.prototype, 'import').mockImplementation(async function (this: BuiltPrototype, scope, records) {
      kinds.push((this.config as unknown as { tokenizer?: { kind?: unknown } }).tokenizer?.kind)
      return await originalImport.call(this, scope, records)
    })
    vi.spyOn(module.default.prototype, 'search').mockImplementation(async function (this: BuiltPrototype, input, signal) {
      kinds.push((this.config as unknown as { tokenizer?: { kind?: unknown } }).tokenizer?.kind)
      return await originalSearch.call(this, input, signal)
    })
    const embeddingRunner = await import(/* @vite-ignore */ embeddingRunnerUrl.href) as {
      runEmbedding(options: { datasetPath: string; repeats: number; mode: 'offline-hash' }): Promise<unknown>
    }
    await embeddingRunner.runEmbedding({ datasetPath: embeddingDatasetPath, repeats: 1, mode: 'offline-hash' })
    expect(kinds.length).toBeGreaterThan(0)
    expect(new Set(kinds)).toEqual(new Set(['legacy']))
  }, 120_000)

  it('prevents production source from reading lexical labels or importing the lexical dataset', async () => {
    const sourceRoot = fileURLToPath(new URL('../src', import.meta.url))
    const files = (await readdir(sourceRoot)).filter(name => name.endsWith('.ts'))
    const source = (await Promise.all(files.map(name => readFile(join(sourceRoot, name), 'utf8')))).join('\n')
    const value = await dataset()
    const materializedIds = value.groups.flatMap(group => expandedRecords(group).map(record => record.id))
      .concat(value.filterRecords.map(record => record.id))
    const labels = [
      value.datasetId,
      ...materializedIds,
      ...value.groups.map(group => group.id),
      ...value.groups.flatMap(group => group.queries.flatMap(query => [query.id, query.bucket, query.split, ...query.relevantIds])),
      ...value.filterQueries.flatMap(query => [query.id, ...query.forbiddenIds]),
      'continuous_cjk',
      'mixed_language',
      'punctuation_boundary',
      'short_term',
      'baseline',
      'holdout',
      'relevantIds',
      'forbiddenIds',
    ]
    expect(source).not.toMatch(/evaluation\/lexical|cases\.json|baseline\.hash-legacy-v1|gates\.json/u)
    for (const label of labels) expect(source).not.toContain(label)
  })
})
