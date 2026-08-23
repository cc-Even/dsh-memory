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
  OpenAICompatibleEmbeddingProvider,
  hashEmbedding,
} from '../lib/index.js'
import {
  canonicalJson,
  computeEmbeddingMetrics,
  evaluateEmbeddingGates,
  validateEmbeddingDataset,
  validateEmbeddingReport,
} from './embedding-metrics.mjs'

class InvalidDatasetError extends Error {}
class InvalidArgumentsError extends Error {}
class InvalidBaselineError extends Error {}
class InvalidGatesError extends Error {}

function ownerKey(owner) {
  return JSON.stringify([owner.tenantId, owner.userId, owner.agentId])
}

function ownerScope(owner, sessionId) {
  return {
    tenantId: owner.tenantId,
    userId: owner.userId,
    agentId: owner.agentId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function materializeRecord(fixture, description, vector) {
  return {
    schemaVersion: 1,
    id: fixture.id,
    scope: ownerScope(fixture.owner, fixture.sourceSessionId),
    layer: 'l2_fact',
    content: fixture.content,
    status: fixture.status,
    visibility: fixture.visibility,
    sourceType: 'explicit',
    confidence: 1,
    createdAt: fixture.createdAt,
    updatedAt: fixture.createdAt,
    revision: 1,
    supersedes: [],
    supersededBy: [],
    consolidates: [],
    sourceMemoryIds: [],
    sourceSessionId: fixture.sourceSessionId,
    sourceTurnIndexes: [],
    tags: [...fixture.tags],
    meta: {},
    embedding: {
      spaceId: description.spaceId,
      dimensions: description.dimensions,
      vector,
    },
  }
}

async function providerVectors(provider, texts) {
  const description = provider.describe()
  const vectors = []
  for (let offset = 0; offset < texts.length; offset += description.maxBatchSize) {
    const batch = texts.slice(offset, offset + description.maxBatchSize)
    const result = await provider.embedBatch(batch)
    if (result.length !== batch.length) throw new Error('live provider returned an invalid result count')
    for (const vector of result) {
      if (!Array.isArray(vector) || vector.length !== description.dimensions
        || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
        throw new Error('live provider returned an invalid vector')
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      if (!Number.isFinite(norm) || norm === 0) throw new Error('live provider returned a zero vector')
      vectors.push(vector.map(value => value / norm))
    }
  }
  return vectors
}

async function finishContext(ctx, root, primaryErrors = []) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => ctx.fiber.dispose()),
    Promise.resolve().then(() => rm(root, { recursive: true, force: true })),
  ])
  const errors = [
    ...primaryErrors,
    ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []),
  ]
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'embedding evaluation and cleanup failed')
}

async function openContext(provider) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-embedding-eval-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(MemoryService, {
      provider: 'embedding-evaluation-llm',
      model: 'embedding-evaluation-model',
      userId: 'embedding-evaluation-user',
      autoCapture: false,
      autoRecall: false,
      tokenizer: { kind: 'legacy' },
      ...(provider === undefined ? {} : { embeddingProvider: provider }),
    })
    return { ctx, root }
  } catch (error) {
    await finishContext(ctx, root, [error])
  }
}

function scopeLeakCount(query, hits, recordsById) {
  let leaks = 0
  for (const hit of hits) {
    const fixture = recordsById.get(hit.memory.id)
    if (fixture === undefined
      || ownerKey(fixture.owner) !== ownerKey(query.owner)
      || hit.memory.status !== 'active'
      || hit.memory.visibility !== 'recallable') leaks += 1
  }
  return leaks
}

async function evaluateOnce(dataset, provider) {
  const opened = await openContext(provider)
  if (opened === undefined) throw new Error('embedding evaluation context did not open')
  const { ctx, root } = opened
  const primaryErrors = []
  try {
    const description = provider?.describe() ?? {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      maxBatchSize: 256,
      normalization: 'l2',
      quality: 'portable-hash',
    }
    const vectors = provider === undefined
      ? dataset.records.map(record => hashEmbedding(record.content))
      : await providerVectors(provider, dataset.records.map(record => record.content))
    const groups = new Map()
    for (const [index, fixture] of dataset.records.entries()) {
      const key = ownerKey(fixture.owner)
      const group = groups.get(key) ?? { owner: fixture.owner, records: [] }
      group.records.push(materializeRecord(fixture, description, vectors[index]))
      groups.set(key, group)
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key)
      await ctx.memory.import(ownerScope(group.owner), group.records)
    }

    const recordsById = new Map(dataset.records.map(record => [record.id, record]))
    const rankings = []
    for (const query of dataset.queries) {
      const result = await ctx.memory.search({
        scope: ownerScope(query.owner, query.sessionId),
        query: query.query,
        limit: 10,
        profileLimit: 0,
      })
      const hits = [...result.channels.normal, ...result.channels.profile]
      rankings.push({
        id: query.id,
        language: query.language,
        bucket: query.bucket,
        split: query.split,
        relevantIds: query.relevantIds,
        forbiddenIds: query.forbiddenIds,
        returnedIds: result.channels.normal.map(hit => hit.memory.id),
        scopeLeaks: scopeLeakCount(query, hits, recordsById),
      })
    }
    return computeEmbeddingMetrics(rankings)
  } catch (error) {
    primaryErrors.push(error)
  } finally {
    await finishContext(ctx, root, primaryErrors)
  }
}

async function readDataset(path) {
  let dataset
  try {
    dataset = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidDatasetError(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    validateEmbeddingDataset(dataset)
  } catch (error) {
    throw new InvalidDatasetError(error instanceof Error ? error.message : String(error))
  }
  return dataset
}

/** Run a deterministic public import/search evaluation against the built package. */
export async function runEmbedding(options) {
  const repeats = options.repeats
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new InvalidArgumentsError('repeats must be positive')
  const dataset = await readDataset(options.datasetPath)
  let provider
  let model = null
  if (options.mode === 'live') {
    model = options.model
    provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      model,
      spaceId: options.spaceId,
      dimensions: options.dimensions,
      batchSize: options.batchSize ?? 128,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 100,
    })
  } else if (options.mode !== 'offline-hash') {
    throw new InvalidArgumentsError(`unsupported mode '${String(options.mode)}'`)
  }
  let measured
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const current = await evaluateOnce(dataset, provider)
    if (measured !== undefined && canonicalJson(current) !== canonicalJson(measured)) {
      throw new Error('embedding evaluation was not deterministic across repeats')
    }
    measured = current
  }
  const description = provider?.describe() ?? {
    quality: 'portable-hash',
    spaceId: HASH_EMBEDDING_SPACE_ID,
    dimensions: HASH_EMBEDDING_DIMENSIONS,
    normalization: 'l2',
  }
  const report = {
    schemaVersion: 1,
    dataset: {
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      referenceCommit: dataset.referenceCommit,
    },
    runner: {
      version: 1,
      repeats,
      mode: options.mode,
      externalNetwork: options.mode === 'live',
    },
    provider: {
      quality: description.quality,
      model,
      spaceId: description.spaceId,
      dimensions: description.dimensions,
      normalization: 'l2',
    },
    ...measured,
  }
  validateEmbeddingReport(report)
  return report
}

function parseArguments(argv) {
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--allow-network' || argument === '--report-only') {
      flags.add(argument)
      continue
    }
    if (!argument?.startsWith('--')) throw new InvalidArgumentsError(`unexpected argument '${String(argument)}'`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new InvalidArgumentsError(`${argument} requires a value`)
    values.set(argument, value)
    index += 1
  }
  const allowed = new Set([
    '--dataset', '--repeat', '--baseline', '--gates', '--live-model', '--space-id', '--dimensions',
    '--batch-size', '--timeout-ms', '--max-retries', '--retry-base-delay-ms',
  ])
  for (const key of values.keys()) if (!allowed.has(key)) throw new InvalidArgumentsError(`unknown option '${key}'`)
  const datasetPath = values.get('--dataset')
  if (datasetPath === undefined) throw new InvalidArgumentsError('--dataset is required')
  const liveModel = values.get('--live-model')
  const allowNetwork = flags.has('--allow-network')
  if ((liveModel === undefined) !== !allowNetwork) {
    throw new InvalidArgumentsError('--live-model and --allow-network must be supplied together')
  }
  const repeatText = values.get('--repeat') ?? '1'
  const repeats = Number(repeatText)
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new InvalidArgumentsError('--repeat must be positive')
  const numberOption = (name, fallback, minimum) => {
    const text = values.get(name)
    if (text === undefined) return fallback
    const number = Number(text)
    if (!Number.isSafeInteger(number) || number < minimum) throw new InvalidArgumentsError(`${name} is invalid`)
    return number
  }
  if (liveModel === undefined) {
    return {
      datasetPath,
      repeats,
      mode: 'offline-hash',
      reportOnly: flags.has('--report-only'),
      baselinePath: values.get('--baseline'),
      gatesPath: values.get('--gates'),
    }
  }
  const spaceId = values.get('--space-id')
  const dimensionsText = values.get('--dimensions')
  if (spaceId === undefined || dimensionsText === undefined) {
    throw new InvalidArgumentsError('live mode requires --space-id and --dimensions')
  }
  const dimensions = Number(dimensionsText)
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new InvalidArgumentsError('--dimensions is invalid')
  const baseUrl = process.env.DASHSCOPE_API_URL
  const apiKey = process.env.DASHSCOPE_API_KEY
  if (baseUrl === undefined || baseUrl.length === 0 || apiKey === undefined || apiKey.length === 0) {
    throw new InvalidArgumentsError('live mode requires DASHSCOPE_API_URL and DASHSCOPE_API_KEY')
  }
  return {
    datasetPath,
    repeats,
    mode: 'live',
    model: liveModel,
    spaceId,
    dimensions,
    baseUrl,
    apiKey,
    batchSize: numberOption('--batch-size', 128, 1),
    timeoutMs: numberOption('--timeout-ms', 30_000, 1),
    maxRetries: numberOption('--max-retries', 2, 0),
    retryBaseDelayMs: numberOption('--retry-base-delay-ms', 100, 1),
    reportOnly: flags.has('--report-only'),
    baselinePath: values.get('--baseline'),
    gatesPath: values.get('--gates'),
  }
}

async function readBaseline(path, report) {
  let baseline
  try {
    baseline = JSON.parse(await readFile(path, 'utf8'))
    validateEmbeddingReport(baseline)
  } catch (error) {
    throw new InvalidBaselineError(error instanceof Error ? error.message : String(error))
  }
  if (canonicalJson(baseline.dataset) !== canonicalJson(report.dataset)) {
    throw new InvalidBaselineError('baseline dataset does not match report')
  }
  return baseline
}

async function readGates(path, report, baseline) {
  let gates
  try {
    gates = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidGatesError(error instanceof Error ? error.message : String(error))
  }
  const exactObject = (value, name, keys) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new InvalidGatesError(`${name} must be an object`)
    }
    for (const key of keys) if (!Object.hasOwn(value, key)) throw new InvalidGatesError(`${name}.${key} is required`)
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) throw new InvalidGatesError(`${name} has additional property '${key}'`)
    }
    return value
  }
  const root = exactObject(gates, 'gates', ['schemaVersion', 'dataset', 'offline', 'live', 'hardChecks'])
  if (root.schemaVersion !== 1) throw new InvalidGatesError('gates.schemaVersion must equal 1')
  if (canonicalJson(root.dataset) !== canonicalJson(baseline.dataset)
    || canonicalJson(root.dataset) !== canonicalJson(report.dataset)) {
    throw new InvalidGatesError('gates dataset does not match baseline and report')
  }
  const offline = exactObject(root.offline, 'gates.offline', ['metrics'])
  if (canonicalJson(offline.metrics) !== canonicalJson(baseline.metrics)) {
    throw new InvalidGatesError('gates.offline.metrics does not match baseline metrics')
  }
  const live = exactObject(root.live, 'gates.live', [
    'relativeSynonymRecallAt10Floor', 'exactRecallAt10Floor',
  ])
  if (typeof live.relativeSynonymRecallAt10Floor !== 'number'
    || !Number.isFinite(live.relativeSynonymRecallAt10Floor)
    || live.relativeSynonymRecallAt10Floor < 0) {
    throw new InvalidGatesError('gates.live.relativeSynonymRecallAt10Floor must be a non-negative number')
  }
  if (typeof live.exactRecallAt10Floor !== 'number'
    || !Number.isFinite(live.exactRecallAt10Floor)
    || live.exactRecallAt10Floor < 0
    || live.exactRecallAt10Floor > 1) {
    throw new InvalidGatesError('gates.live.exactRecallAt10Floor must be from 0 through 1')
  }
  const hard = exactObject(root.hardChecks, 'gates.hardChecks', [
    'scopeLeaks', 'forbiddenHits', 'duplicateResultIds',
  ])
  for (const key of ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds']) {
    if (!Number.isSafeInteger(hard[key]) || hard[key] < 0) {
      throw new InvalidGatesError(`gates.hardChecks.${key} must be a non-negative integer`)
    }
  }
  return gates
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`embedding: invalid arguments: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  try {
    const report = await runEmbedding(options)
    const output = `${canonicalJson(report)}\n`
    let configuredGates
    let baseline
    if (!options.reportOnly && (options.baselinePath !== undefined || options.gatesPath !== undefined)) {
      if (options.baselinePath === undefined || options.gatesPath === undefined) {
        throw new InvalidArgumentsError('--baseline and --gates must be supplied together')
      }
      baseline = await readBaseline(options.baselinePath, report)
      configuredGates = await readGates(options.gatesPath, report, baseline)
      if (options.mode === 'offline-hash') {
        if (canonicalJson(report) !== canonicalJson(baseline)) {
          process.stdout.write(output)
          process.stderr.write('embedding: offline baseline regression\n')
          process.exitCode = 2
          return
        }
      } else {
        const gate = evaluateEmbeddingGates(baseline, report, configuredGates)
        if (!gate.passed) {
          process.stdout.write(output)
          process.stderr.write(`embedding: quality gate failed: ${gate.failures.join(', ')}\n`)
          process.exitCode = 2
          return
        }
      }
    }
    if (configuredGates === undefined) {
      const hardFailures = Object.entries(report.hardChecks).filter(([, value]) => value !== 0).map(([key]) => key)
      if (hardFailures.length > 0) {
        process.stdout.write(output)
        process.stderr.write(`embedding: hard check failed: ${hardFailures.join(', ')}\n`)
        process.exitCode = 2
        return
      }
    }
    process.stdout.write(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof InvalidDatasetError) process.stderr.write(`embedding: invalid dataset: ${message}\n`)
    else if (error instanceof InvalidArgumentsError) process.stderr.write(`embedding: invalid arguments: ${message}\n`)
    else if (error instanceof InvalidBaselineError) process.stderr.write(`embedding: invalid baseline: ${message}\n`)
    else if (error instanceof InvalidGatesError) process.stderr.write(`embedding: invalid gates: ${message}\n`)
    else process.stderr.write(`embedding: runtime error: ${message}\n`)
    process.exitCode = 1
  }
}

const entry = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (entry !== undefined && entry === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
