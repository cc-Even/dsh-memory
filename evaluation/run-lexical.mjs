import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  computeLexicalMetrics,
  evaluateLexicalGates,
  validateLexicalDataset,
  validateLexicalReport,
} from './lexical-metrics.mjs'

class InvalidArgumentsError extends Error {}
class InvalidDatasetError extends Error {}
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

function expandedRecords(group) {
  return [
    ...group.records,
    ...group.sharedInterference,
    ...['continuous_cjk', 'punctuation_boundary', 'short_term'].flatMap(bucket =>
      group.distractorCodes[bucket].map((content, index) => ({
        id: group.distractorIds[bucket][index],
        content,
      }))),
  ]
}

function materializeRecord(fixture, owner, sourceSessionId, evaluationTime) {
  return {
    schemaVersion: 1,
    id: fixture.id,
    scope: ownerScope(owner, sourceSessionId),
    layer: 'l2_fact',
    content: fixture.content,
    status: fixture.status ?? 'active',
    visibility: fixture.visibility ?? 'recallable',
    sourceType: 'explicit',
    confidence: 1,
    ...(fixture.validUntil === undefined ? {} : { validUntil: fixture.validUntil }),
    createdAt: evaluationTime,
    updatedAt: evaluationTime,
    revision: 1,
    supersedes: [],
    supersededBy: [],
    consolidates: [],
    sourceMemoryIds: [],
    sourceSessionId,
    sourceTurnIndexes: [],
    tags: [],
    meta: {},
    embedding: {
      spaceId: HASH_EMBEDDING_SPACE_ID,
      dimensions: HASH_EMBEDDING_DIMENSIONS,
      vector: hashEmbedding(fixture.content),
    },
  }
}

async function finishContext(ctx, root, primaryErrors = []) {
  const settled = await Promise.allSettled([
    Promise.resolve().then(() => ctx.fiber.dispose()),
    Promise.resolve().then(() => rm(root, { recursive: true, force: true })),
  ])
  const errors = [
    ...primaryErrors,
    ...settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []),
  ]
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'lexical evaluation and cleanup failed')
}

async function openContext(kind) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lexical-eval-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(MemoryService, {
      provider: 'lexical-evaluation-llm',
      model: 'lexical-evaluation-model',
      userId: 'lexical-evaluation-user',
      autoCapture: false,
      autoRecall: false,
      tokenizer: { kind },
    })
    return { ctx, root }
  } catch (error) {
    await finishContext(ctx, root, [error])
  }
}

function scopeLeakCount(query, hits, recordsById, evaluationTime) {
  let leaks = 0
  for (const hit of hits) {
    const fixture = recordsById.get(hit.memory.id)
    if (fixture === undefined
      || ownerKey(fixture.owner) !== ownerKey(query.owner)
      || hit.memory.status !== 'active'
      || hit.memory.visibility !== 'recallable'
      || (fixture.validUntil !== undefined && fixture.validUntil <= evaluationTime)
      || (query.sessionOnly && fixture.sourceSessionId !== query.sessionId)) leaks += 1
  }
  return leaks
}

function materializedFixtures(dataset) {
  return [
    ...dataset.groups.flatMap(group => expandedRecords(group).map(record => ({
      ...record,
      owner: group.owner,
      sourceSessionId: group.sourceSessionId,
      status: 'active',
      visibility: 'recallable',
    }))),
    ...dataset.filterRecords,
  ]
}

async function evaluateOnce(dataset, kind) {
  const opened = await openContext(kind)
  if (opened === undefined) throw new Error('lexical evaluation context did not open')
  const { ctx, root } = opened
  const primaryErrors = []
  try {
    const fixtures = materializedFixtures(dataset)
    const groups = new Map()
    for (const fixture of fixtures) {
      const key = ownerKey(fixture.owner)
      const group = groups.get(key) ?? { owner: fixture.owner, records: [] }
      group.records.push(materializeRecord(
        fixture,
        fixture.owner,
        fixture.sourceSessionId,
        dataset.evaluationTime,
      ))
      groups.set(key, group)
    }
    for (const key of [...groups.keys()].sort()) {
      const group = groups.get(key)
      await ctx.memory.import(ownerScope(group.owner), group.records)
    }

    const recordsById = new Map(fixtures.map(record => [record.id, record]))
    const rankings = []
    for (const group of dataset.groups) {
      for (const query of group.queries) {
        const queryScope = ownerScope(group.owner, group.sourceSessionId)
        const result = await ctx.memory.search({
          scope: queryScope,
          query: query.query,
          sessionOnly: false,
          limit: 10,
          profileLimit: 0,
        })
        const hits = [...result.channels.normal, ...result.channels.profile]
        rankings.push({
          id: query.id,
          bucket: query.bucket,
          split: query.split,
          relevantIds: [...query.relevantIds],
          forbiddenIds: [],
          returnedIds: result.channels.normal.map(hit => hit.memory.id),
          scopeLeaks: scopeLeakCount({ ...query, owner: group.owner, sessionOnly: false }, hits, recordsById, dataset.evaluationTime),
        })
      }
    }
    for (const query of dataset.filterQueries) {
      const result = await ctx.memory.search({
        scope: ownerScope(query.owner, query.sessionId),
        query: query.query,
        sessionOnly: query.sessionOnly,
        limit: 10,
        profileLimit: 0,
      })
      const hits = [...result.channels.normal, ...result.channels.profile]
      rankings.push({
        id: query.id,
        bucket: 'filter',
        split: 'filter',
        relevantIds: [],
        forbiddenIds: [...query.forbiddenIds],
        returnedIds: result.channels.normal.map(hit => hit.memory.id),
        scopeLeaks: scopeLeakCount(query, hits, recordsById, dataset.evaluationTime),
      })
    }
    return rankings
  } catch (error) {
    primaryErrors.push(error)
  } finally {
    await finishContext(ctx, root, primaryErrors)
  }
}

async function readDataset(path) {
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidDatasetError(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    validateLexicalDataset(value)
  } catch (error) {
    throw new InvalidDatasetError(error instanceof Error ? error.message : String(error))
  }
  return value
}

/** Run both tokenizer modes through fresh built-package contexts and public import/search. */
export async function runLexical(options) {
  if (!Number.isSafeInteger(options.repeats) || options.repeats < 1) {
    throw new InvalidArgumentsError('repeats must be positive')
  }
  const dataset = await readDataset(options.datasetPath)
  let measured
  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    const current = computeLexicalMetrics(
      await evaluateOnce(dataset, 'legacy'),
      await evaluateOnce(dataset, 'cjk-bigram'),
    )
    if (measured !== undefined && canonicalJson(current) !== canonicalJson(measured)) {
      throw new Error('lexical evaluation was not deterministic across repeats')
    }
    measured = current
  }
  const report = {
    schemaVersion: 1,
    dataset: {
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      referenceCommit: dataset.referenceCommit,
    },
    runner: { version: 1, repeats: options.repeats, externalNetwork: false },
    embeddingSpace: { id: HASH_EMBEDDING_SPACE_ID, dimensions: HASH_EMBEDDING_DIMENSIONS },
    ...measured,
  }
  validateLexicalReport(report)
  return report
}

function parseArguments(argv) {
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--report-only') {
      flags.add(argument)
      continue
    }
    if (!argument?.startsWith('--')) throw new InvalidArgumentsError(`unexpected argument '${String(argument)}'`)
    if (!['--dataset', '--baseline', '--gates', '--repeat'].includes(argument)) {
      throw new InvalidArgumentsError(`unknown option '${argument}'`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new InvalidArgumentsError(`${argument} requires a value`)
    values.set(argument, value)
    index += 1
  }
  const datasetPath = values.get('--dataset')
  if (datasetPath === undefined) throw new InvalidArgumentsError('--dataset is required')
  const repeats = Number(values.get('--repeat') ?? '1')
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new InvalidArgumentsError('--repeat must be positive')
  const baselinePath = values.get('--baseline')
  const gatesPath = values.get('--gates')
  if (!flags.has('--report-only') && (baselinePath === undefined) !== (gatesPath === undefined)) {
    throw new InvalidArgumentsError('--baseline and --gates must be supplied together')
  }
  return { datasetPath, repeats, baselinePath, gatesPath, reportOnly: flags.has('--report-only') }
}

async function readBaseline(path, report) {
  let baseline
  try {
    baseline = JSON.parse(await readFile(path, 'utf8'))
    validateLexicalReport(baseline)
  } catch (error) {
    throw new InvalidBaselineError(error instanceof Error ? error.message : String(error))
  }
  if (canonicalJson(baseline.dataset) !== canonicalJson(report.dataset)) {
    throw new InvalidBaselineError('baseline dataset does not match report')
  }
  if (canonicalJson(baseline.runner) !== canonicalJson({ version: 1, repeats: 2, externalNetwork: false })) {
    throw new InvalidBaselineError('baseline runner provenance is invalid')
  }
  if (canonicalJson(baseline.embeddingSpace) !== canonicalJson(report.embeddingSpace)) {
    throw new InvalidBaselineError('baseline embedding space does not match report')
  }
  if (canonicalJson(baseline.modes.legacy.tokenizer)
    !== canonicalJson({ kind: 'legacy', implementation: 'LegacyTokenizer' })) {
    throw new InvalidBaselineError('baseline legacy tokenizer provenance is invalid')
  }
  if (canonicalJson(baseline.modes.cjkBigram.tokenizer)
    !== canonicalJson({ kind: 'cjk-bigram', implementation: 'CjkBigramTokenizer' })) {
    throw new InvalidBaselineError('baseline CJK tokenizer provenance is invalid')
  }
  return baseline
}

async function readGates(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidGatesError(error instanceof Error ? error.message : String(error))
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`lexical: invalid arguments: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
    return
  }
  try {
    const report = await runLexical(options)
    const output = `${canonicalJson(report)}\n`
    if (!options.reportOnly && options.baselinePath !== undefined && options.gatesPath !== undefined) {
      const baseline = await readBaseline(options.baselinePath, report)
      const gates = await readGates(options.gatesPath)
      let result
      try {
        result = evaluateLexicalGates(report, gates)
      } catch (error) {
        throw new InvalidGatesError(error instanceof Error ? error.message : String(error))
      }
      const failures = [
        ...(canonicalJson(baseline.modes.legacy) === canonicalJson(report.modes.legacy)
          ? []
          : ['legacy mode does not match baseline']),
        ...result.failures,
      ]
      if (failures.length > 0) {
        process.stdout.write(output)
        process.stderr.write(`lexical: gate failed: ${failures.join(', ')}\n`)
        process.exitCode = 2
        return
      }
    } else {
      const failures = Object.entries(report.modes)
        .flatMap(([mode, value]) => Object.entries(value.hardChecks)
          .filter(([, count]) => count !== 0).map(([key]) => `${mode}.${key}`))
      if (failures.length > 0) {
        process.stdout.write(output)
        process.stderr.write(`lexical: hard check failed: ${failures.join(', ')}\n`)
        process.exitCode = 2
        return
      }
    }
    process.stdout.write(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof InvalidDatasetError) process.stderr.write(`lexical: invalid dataset: ${message}\n`)
    else if (error instanceof InvalidArgumentsError) process.stderr.write(`lexical: invalid arguments: ${message}\n`)
    else if (error instanceof InvalidBaselineError) process.stderr.write(`lexical: invalid baseline: ${message}\n`)
    else if (error instanceof InvalidGatesError) process.stderr.write(`lexical: invalid gates: ${message}\n`)
    else process.stderr.write(`lexical: runtime error: ${message}\n`)
    process.exitCode = 1
  }
}

const entry = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (entry !== undefined && entry === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
