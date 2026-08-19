import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { MemoryRecord } from '../src/types.ts'

type Language = 'zh' | 'en'
type Bucket = 'synonym' | 'pronoun' | 'multi_topic' | 'current_head' | 'temporal' | 'cross_session' | 'exact_id'
type Channel = 'normal' | 'profile'

interface OwnerFixture {
  readonly tenantId?: string
  readonly userId: string
  readonly agentId: string
}

interface RecordFixture {
  readonly id: string
  readonly owner: OwnerFixture
  readonly sourceSessionId: string
  readonly layer: MemoryRecord['layer']
  readonly content: string
  readonly tags: readonly string[]
  readonly status: MemoryRecord['status']
  readonly visibility: MemoryRecord['visibility']
  readonly sourceType: MemoryRecord['sourceType']
  readonly confidence: number
  readonly occurredAt?: string
  readonly validFrom?: string
  readonly validUntil?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly relations: {
    readonly chainId?: string
    readonly supersedes: readonly string[]
    readonly supersededBy: readonly string[]
    readonly consolidates: readonly string[]
    readonly sourceMemoryIds: readonly string[]
  }
}

interface CorpusFixture {
  readonly id: string
  readonly records: readonly RecordFixture[]
}

interface QueryFixture {
  readonly id: string
  readonly corpusId: string
  readonly language: Language
  readonly bucket: Bucket
  readonly owner: OwnerFixture
  readonly sessionId: string
  readonly sessionOnly: boolean
  readonly channel: Channel
  readonly query: string
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
  readonly split: 'baseline' | 'holdout'
}

interface DatasetFixture {
  readonly schemaVersion: 1
  readonly datasetId: string
  readonly datasetVersion: string
  readonly referenceCommit: string
  readonly evaluationTime: string
  readonly corpora: readonly CorpusFixture[]
  readonly queries: readonly QueryFixture[]
}

interface RankingCase {
  readonly id: string
  readonly relevantIds: readonly string[]
  readonly forbiddenIds: readonly string[]
  readonly returnedIds: readonly string[]
}

interface RetrievalMetricResult {
  readonly counts: {
    readonly scoredQueries: number
    readonly excludedQueries: number
    readonly relevantItems: number
  }
  readonly recallAt5: { readonly macro: number; readonly micro: number }
  readonly recallAt10: { readonly macro: number; readonly micro: number }
  readonly mrrAt10: { readonly cutoff: 10; readonly value: number }
  readonly cases: readonly {
    readonly id: string
    readonly firstRelevantRank: number | null
    readonly recallAt5: number | null
    readonly recallAt10: number | null
    readonly reciprocalRank: number | null
  }[]
  readonly hardChecks: {
    readonly forbiddenHits: number
    readonly duplicateResultIds: number
  }
}

interface MetricsModule {
  validateDataset(dataset: unknown): void
  validateReport(report: unknown): void
  computeRetrievalMetrics(cases: readonly RankingCase[]): RetrievalMetricResult
  createNotMeasuredMetrics(): Readonly<Record<'conflictAccuracy' | 'duplicateCompressionRate' | 'degradationRate', {
    readonly status: 'not_measured'
    readonly value: null
    readonly reason: string
  }>>
  canonicalJson(value: unknown): string
}

const datasetPath = fileURLToPath(new URL('../evaluation/golden/v1/retrieval.json', import.meta.url))
const datasetSchemaPath = fileURLToPath(new URL('../evaluation/golden/v1/dataset.schema.json', import.meta.url))
const reportSchemaPath = fileURLToPath(new URL('../evaluation/golden/report.schema.json', import.meta.url))
const metricsUrl = new URL('../evaluation/metrics.mjs', import.meta.url)

const parseJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown
const dataset = parseJson(datasetPath) as DatasetFixture
const datasetSchema = parseJson(datasetSchemaPath) as Record<string, unknown>
const reportSchema = parseJson(reportSchemaPath) as Record<string, unknown>

async function loadMetrics(): Promise<MetricsModule> {
  return await import(metricsUrl.href) as MetricsModule
}

function ownerKey(owner: OwnerFixture): string {
  return JSON.stringify([owner.tenantId ?? '', owner.userId, owner.agentId])
}

function recordsById(value: DatasetFixture): Map<string, RecordFixture> {
  return new Map(value.corpora.flatMap(corpus => corpus.records.map(record => [record.id, record] as const)))
}

function cloneDataset(): DatasetFixture {
  return structuredClone(dataset)
}

function mutableDataset(): {
  schemaVersion: 1
  datasetId: string
  datasetVersion: string
  referenceCommit: string
  evaluationTime: string
  corpora: Array<{ id: string; records: RecordFixture[] }>
  queries: QueryFixture[]
} {
  return structuredClone(dataset) as ReturnType<typeof mutableDataset>
}

function validReportFixture(): Record<string, unknown> {
  const notMeasured = {
    status: 'not_measured',
    value: null,
    reason: 'requires MEM-003B lifecycle evaluation',
  }
  const recall = { macro: 0.5, micro: 0.5 }
  const mrr = { cutoff: 10, value: 0.5 }
  return {
    schemaVersion: 1,
    dataset: {
      id: 'dsh-memory-retrieval',
      version: '1.0.0',
      referenceCommit: 'dc000a4877538b193a51444e890fe552147ffa9f',
    },
    runner: { version: 1, repeats: 1 },
    embeddingSpace: { id: 'dsh-memory/hash-token-char-v1/256/l2', dimensions: 256 },
    counts: { corpora: 1, records: 1, queries: 1, relevantQueries: 1, negativeQueries: 0 },
    metrics: {
      recallAt5: recall,
      recallAt10: recall,
      mrrAt10: mrr,
      conflictAccuracy: notMeasured,
      duplicateCompressionRate: notMeasured,
      degradationRate: notMeasured,
    },
    buckets: [{
      bucket: 'synonym',
      language: 'en',
      queryCount: 1,
      relevantQueryCount: 1,
      negativeQueryCount: 0,
      recallAt5: recall,
      recallAt10: recall,
      mrrAt10: mrr,
    }],
    cases: [{
      id: 'q',
      corpusId: 'c',
      language: 'en',
      bucket: 'synonym',
      split: 'baseline',
      channel: 'normal',
      relevantIds: ['r'],
      forbiddenIds: [],
      returnedIds: ['r'],
      firstRelevantRank: 1,
      recallAt5: 1,
      recallAt10: 1,
      reciprocalRank: 1,
      forbiddenHits: [],
    }],
    hardChecks: { scopeLeaks: 0, forbiddenHits: 0, duplicateResultIds: 0 },
  }
}

describe('MEM-003A Golden Set data fixtures', () => {
  it('parses the two schemas and the vector-free versioned dataset', () => {
    expect(datasetSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    })
    expect(reportSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    })
    expect(dataset).toMatchObject({
      schemaVersion: 1,
      datasetId: 'dsh-memory-retrieval',
      datasetVersion: '1.0.0',
      referenceCommit: 'dc000a4877538b193a51444e890fe552147ffa9f',
      evaluationTime: '2026-08-20T00:00:00.000Z',
    })
    expect(dataset.corpora).toHaveLength(1)
    expect(dataset.corpora.flatMap(corpus => corpus.records)).toHaveLength(26)
    for (const record of dataset.corpora.flatMap(corpus => corpus.records)) {
      expect(record).not.toHaveProperty('embedding')
      expect(record).not.toHaveProperty('vector')
    }
  })

  it('contains exactly 42 scored and 7 excluded cases across every bilingual bucket', () => {
    const scored = dataset.queries.filter(query => query.relevantIds.length > 0)
    const excluded = dataset.queries.filter(query => query.relevantIds.length === 0)

    expect(scored).toHaveLength(42)
    expect(excluded).toHaveLength(7)
    for (const bucket of ['synonym', 'pronoun', 'multi_topic', 'current_head', 'temporal', 'cross_session', 'exact_id'] as const) {
      for (const language of ['zh', 'en'] as const) {
        const cell = scored.filter(query => query.bucket === bucket && query.language === language)
        expect(cell, `${bucket}/${language}`).toHaveLength(3)
        expect(cell.some(query => query.split === 'holdout'), `${bucket}/${language} holdout`).toBe(true)
      }
    }
    expect(scored.filter(query => query.bucket === 'multi_topic').every(query => query.relevantIds.length >= 2)).toBe(true)
  })

  it('keeps IDs unique and all relevant/forbidden references corpus-local', () => {
    const corpusIds = dataset.corpora.map(corpus => corpus.id)
    const recordIds = dataset.corpora.flatMap(corpus => corpus.records.map(record => record.id))
    const queryIds = dataset.queries.map(query => query.id)

    expect(new Set(corpusIds).size).toBe(corpusIds.length)
    expect(new Set(recordIds).size).toBe(recordIds.length)
    expect(new Set(queryIds).size).toBe(queryIds.length)
    for (const query of dataset.queries) {
      const corpus = dataset.corpora.find(candidate => candidate.id === query.corpusId)
      expect(corpus, query.id).toBeDefined()
      const ids = new Set(corpus?.records.map(record => record.id))
      for (const id of [...query.relevantIds, ...query.forbiddenIds]) expect(ids.has(id), `${query.id} -> ${id}`).toBe(true)
    }
  })

  it('keeps relevant owners/channels valid and current-head history non-recallable', () => {
    const byId = recordsById(dataset)
    for (const query of dataset.queries) {
      for (const id of query.relevantIds) {
        const record = byId.get(id)
        expect(record, id).toBeDefined()
        if (record === undefined) continue
        expect(ownerKey(record.owner), `${query.id} owner`).toBe(ownerKey(query.owner))
        const expectedChannel = record.layer === 'l0_basic_info' || record.layer === 'l4_identity' ? 'profile' : 'normal'
        expect(query.channel, `${query.id} channel`).toBe(expectedChannel)
      }
    }

    for (const query of dataset.queries.filter(query => query.bucket === 'current_head' && query.relevantIds.length > 0)) {
      for (const id of query.relevantIds) expect(byId.get(id)).toMatchObject({ status: 'active', visibility: 'recallable' })
      for (const id of query.forbiddenIds) expect(byId.get(id)).toMatchObject({ status: 'superseded', visibility: 'source_only' })
    }
  })

  it('does not leak exact-ID answers into record content or tags', () => {
    const byId = recordsById(dataset)
    for (const query of dataset.queries.filter(query => query.bucket === 'exact_id')) {
      for (const id of query.relevantIds) {
        const record = byId.get(id)
        expect(query.query, query.id).toContain(id)
        expect(`${record?.content ?? ''}\n${record?.tags.join(' ') ?? ''}`, `${id} pollution`).not.toContain(id)
      }
    }
  })

  it('uses permanently expired fixtures while current temporal records omit validUntil', () => {
    const records = dataset.corpora.flatMap(corpus => corpus.records)
    const expired = records.filter(record => record.id.includes('meeting-expired'))
    const current = records.filter(record => record.id.includes('meeting-current'))

    expect(expired).toHaveLength(2)
    expect(current).toHaveLength(2)
    for (const record of expired) {
      expect(record.validUntil).toBeDefined()
      expect(Date.parse(record.validUntil ?? '')).toBeLessThan(Date.now())
    }
    for (const record of current) expect(record).not.toHaveProperty('validUntil')
  })
})

describe('MEM-003A pure metric contracts', () => {
  it('computes six-decimal macro/micro Recall and MRR without reordering returned IDs', async () => {
    const { computeRetrievalMetrics } = await loadMetrics()
    const result = computeRetrievalMetrics([
      { id: 'two-relevant', relevantIds: ['a', 'b'], forbiddenIds: [], returnedIds: ['x', 'a', 'y', 'z', 'q', 'b'] },
      { id: 'rank-ten', relevantIds: ['c'], forbiddenIds: [], returnedIds: ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'c'] },
      { id: 'three-relevant', relevantIds: ['d', 'e', 'f'], forbiddenIds: [], returnedIds: ['d'] },
      { id: 'negative', relevantIds: [], forbiddenIds: ['secret'], returnedIds: ['secret'] },
    ])

    expect(result.counts).toEqual({ scoredQueries: 3, excludedQueries: 1, relevantItems: 6 })
    expect(result.recallAt5).toEqual({ macro: 0.277778, micro: 0.333333 })
    expect(result.recallAt10).toEqual({ macro: 0.777778, micro: 0.666667 })
    expect(result.mrrAt10).toEqual({ cutoff: 10, value: 0.533333 })
    expect(result.cases).toEqual([
      expect.objectContaining({ id: 'two-relevant', firstRelevantRank: 2, recallAt5: 0.5, recallAt10: 1, reciprocalRank: 0.5 }),
      expect.objectContaining({ id: 'rank-ten', firstRelevantRank: 10, recallAt5: 0, recallAt10: 1, reciprocalRank: 0.1 }),
      expect.objectContaining({ id: 'three-relevant', firstRelevantRank: 1, recallAt5: 0.333333, recallAt10: 0.333333, reciprocalRank: 1 }),
      expect.objectContaining({ id: 'negative', firstRelevantRank: null, recallAt5: null, recallAt10: null, reciprocalRank: null }),
    ])
    expect(result.hardChecks).toEqual({ forbiddenHits: 1, duplicateResultIds: 0 })
  })

  it('counts every repeated returned ID as a hard failure instead of hiding it', async () => {
    const { computeRetrievalMetrics } = await loadMetrics()
    const result = computeRetrievalMetrics([
      { id: 'duplicates', relevantIds: ['a'], forbiddenIds: [], returnedIds: ['a', 'a', 'b', 'b', 'b'] },
    ])

    expect(result.hardChecks.duplicateResultIds).toBe(3)
  })

  it('provides honest not-measured lifecycle metrics and canonical key ordering', async () => {
    const { canonicalJson, createNotMeasuredMetrics } = await loadMetrics()
    const metrics = createNotMeasuredMetrics()

    expect(Object.keys(metrics).sort()).toEqual(['conflictAccuracy', 'degradationRate', 'duplicateCompressionRate'])
    for (const metric of Object.values(metrics)) {
      expect(metric).toMatchObject({ status: 'not_measured', value: null })
      expect(metric.reason.length).toBeGreaterThan(0)
    }
    expect(canonicalJson({ z: 1, nested: { z: 2, a: 3 }, a: 4 }))
      .toBe('{"a":4,"nested":{"a":3,"z":2},"z":1}')
  })

  it('validates all local and semantic dataset boundaries', async () => {
    const { validateDataset } = await loadMetrics()
    expect(() => validateDataset(cloneDataset())).not.toThrow()

    const invalidCases = [
      ['duplicate record ID', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.corpora[0]?.records[0]
        if (first !== undefined) value.corpora[0]?.records.push(structuredClone(first))
      }, /duplicate record id/i],
      ['duplicate query ID', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries.push(structuredClone(first))
      }, /duplicate query id/i],
      ['missing required field', (value: ReturnType<typeof mutableDataset>) => {
        delete (value as unknown as Record<string, unknown>)['datasetId']
      }, /datasetId|required/i],
      ['unsupported schemaVersion', (value: ReturnType<typeof mutableDataset>) => {
        ;(value as unknown as Record<string, unknown>)['schemaVersion'] = 2
      }, /schemaVersion/i],
      ['illegal enum value', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries[0] = { ...first, language: 'fr' as Language }
      }, /language|enum/i],
      ['additional property', (value: ReturnType<typeof mutableDataset>) => {
        ;(value as unknown as Record<string, unknown>)['unexpected'] = true
      }, /additional|unexpected/i],
      ['unknown corpus', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries[0] = { ...first, corpusId: 'missing-corpus' }
      }, /corpus/i],
      ['dangling relevant ID', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries[0] = { ...first, relevantIds: ['missing-relevant'] }
      }, /relevant.*(?:missing|unknown)|(?:missing|unknown).*relevant/i],
      ['dangling forbidden ID', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries[0] = { ...first, forbiddenIds: ['missing-forbidden'] }
      }, /forbidden.*(?:missing|unknown)|(?:missing|unknown).*forbidden/i],
      ['cross-owner relevant ID', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries[0] = {
          ...first,
          channel: 'normal',
          relevantIds: ['mem-isolation-other-user'],
        }
      }, /relevant.*owner|owner.*relevant/i],
      ['wrong-channel relevant ID', (value: ReturnType<typeof mutableDataset>) => {
        const first = value.queries[0]
        if (first !== undefined) value.queries[0] = { ...first, channel: 'normal' }
      }, /relevant.*channel|channel.*relevant/i],
      ['non-recallable relevant record', (value: ReturnType<typeof mutableDataset>) => {
        const index = value.queries.findIndex(query => query.id === 'q-current-head-zh-01')
        const query = value.queries[index]
        if (query !== undefined) value.queries[index] = {
          ...query,
          relevantIds: ['mem-current-zh-codename-old'],
          forbiddenIds: [],
        }
      }, /relevant.*(?:active|recallable)|(?:active|recallable).*relevant/i],
      ['missing evolution reverse edge', (value: ReturnType<typeof mutableDataset>) => {
        const records = value.corpora[0]?.records
        const index = records?.findIndex(record => record.id === 'mem-current-zh-codename-old') ?? -1
        const old = records?.[index]
        if (records !== undefined && old !== undefined) records[index] = {
          ...old,
          relations: { ...old.relations, supersededBy: [] },
        }
      }, /reverse|bidirectional/i],
      ['non-increasing evolution revision', (value: ReturnType<typeof mutableDataset>) => {
        const records = value.corpora[0]?.records
        const index = records?.findIndex(record => record.id === 'mem-current-zh-codename-new') ?? -1
        const current = records?.[index]
        if (records !== undefined && current !== undefined) records[index] = { ...current, revision: 1 }
      }, /revision/i],
      ['bucket/language cell below three scored queries', (value: ReturnType<typeof mutableDataset>) => {
        const index = value.queries.findIndex(query => query.id === 'q-synonym-zh-01')
        if (index >= 0) value.queries.splice(index, 1)
      }, /bucket|three|3/i],
      ['bucket/language cell without holdout', (value: ReturnType<typeof mutableDataset>) => {
        const index = value.queries.findIndex(query => query.id === 'q-synonym-zh-03')
        const query = value.queries[index]
        if (query !== undefined) value.queries[index] = { ...query, split: 'baseline' }
      }, /holdout/i],
    ] as const
    for (const [name, mutate, message] of invalidCases) {
      const invalid = mutableDataset()
      mutate(invalid)
      expect(() => validateDataset(invalid), name).toThrow(message)
    }
  })

  it('validates required, additional, and nested report shape without a runtime schema dependency', async () => {
    const { validateReport } = await loadMetrics()
    expect(() => validateReport(validReportFixture())).not.toThrow()

    const invalidReports: Array<[string, (value: Record<string, unknown>) => void, RegExp]> = [
      ['missing required field', value => { delete value['counts'] }, /counts|required/i],
      ['additional top-level field', value => { value['generatedAt'] = 'now' }, /additional|generatedAt/i],
      ['wrong schema version', value => { value['schemaVersion'] = 2 }, /schemaVersion/i],
      ['missing nested case field', (value) => {
        const cases = value['cases'] as Array<Record<string, unknown>>
        delete cases[0]?.['returnedIds']
      }, /returnedIds|required/i],
      ['additional nested metric field', (value) => {
        const metrics = value['metrics'] as Record<string, Record<string, unknown>>
        const recall = metrics['recallAt5']
        if (recall !== undefined) recall['extra'] = true
      }, /additional|extra/i],
      ['wrong MRR cutoff', (value) => {
        const metrics = value['metrics'] as Record<string, Record<string, unknown>>
        const mrr = metrics['mrrAt10']
        if (mrr !== undefined) mrr['cutoff'] = 5
      }, /cutoff/i],
    ]
    for (const [name, mutate, message] of invalidReports) {
      const invalid = structuredClone(validReportFixture())
      mutate(invalid)
      expect(() => validateReport(invalid), name).toThrow(message)
    }
  })
})
