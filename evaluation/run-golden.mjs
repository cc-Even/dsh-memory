import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
} from '../lib/index.js'
import {
  canonicalJson,
  computeRetrievalMetrics,
  createNotMeasuredMetrics,
  validateDataset,
  validateReport,
} from './metrics.mjs'

const BUCKETS = [
  'synonym',
  'pronoun',
  'multi_topic',
  'current_head',
  'temporal',
  'cross_session',
  'exact_id',
]
const LANGUAGES = ['zh', 'en']
const PROFILE_LAYERS = new Set(['l0_basic_info', 'l4_identity'])

class InvalidDatasetError extends Error {}
class InvalidGatesError extends Error {}

function ownerKey(owner) {
  return JSON.stringify([owner.tenantId ?? '', owner.userId, owner.agentId])
}

function ownerScope(owner, sessionId) {
  return {
    ...(owner.tenantId === undefined ? {} : { tenantId: owner.tenantId }),
    userId: owner.userId,
    agentId: owner.agentId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** Convert a vector-free Golden fixture to one deterministic public import record. */
export function materializeRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Golden record fixture must be an object')
  }
  const record = value
  const relations = record.relations
  if (relations === null || typeof relations !== 'object' || Array.isArray(relations)) {
    throw new TypeError(`Golden record '${String(record.id)}' relations must be an object`)
  }
  return {
    schemaVersion: 1,
    id: record.id,
    scope: ownerScope(record.owner, record.sourceSessionId),
    layer: record.layer,
    content: record.content,
    status: record.status,
    visibility: record.visibility,
    sourceType: record.sourceType,
    confidence: record.confidence,
    ...(record.occurredAt === undefined ? {} : { occurredAt: record.occurredAt }),
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validUntil === undefined ? {} : { validUntil: record.validUntil }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(relations.chainId === undefined ? {} : { chainId: relations.chainId }),
    revision: record.revision,
    supersedes: [...relations.supersedes],
    supersededBy: [...relations.supersededBy],
    consolidates: [...relations.consolidates],
    sourceMemoryIds: [...relations.sourceMemoryIds],
    sourceSessionId: record.sourceSessionId,
    sourceTurnIndexes: [],
    tags: [...record.tags],
    meta: {},
    embedding: {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: hashEmbedding(record.content),
    },
  }
}

async function openCorpus() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-golden-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(MemoryService, {
      provider: 'golden-offline-provider',
      model: 'golden-offline-model',
      userId: 'golden-offline-user',
      autoCapture: false,
      autoRecall: false,
    })
    return { ctx, root }
  } catch (error) {
    await finishCorpus(ctx, root, [error])
  }
}

async function finishCorpus(ctx, root, primaryErrors = []) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => ctx.fiber.dispose()),
    Promise.resolve().then(() => rm(root, { recursive: true, force: true })),
  ])
  const errors = [
    ...primaryErrors,
    ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []),
  ]
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Golden corpus evaluation and cleanup failed', {
      cause: primaryErrors[0],
    })
  }
}

async function importCorpus(ctx, corpus) {
  const groups = new Map()
  const records = [...corpus.records].sort((left, right) => left.id.localeCompare(right.id))
  for (const fixture of records) {
    const key = ownerKey(fixture.owner)
    const group = groups.get(key) ?? { owner: fixture.owner, records: [] }
    group.records.push(materializeRecord(fixture))
    groups.set(key, group)
  }
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)
    await ctx.memory.import(ownerScope(group.owner), group.records)
  }
}

function validNow(record, now) {
  const validFrom = record.validFrom === undefined ? undefined : Date.parse(record.validFrom)
  const validUntil = record.validUntil === undefined ? undefined : Date.parse(record.validUntil)
  return (validFrom === undefined || (Number.isFinite(validFrom) && validFrom <= now))
    && (validUntil === undefined || (Number.isFinite(validUntil) && validUntil > now))
}

function scopeLeakCount(query, corpusId, recordsById, channelHits, now) {
  let leaks = 0
  for (const { channel, memory } of channelHits) {
    const location = recordsById.get(memory.id)
    if (location === undefined || location.corpusId !== corpusId) {
      leaks += 1
      continue
    }
    const expectedChannel = PROFILE_LAYERS.has(memory.layer) ? 'profile' : 'normal'
    const sessionLeak = query.sessionOnly
      && (memory.scope.sessionId !== query.sessionId || memory.sourceSessionId !== query.sessionId)
    if (ownerKey(memory.scope) !== ownerKey(query.owner)
      || channel !== expectedChannel
      || memory.status !== 'active'
      || memory.visibility !== 'recallable'
      || !validNow(memory, now)
      || sessionLeak) {
      leaks += 1
    }
  }
  return leaks
}

async function evaluateOnce(dataset, repeats) {
  const recordsById = new Map(dataset.corpora.flatMap(corpus => corpus.records.map(record => [
    record.id,
    { corpusId: corpus.id, record },
  ])))
  const rawCases = []
  let scopeLeaks = 0
  const now = Date.now()

  for (const corpus of dataset.corpora) {
    const { ctx, root } = await openCorpus()
    const primaryErrors = []
    try {
      await importCorpus(ctx, corpus)
      for (const query of dataset.queries.filter(candidate => candidate.corpusId === corpus.id)) {
        const result = await ctx.memory.search({
          scope: ownerScope(query.owner, query.sessionId),
          query: query.query,
          sessionOnly: query.sessionOnly,
          limit: 10,
          profileLimit: 10,
        })
        const returnedIds = result.channels[query.channel].map(hit => hit.memory.id)
        const channelHits = [
          ...result.channels.normal.map(hit => ({ channel: 'normal', memory: hit.memory })),
          ...result.channels.profile.map(hit => ({ channel: 'profile', memory: hit.memory })),
        ]
        scopeLeaks += scopeLeakCount(query, corpus.id, recordsById, channelHits, now)
        rawCases.push({
          id: query.id,
          corpusId: query.corpusId,
          language: query.language,
          bucket: query.bucket,
          split: query.split,
          channel: query.channel,
          relevantIds: [...query.relevantIds],
          forbiddenIds: [...query.forbiddenIds],
          returnedIds,
        })
      }
    } catch (error) {
      primaryErrors.push(error)
    } finally {
      await finishCorpus(ctx, root, primaryErrors)
    }
  }

  const overall = computeRetrievalMetrics(rawCases)
  const metricsById = new Map(overall.cases.map(result => [result.id, result]))
  const cases = rawCases.map((result) => {
    const metric = metricsById.get(result.id)
    if (metric === undefined) throw new Error(`Golden metrics omitted case '${result.id}'`)
    const forbidden = new Set(result.forbiddenIds)
    return {
      ...result,
      firstRelevantRank: metric.firstRelevantRank,
      recallAt5: metric.recallAt5,
      recallAt10: metric.recallAt10,
      reciprocalRank: metric.reciprocalRank,
      forbiddenHits: [...new Set(result.returnedIds.filter(id => forbidden.has(id)))],
    }
  })
  const buckets = []
  for (const bucket of BUCKETS) {
    for (const language of LANGUAGES) {
      const bucketCases = rawCases.filter(result => result.bucket === bucket && result.language === language)
      const measured = computeRetrievalMetrics(bucketCases)
      buckets.push({
        bucket,
        language,
        queryCount: bucketCases.length,
        relevantQueryCount: measured.counts.scoredQueries,
        negativeQueryCount: measured.counts.excludedQueries,
        recallAt5: measured.recallAt5,
        recallAt10: measured.recallAt10,
        mrrAt10: measured.mrrAt10,
      })
    }
  }
  const notMeasured = createNotMeasuredMetrics()
  const report = {
    schemaVersion: 1,
    dataset: {
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      referenceCommit: dataset.referenceCommit,
    },
    runner: { version: 1, repeats },
    embeddingSpace: { id: HASH_EMBEDDING_SPACE_ID, dimensions: HASH_EMBEDDING_DIMENSIONS },
    counts: {
      corpora: dataset.corpora.length,
      records: dataset.corpora.reduce((sum, corpus) => sum + corpus.records.length, 0),
      queries: dataset.queries.length,
      relevantQueries: overall.counts.scoredQueries,
      negativeQueries: overall.counts.excludedQueries,
    },
    metrics: {
      recallAt5: overall.recallAt5,
      recallAt10: overall.recallAt10,
      mrrAt10: overall.mrrAt10,
      ...notMeasured,
    },
    buckets,
    cases,
    hardChecks: {
      scopeLeaks,
      forbiddenHits: overall.hardChecks.forbiddenHits,
      duplicateResultIds: overall.hardChecks.duplicateResultIds,
    },
  }
  validateReport(report)
  return report
}

async function loadDataset(datasetPath) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(datasetPath, 'utf8'))
  } catch (error) {
    throw new InvalidDatasetError(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    validateDataset(parsed)
  } catch (error) {
    throw new InvalidDatasetError(error instanceof Error ? error.message : String(error))
  }
  return parsed
}

/** Run the real built MemoryService repeatedly and reject nondeterministic reports. */
export async function runGolden({ datasetPath, repeats }) {
  if (typeof datasetPath !== 'string' || datasetPath.length === 0) throw new TypeError('datasetPath is required')
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new TypeError('repeats must be a positive integer')
  const dataset = await loadDataset(datasetPath)
  let report
  let canonical
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const current = await evaluateOnce(dataset, repeats)
    const currentCanonical = canonicalJson(current)
    if (canonical !== undefined && currentCanonical !== canonical) {
      throw new Error(`Golden report is nondeterministic at repeat ${repeat + 1}`)
    }
    report ??= current
    canonical ??= currentCanonical
  }
  return report
}

function parseArguments(argv) {
  const options = { repeats: 1, reportOnly: false }
  let repeatProvided = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--report-only') {
      if (options.reportOnly) throw new Error('duplicate --report-only')
      options.reportOnly = true
      continue
    }
    if (argument !== '--dataset' && argument !== '--repeat' && argument !== '--gates') {
      throw new Error(`unknown argument '${argument}'`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--dataset') {
      if (options.datasetPath !== undefined) throw new Error('duplicate --dataset')
      options.datasetPath = value
    } else if (argument === '--gates') {
      if (options.gatesPath !== undefined) throw new Error('duplicate --gates')
      options.gatesPath = value
    } else {
      if (repeatProvided) throw new Error('duplicate --repeat')
      if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('--repeat must be a positive integer')
      }
      repeatProvided = true
      options.repeats = Number(value)
    }
  }
  if (options.datasetPath === undefined) throw new Error('--dataset is required')
  return options
}

function gateObject(value, path, required) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidGatesError(`${path} must be an object`)
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new InvalidGatesError(`${path}.${key} is required`)
  for (const key of Object.keys(value)) {
    if (!required.includes(key)) throw new InvalidGatesError(`${path} has additional property '${key}'`)
  }
  return value
}

function floor(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidGatesError(`${path} must be a number from 0 through 1`)
  }
  return value
}

function metricFloors(value, path) {
  const floors = gateObject(value, path, ['recallAt5', 'recallAt10', 'mrrAt10'])
  const recall5 = gateObject(floors.recallAt5, `${path}.recallAt5`, ['macroFloor', 'microFloor'])
  const recall10 = gateObject(floors.recallAt10, `${path}.recallAt10`, ['macroFloor', 'microFloor'])
  const mrr = gateObject(floors.mrrAt10, `${path}.mrrAt10`, ['valueFloor'])
  floor(recall5.macroFloor, `${path}.recallAt5.macroFloor`)
  floor(recall5.microFloor, `${path}.recallAt5.microFloor`)
  floor(recall10.macroFloor, `${path}.recallAt10.macroFloor`)
  floor(recall10.microFloor, `${path}.recallAt10.microFloor`)
  floor(mrr.valueFloor, `${path}.mrrAt10.valueFloor`)
  return floors
}

async function loadGates(path, report) {
  let gates
  try {
    gates = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidGatesError(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const root = gateObject(gates, 'gates', ['schemaVersion', 'dataset', 'overall', 'buckets', 'hardChecks'])
  if (root.schemaVersion !== 1) throw new InvalidGatesError('gates.schemaVersion must equal 1')
  const dataset = gateObject(root.dataset, 'gates.dataset', ['id', 'version', 'referenceCommit'])
  if (canonicalJson(dataset) !== canonicalJson(report.dataset)) throw new InvalidGatesError('gates.dataset does not match report dataset')
  metricFloors(root.overall, 'gates.overall')
  if (!Array.isArray(root.buckets) || root.buckets.length !== 14) {
    throw new InvalidGatesError('gates.buckets must contain exactly 14 cells')
  }
  const cells = new Set()
  for (const [index, value] of root.buckets.entries()) {
    const bucket = gateObject(value, `gates.buckets[${index}]`, [
      'bucket', 'language', 'recallAt5', 'recallAt10', 'mrrAt10',
    ])
    const key = `${bucket.bucket}/${bucket.language}`
    if (!BUCKETS.includes(bucket.bucket) || !LANGUAGES.includes(bucket.language) || cells.has(key)) {
      throw new InvalidGatesError(`gates.buckets has invalid or duplicate cell '${key}'`)
    }
    cells.add(key)
    metricFloors({ recallAt5: bucket.recallAt5, recallAt10: bucket.recallAt10, mrrAt10: bucket.mrrAt10 }, `gates.buckets[${index}]`)
  }
  const hard = gateObject(root.hardChecks, 'gates.hardChecks', ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds'])
  for (const key of ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds']) {
    if (hard[key] !== 0) throw new InvalidGatesError(`gates.hardChecks.${key} must equal 0`)
  }
  return root
}

function metricFailures(actual, expected, prefix, failures) {
  if (actual.recallAt5.macro < expected.recallAt5.macroFloor) failures.push(`${prefix}.recallAt5.macro`)
  if (actual.recallAt5.micro < expected.recallAt5.microFloor) failures.push(`${prefix}.recallAt5.micro`)
  if (actual.recallAt10.macro < expected.recallAt10.macroFloor) failures.push(`${prefix}.recallAt10.macro`)
  if (actual.recallAt10.micro < expected.recallAt10.microFloor) failures.push(`${prefix}.recallAt10.micro`)
  if (actual.mrrAt10.value < expected.mrrAt10.valueFloor) failures.push(`${prefix}.mrrAt10.value`)
}

function gateFailures(report, gates) {
  const failures = []
  metricFailures(report.metrics, gates.overall, 'overall', failures)
  for (const expected of gates.buckets) {
    const actual = report.buckets.find(bucket => bucket.bucket === expected.bucket && bucket.language === expected.language)
    if (actual === undefined) failures.push(`bucket.${expected.bucket}.${expected.language}.missing`)
    else metricFailures(actual, expected, `bucket.${expected.bucket}.${expected.language}`, failures)
  }
  return failures
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`golden: invalid arguments: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  try {
    const report = await runGolden({ datasetPath: options.datasetPath, repeats: options.repeats })
    let gates
    if (!options.reportOnly && options.gatesPath !== undefined) gates = await loadGates(options.gatesPath, report)
    const output = `${canonicalJson(report)}\n`
    const hardFailures = Object.entries(report.hardChecks).filter(([, count]) => count !== 0).map(([name]) => name)
    if (hardFailures.length > 0) {
      process.stdout.write(output)
      process.stderr.write(`golden: hard check failed: ${hardFailures.join(', ')}\n`)
      process.exitCode = 2
      return
    }
    if (gates !== undefined) {
      const failures = gateFailures(report, gates)
      if (failures.length > 0) {
        process.stdout.write(output)
        process.stderr.write(`golden: gate failed: ${failures.join(', ')}\n`)
        process.exitCode = 2
        return
      }
    }
    process.stdout.write(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof InvalidDatasetError) process.stderr.write(`golden: invalid dataset: ${message}\n`)
    else if (error instanceof InvalidGatesError) process.stderr.write(`golden: invalid gates: ${message}\n`)
    else process.stderr.write(`golden: runtime error: ${message}\n`)
    process.exitCode = 1
  }
}

const entry = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (entry !== undefined && entry === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
