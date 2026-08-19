import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AddMemoryInput,
  MemoryRecord,
  MemoryScope,
  SearchMemoryInput,
  SearchResult,
  WriteReceipt,
} from '../src/types.ts'

interface OwnerFixture {
  readonly tenantId?: string
  readonly userId: string
  readonly agentId: string
}

interface RecordFixture {
  readonly id: string
  readonly owner: OwnerFixture
  readonly sourceSessionId: string
  readonly layer: string
  readonly content: string
  readonly tags: readonly string[]
  readonly status: string
  readonly visibility: string
  readonly validFrom?: string
  readonly validUntil?: string
}

interface QueryFixture {
  readonly id: string
  readonly corpusId: string
  readonly owner: OwnerFixture
  readonly sessionId: string
  readonly sessionOnly: boolean
  readonly channel: 'normal' | 'profile'
  readonly query: string
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
}

interface DatasetFixture {
  readonly evaluationTime: string
  readonly corpora: readonly { readonly id: string; readonly records: readonly RecordFixture[] }[]
  readonly queries: readonly QueryFixture[]
}

interface GoldenCaseReport {
  readonly id: string
  readonly corpusId: string
  readonly channel: 'normal' | 'profile'
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
  readonly returnedIds: readonly string[]
}

interface RecallMetric {
  readonly macro: number
  readonly micro: number
}

interface MrrMetric {
  readonly cutoff: 10
  readonly value: number
}

interface BucketReport {
  readonly bucket: string
  readonly language: string
  readonly recallAt5: RecallMetric
  readonly recallAt10: RecallMetric
  readonly mrrAt10: MrrMetric
}

interface GoldenReport {
  readonly schemaVersion: 1
  readonly dataset: {
    readonly id: string
    readonly version: string
    readonly referenceCommit: string
  }
  readonly counts: {
    readonly corpora: number
    readonly records: number
    readonly queries: number
    readonly relevantQueries: number
    readonly negativeQueries: number
  }
  readonly metrics: {
    readonly recallAt5: RecallMetric
    readonly recallAt10: RecallMetric
    readonly mrrAt10: MrrMetric
    readonly conflictAccuracy: unknown
    readonly duplicateCompressionRate: unknown
    readonly degradationRate: unknown
  }
  readonly buckets: readonly BucketReport[]
  readonly cases: readonly GoldenCaseReport[]
  readonly hardChecks: {
    readonly scopeLeaks: number
    readonly forbiddenHits: number
    readonly duplicateResultIds: number
  }
}

interface RunnerModule {
  runGolden(options: {
    readonly datasetPath: string
    readonly repeats: number
  }): Promise<GoldenReport>
  materializeRecord(record: unknown): MemoryRecord
}

interface MetricsModule {
  canonicalJson(value: unknown): string
  validateReport(value: unknown): void
}

interface MemoryPrototype {
  import(scope: MemoryScope, records: readonly MemoryRecord[]): Promise<number>
  search(input: SearchMemoryInput, signal?: AbortSignal): Promise<SearchResult>
  add(input: AddMemoryInput, signal?: AbortSignal): Promise<WriteReceipt>
}

interface BuiltMemoryModule {
  readonly default: { readonly prototype: MemoryPrototype }
  readonly HASH_EMBEDDING_SPACE_ID: string
  readonly HASH_EMBEDDING_DIMENSIONS: number
  hashEmbedding(content: string): readonly number[]
}

interface GoldenGates {
  readonly schemaVersion: 1
  readonly dataset: GoldenReport['dataset']
  readonly overall: {
    readonly recallAt5: { macroFloor: number; microFloor: number }
    readonly recallAt10: { macroFloor: number; microFloor: number }
    readonly mrrAt10: { valueFloor: number }
  }
  readonly buckets: Array<{
    readonly bucket: string
    readonly language: string
    readonly recallAt5: { macroFloor: number; microFloor: number }
    readonly recallAt10: { macroFloor: number; microFloor: number }
    readonly mrrAt10: { valueFloor: number }
  }>
  readonly hardChecks: {
    readonly scopeLeaks: 0
    readonly forbiddenHits: 0
    readonly duplicateResultIds: 0
  }
}

const workspace = fileURLToPath(new URL('..', import.meta.url))
const runnerPath = fileURLToPath(new URL('../evaluation/run-golden.mjs', import.meta.url))
const runnerUrl = new URL('../evaluation/run-golden.mjs', import.meta.url)
const metricsUrl = new URL('../evaluation/metrics.mjs', import.meta.url)
const builtMemoryUrl = new URL('../lib/index.js', import.meta.url)
const datasetPath = fileURLToPath(new URL('../evaluation/golden/v1/retrieval.json', import.meta.url))
const baselinePath = fileURLToPath(new URL('../evaluation/golden/v1/baseline.hash-v1.json', import.meta.url))
const gatesPath = fileURLToPath(new URL('../evaluation/golden/v1/gates.json', import.meta.url))
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const roots: string[] = []

async function loadRunner(): Promise<RunnerModule> {
  return await import(runnerUrl.href) as RunnerModule
}

async function loadMetrics(): Promise<MetricsModule> {
  return await import(metricsUrl.href) as MetricsModule
}

async function loadBuiltMemory(): Promise<BuiltMemoryModule> {
  return await import(builtMemoryUrl.href) as BuiltMemoryModule
}

async function readDataset(): Promise<DatasetFixture> {
  return JSON.parse(await readFile(datasetPath, 'utf8')) as DatasetFixture
}

function ownerKey(owner: OwnerFixture): string {
  return JSON.stringify([owner.tenantId ?? '', owner.userId, owner.agentId])
}

function runCli(args: readonly string[]) {
  const env = { ...process.env }
  for (const key of [
    'DASHSCOPE_API_URL',
    'DASHSCOPE_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
  ]) delete env[key]
  return spawnSync(process.execPath, [runnerPath, ...args], {
    cwd: workspace,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function temporaryJson(value: unknown, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-golden-cli-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

async function temporaryDataset(mutate: (value: DatasetFixture) => void): Promise<string> {
  const value = structuredClone(await readDataset())
  mutate(value)
  return await temporaryJson(value, 'retrieval.json')
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
    return keys
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key)
      collectKeys(item, keys)
    }
  }
  return keys
}

beforeAll(() => {
  const build = spawnSync('pnpm', ['build'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (build.status !== 0) {
    throw new Error(`golden runner precondition build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`)
  }
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-003A programmatic runner', () => {
  it('runs the checked-in dataset through public import/search and reports every metric honestly', async () => {
    const [{ runGolden }, { validateReport }] = await Promise.all([loadRunner(), loadMetrics()])
    const report = await runGolden({ datasetPath, repeats: 2 })

    expect(() => validateReport(report)).not.toThrow()
    expect(report.counts).toEqual({
      corpora: 1,
      records: 26,
      queries: 49,
      relevantQueries: 42,
      negativeQueries: 7,
    })
    expect(report.buckets).toHaveLength(14)
    const bucketCells = report.buckets.map(cell => `${cell.bucket}/${cell.language}`)
    expect(new Set(bucketCells).size).toBe(14)
    expect(report.cases).toHaveLength(49)
    expect(report.hardChecks).toEqual({ scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 })
    expect(report.metrics).toEqual(expect.objectContaining({
      recallAt5: expect.objectContaining({ macro: expect.any(Number), micro: expect.any(Number) }),
      recallAt10: expect.objectContaining({ macro: expect.any(Number), micro: expect.any(Number) }),
      mrrAt10: expect.objectContaining({ cutoff: 10, value: expect.any(Number) }),
      conflictAccuracy: expect.objectContaining({ status: 'not_measured', value: null }),
      duplicateCompressionRate: expect.objectContaining({ status: 'not_measured', value: null }),
      degradationRate: expect.objectContaining({ status: 'not_measured', value: null }),
    }))
  }, 120_000)

  it('materializes fixed import records and exercises public import/search without add or network', async () => {
    const built = await loadBuiltMemory()
    const prototype = built.default.prototype
    const importSpy = vi.spyOn(prototype, 'import')
    const searchSpy = vi.spyOn(prototype, 'search')
    const addSpy = vi.spyOn(prototype, 'add')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Golden runner must not access the network')
    })
    const { materializeRecord, runGolden } = await loadRunner()
    const dataset = await readDataset()
    const fixture = dataset.corpora[0]?.records.find(record => record.id === 'mem-current-zh-codename-new')
    if (fixture === undefined) throw new Error('missing current-head fixture')

    const first = materializeRecord(fixture)
    expect(materializeRecord(fixture)).toEqual(first)
    expect(first).toMatchObject({
      schemaVersion: 1,
      id: fixture.id,
      scope: { ...fixture.owner, sessionId: fixture.sourceSessionId },
      sourceSessionId: fixture.sourceSessionId,
      revision: 2,
      supersedes: ['mem-current-zh-codename-old'],
      supersededBy: [],
      consolidates: [],
      embedding: {
        spaceId: built.HASH_EMBEDDING_SPACE_ID,
        dimensions: built.HASH_EMBEDDING_DIMENSIONS,
      },
    })
    expect(first.embedding.vector).toEqual(built.hashEmbedding(fixture.content))

    await runGolden({ datasetPath, repeats: 1 })
    expect(importSpy.mock.calls.length).toBeGreaterThan(0)
    expect(searchSpy).toHaveBeenCalledTimes(dataset.queries.length)
    expect(addSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    for (const call of searchSpy.mock.calls) {
      const input = call[0]
      const query = dataset.queries.find(candidate => candidate.query === input.query)
      expect(query, input.query).toBeDefined()
      if (query === undefined) continue
      expect(input).toMatchObject({
        scope: { ...query.owner, sessionId: query.sessionId },
        sessionOnly: query.sessionOnly,
        limit: 10,
        profileLimit: 10,
      })
    }
  }, 120_000)

  it('counts scope leaks from actual hits in the unscored channel without changing scored IDs', async () => {
    const built = await loadBuiltMemory()
    const prototype = built.default.prototype
    const originalSearch = prototype.search
    const dataset = await readDataset()
    const target = dataset.queries.find(query => query.id === 'q-pronoun-zh-01')
    const profileFixture = dataset.corpora[0]?.records.find(record => record.id === 'mem-synonym-zh-cinema')
    if (target === undefined) throw new Error('missing cross-channel scope fixture')
    if (profileFixture === undefined) throw new Error('missing forged profile record fixture')
    const { materializeRecord, runGolden } = await loadRunner()
    const profileMemory = materializeRecord(profileFixture)
    let untamperedReturnedIds: readonly string[] | undefined

    vi.spyOn(prototype, 'search').mockImplementation(async function (
      this: MemoryPrototype,
      input: SearchMemoryInput,
      signal?: AbortSignal,
    ): Promise<SearchResult> {
      const result = await originalSearch.call(this, input, signal)
      if (input.query !== target.query) return result

      untamperedReturnedIds = result.channels.normal.map(hit => hit.memory.id)
      const forged = {
        score: 1,
        matchedBy: ['profile'] as const,
        memory: {
          ...profileMemory,
          scope: { ...profileMemory.scope, userId: 'forged-cross-owner' },
        },
      }
      return {
        ...result,
        channels: {
          normal: result.channels.normal,
          profile: [forged, ...result.channels.profile],
        },
      }
    })

    const report = await runGolden({ datasetPath, repeats: 1 })
    const scoredCase = report.cases.find(result => result.id === target.id)

    expect(untamperedReturnedIds).toBeDefined()
    expect(scoredCase?.returnedIds).toEqual(untamperedReturnedIds)
    expect(report.hardChecks.scopeLeaks).toBeGreaterThan(0)
  }, 120_000)

  it('reports only active, current, channel-correct records inside each query boundary', async () => {
    const { runGolden } = await loadRunner()
    const [dataset, report] = await Promise.all([
      readDataset(),
      runGolden({ datasetPath, repeats: 1 }),
    ])
    const records = new Map(dataset.corpora.flatMap(corpus => corpus.records.map(record => [record.id, record] as const)))
    const queries = new Map(dataset.queries.map(query => [query.id, query] as const))

    for (const result of report.cases) {
      const query = queries.get(result.id)
      expect(query, result.id).toBeDefined()
      if (query === undefined) continue
      expect(result.corpusId).toBe(query.corpusId)
      expect(result.channel).toBe(query.channel)
      expect(result.relevantIds).toEqual(query.relevantIds)
      expect(result.forbiddenIds).toEqual(query.forbiddenIds)
      expect(result.returnedIds.some(id => query.forbiddenIds.includes(id)), `${query.id} forbidden`).toBe(false)
      for (const id of result.returnedIds) {
        const record = records.get(id)
        expect(record, `${query.id} -> ${id}`).toBeDefined()
        if (record === undefined) continue
        expect(ownerKey(record.owner), `${query.id} owner`).toBe(ownerKey(query.owner))
        expect(record).toMatchObject({ status: 'active', visibility: 'recallable' })
        const expectedChannel = record.layer === 'l0_basic_info' || record.layer === 'l4_identity' ? 'profile' : 'normal'
        expect(expectedChannel, `${query.id} channel`).toBe(query.channel)
        if (query.sessionOnly) expect(record.sourceSessionId, `${query.id} session`).toBe(query.sessionId)
        if (record.validUntil !== undefined) expect(Date.parse(record.validUntil)).toBeGreaterThan(Date.now())
      }
    }
    const returned = new Set(report.cases.flatMap(result => result.returnedIds))
    expect(returned.has('mem-temporal-zh-meeting-expired')).toBe(false)
    expect(returned.has('mem-temporal-en-meeting-expired')).toBe(false)
  }, 120_000)

  it('keeps search output independent from expected relevant/forbidden labels', async () => {
    const [{ runGolden }, { canonicalJson }] = await Promise.all([loadRunner(), loadMetrics()])
    const relabeledPath = await temporaryDataset((value) => {
      const index = value.queries.findIndex(query => query.id === 'q-synonym-zh-01')
      const query = value.queries[index]
      if (query === undefined) throw new Error('missing relabel fixture')
      ;(value.queries as QueryFixture[])[index] = {
        ...query,
        relevantIds: ['mem-synonym-en-cinema'],
        forbiddenIds: ['mem-synonym-zh-cinema'],
      }
    })
    const [original, relabeled] = await Promise.all([
      runGolden({ datasetPath, repeats: 1 }),
      runGolden({ datasetPath: relabeledPath, repeats: 1 }),
    ])
    const originalCase = original.cases.find(result => result.id === 'q-synonym-zh-01')
    const relabeledCase = relabeled.cases.find(result => result.id === 'q-synonym-zh-01')

    expect(originalCase).toBeDefined()
    expect(relabeledCase).toBeDefined()
    expect(canonicalJson(relabeledCase?.returnedIds)).toBe(canonicalJson(originalCase?.returnedIds))
  }, 120_000)

  it('isolates corpora even when another corpus has a same-owner exact-text distractor', async () => {
    const { runGolden } = await loadRunner()
    const isolatedPath = await temporaryDataset((value) => {
      const source = value.corpora[0]?.records.find(record => record.id === 'mem-pronoun-zh-wutong')
      const query = value.queries.find(candidate => candidate.id === 'q-pronoun-zh-01')
      if (source === undefined || query === undefined) throw new Error('missing cross-corpus fixture')
      const corpora = value.corpora as Array<{ id: string; records: RecordFixture[] }>
      corpora.push({
        id: 'isolated-corpus-b',
        records: [{
          ...source,
          id: 'mem-isolated-corpus-b-distractor',
          sourceSessionId: 'isolated-corpus-b-session',
          content: query.query,
          tags: ['林岚', '梧桐', '后端'],
        }],
      })
    })
    const report = await runGolden({ datasetPath: isolatedPath, repeats: 1 })
    const result = report.cases.find(candidate => candidate.id === 'q-pronoun-zh-01')

    expect(report.counts).toMatchObject({ corpora: 2, records: 27, queries: 49 })
    expect(result).toBeDefined()
    expect(result?.returnedIds).not.toContain('mem-isolated-corpus-b-distractor')
  }, 120_000)

  it('produces byte-identical canonical reports without runtime or storage artifacts', async () => {
    const [{ runGolden }, { canonicalJson }] = await Promise.all([loadRunner(), loadMetrics()])
    const first = canonicalJson(await runGolden({ datasetPath, repeats: 1 }))
    const second = canonicalJson(await runGolden({ datasetPath, repeats: 1 }))

    expect(second).toBe(first)
    const parsed = JSON.parse(first) as unknown
    const keys = collectKeys(parsed)
    expect(keys).not.toContain('requestId')
    expect(keys).not.toContain('generatedAt')
    expect(keys).not.toContain('vector')
    expect(first).not.toMatch(/dsh-memory-golden-|\/tmp\//u)
  }, 120_000)

  it('freezes an exact repeats=2 baseline and mechanically identical overall/bucket floors', async () => {
    const [{ runGolden }, { canonicalJson }] = await Promise.all([loadRunner(), loadMetrics()])
    const [baseline, gates, current] = await Promise.all([
      readFile(baselinePath, 'utf8').then(text => JSON.parse(text) as GoldenReport),
      readFile(gatesPath, 'utf8').then(text => JSON.parse(text) as GoldenGates),
      runGolden({ datasetPath, repeats: 2 }),
    ])

    expect(canonicalJson(baseline)).toBe(canonicalJson(current))
    expect(gates).toMatchObject({
      schemaVersion: 1,
      dataset: baseline.dataset,
      hardChecks: { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
      overall: {
        recallAt5: {
          macroFloor: baseline.metrics.recallAt5.macro,
          microFloor: baseline.metrics.recallAt5.micro,
        },
        recallAt10: {
          macroFloor: baseline.metrics.recallAt10.macro,
          microFloor: baseline.metrics.recallAt10.micro,
        },
        mrrAt10: { valueFloor: baseline.metrics.mrrAt10.value },
      },
    })
    expect(gates.buckets).toHaveLength(14)
    for (const bucket of baseline.buckets) {
      expect(gates.buckets).toContainEqual({
        bucket: bucket.bucket,
        language: bucket.language,
        recallAt5: { macroFloor: bucket.recallAt5.macro, microFloor: bucket.recallAt5.micro },
        recallAt10: { macroFloor: bucket.recallAt10.macro, microFloor: bucket.recallAt10.micro },
        mrrAt10: { valueFloor: bucket.mrrAt10.value },
      })
    }
  }, 120_000)
})

describe('MEM-003A CLI and package contract', () => {
  it('prints only one canonical JSON report and exits 0 in report-only mode', async () => {
    const { canonicalJson } = await loadMetrics()
    const result = runCli(['--dataset', datasetPath, '--repeat', '1', '--report-only'])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as unknown
    expect(result.stdout).toBe(`${canonicalJson(parsed)}\n`)
  }, 120_000)

  it('passes the checked-in non-regression gates with exit 0', async () => {
    const { canonicalJson } = await loadMetrics()
    const result = runCli(['--dataset', datasetPath, '--gates', gatesPath, '--repeat', '2'])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as unknown
    expect(result.stdout).toBe(`${canonicalJson(parsed)}\n`)
  }, 120_000)

  it('exits 2 when one mechanically derived quality floor is raised above the baseline', async () => {
    const gates = JSON.parse(await readFile(gatesPath, 'utf8')) as GoldenGates
    const candidates = [
      {
        value: gates.overall.recallAt5.macroFloor,
        set: (value: number) => { gates.overall.recallAt5.macroFloor = value },
      },
      {
        value: gates.overall.recallAt10.macroFloor,
        set: (value: number) => { gates.overall.recallAt10.macroFloor = value },
      },
      {
        value: gates.overall.mrrAt10.valueFloor,
        set: (value: number) => { gates.overall.mrrAt10.valueFloor = value },
      },
    ]
    const target = candidates.find(candidate => candidate.value < 1)
    if (target === undefined) throw new Error('expected at least one non-perfect hash baseline metric')
    target.set(Number((target.value + 0.000001).toFixed(6)))
    const raisedPath = await temporaryJson(gates, 'gates.json')
    const result = runCli(['--dataset', datasetPath, '--gates', raisedPath, '--repeat', '1'])

    expect.soft(result.status).toBe(2)
    expect.soft(result.stderr).toMatch(/golden: gate failed:/i)
    if (result.stdout.trim().length === 0) return
    expect(() => JSON.parse(result.stdout) as unknown).not.toThrow()
  }, 120_000)

  it('exits 1 with a contract diagnostic for semantic invalid input, not MODULE_NOT_FOUND', async () => {
    const invalidPath = await temporaryDataset((value) => {
      const first = value.queries[0]
      if (first !== undefined) (value.queries as QueryFixture[]).push(structuredClone(first))
    })
    const result = runCli(['--dataset', invalidPath, '--repeat', '1', '--report-only'])

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toMatch(/golden: invalid dataset:/i)
    expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/i)
  }, 120_000)

  it('exits 2 after a completed evaluation whose forbidden-result hard check fails', async () => {
    const hardFailurePath = await temporaryDataset((value) => {
      const index = value.queries.findIndex(query => query.id === 'q-negative-deleted-zh')
      const query = value.queries[index]
      if (query === undefined) throw new Error('missing negative fixture')
      ;(value.queries as QueryFixture[])[index] = {
        ...query,
        query: '林岚负责梧桐项目的后端服务。',
        forbiddenIds: ['mem-pronoun-zh-wutong'],
      }
    })
    const result = runCli(['--dataset', hardFailurePath, '--repeat', '1', '--report-only'])

    expect.soft(result.status).toBe(2)
    expect.soft(result.stderr).toMatch(/golden: hard check failed:/i)
    if (result.stdout.trim().length === 0) return
    const report = JSON.parse(result.stdout) as GoldenReport
    expect(report.hardChecks.forbiddenHits).toBeGreaterThan(0)
  }, 120_000)

  it('defines an API-free eval:golden script with fixed dataset, gates, and repeats', async () => {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
      readonly scripts?: Readonly<Record<string, string>>
    }
    const script = manifest.scripts?.['eval:golden']

    expect(script).toBe(
      'pnpm run build && node evaluation/run-golden.mjs --dataset evaluation/golden/v1/retrieval.json --gates evaluation/golden/v1/gates.json --repeat 2',
    )
    expect(script).not.toMatch(/(?:OPENAI|DEEPSEEK|API[_-]?KEY|TOKEN|SECRET)/i)
  })
})
