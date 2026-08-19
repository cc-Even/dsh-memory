import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MemoryService from '../lib/index.js'
import {
  canonicalJson,
  computeLifecycleMetrics,
  validateLifecycleDataset,
  validateLifecycleReport,
} from './lifecycle-metrics.mjs'

const PROVIDER = 'lifecycle-scripted-provider'
const MODEL = 'lifecycle-scripted-model'
const DERIVED_LAYERS = new Set(['l2_fact', 'l4_identity'])
const OWNER_FIELDS = ['tenantId', 'userId', 'agentId']

class InvalidDatasetError extends Error {}
class InvalidGatesError extends Error {}

function ownerScope(owner, sessionId) {
  return {
    ...(owner.tenantId === undefined ? {} : { tenantId: owner.tenantId }),
    userId: owner.userId,
    agentId: owner.agentId,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

function sameOwner(scope, owner) {
  return OWNER_FIELDS.every(key => (scope[key] ?? undefined) === (owner[key] ?? undefined))
}

function phaseFromOptions(options) {
  const system = typeof options.system === 'string' ? options.system : ''
  if (system.includes('extract durable user memory')) return 'extraction'
  if (system.includes('reconcile durable user memories')) return 'reconciliation'
  return 'unknown'
}

function materializePayload(payload, aliases) {
  const value = structuredClone(payload)
  if (!Array.isArray(value.operations)) return value
  value.operations = value.operations.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const operation = { ...raw }
    if (Object.hasOwn(operation, 'duplicateAlias')) {
      const alias = operation.duplicateAlias
      operation.duplicateOf = aliases.get(alias)
      delete operation.duplicateAlias
    }
    if (Object.hasOwn(operation, 'targetAliases')) {
      operation.targetIds = Array.isArray(operation.targetAliases)
        ? operation.targetAliases.map(alias => aliases.get(alias))
        : operation.targetAliases
      delete operation.targetAliases
    }
    return operation
  })
  return value
}

/** A deterministic seam adapter that receives scripts and runtime alias IDs only. */
class ScriptAdapter extends LlmAdapter {
  constructor(script, aliases) {
    super()
    this.script = structuredClone(script)
    this.aliases = new Map(aliases)
    this.index = 0
    this.errors = 0
  }

  async * stream(options) {
    const step = this.script[this.index]
    this.index += 1
    if (step === undefined) {
      this.errors += 1
      throw new Error('script adapter underflow')
    }
    if (phaseFromOptions(options) !== step.phase) this.errors += 1
    if (step.outcome === 'throw') throw new Error(`script adapter failure: ${step.errorCode}`)
    const text = step.outcome === 'invalid_json'
      ? step.rawText
      : JSON.stringify(materializePayload(step.payload, this.aliases))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  consumptionErrors() {
    return this.errors + Math.abs(this.script.length - this.index)
  }
}

async function finishCase(ctx, root, primaryErrors = []) {
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
    throw new AggregateError(errors, 'Lifecycle case evaluation and cleanup failed', {
      cause: primaryErrors[0],
    })
  }
}

async function openCase() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lifecycle-'))
  let ctx
  try {
    ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(MemoryService, {
      provider: PROVIDER,
      model: MODEL,
      userId: 'lifecycle-scripted-user',
      autoCapture: false,
      autoRecall: false,
    })
    return { ctx, root }
  } catch (error) {
    if (ctx === undefined) {
      const cleanupErrors = []
      try {
        await rm(root, { recursive: true, force: true })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Lifecycle Context construction and cleanup failed', {
          cause: error,
        })
      }
      throw error
    }
    await finishCase(ctx, root, [error])
  }
}

function activeDerived(record) {
  return DERIVED_LAYERS.has(record.layer) && record.status === 'active'
}

function classifyObservation(before, after, aliases, raw) {
  const beforeIds = new Set(before.map(record => record.id))
  const idToAlias = new Map([...aliases].map(([alias, id]) => [id, alias]))
  const recordsById = new Map(after.map(record => [record.id, record]))
  const newDerived = after.filter(record => activeDerived(record) && !beforeIds.has(record.id))
  const candidates = []

  if (newDerived.length === 1) {
    const head = newDerived[0]
    const linkedToRaw = raw !== undefined && head.sourceMemoryIds.includes(raw.id)
    if (linkedToRaw && head.supersedes.length === 0 && head.consolidates.length === 0) {
      candidates.push({ operation: 'ADD', aliases: [] })
    }
    for (const relation of [
      { operation: 'SUPERSEDE', ids: head.supersedes, other: head.consolidates, minimum: 1 },
      { operation: 'CONSOLIDATE', ids: head.consolidates, other: head.supersedes, minimum: 2 },
    ]) {
      const targetAliases = relation.ids.map(id => idToAlias.get(id))
      const reverseValid = relation.ids.every((id) => {
        const target = recordsById.get(id)
        return target !== undefined && target.supersededBy.includes(head.id)
      })
      if (linkedToRaw && relation.ids.length >= relation.minimum && relation.other.length === 0
        && targetAliases.every(alias => alias !== undefined) && reverseValid) {
        candidates.push({ operation: relation.operation, aliases: targetAliases })
      }
    }
  }

  if (newDerived.length === 0 && raw !== undefined) {
    const evidenceAliases = []
    for (const [alias, id] of aliases) {
      const prior = before.find(record => record.id === id)
      const current = recordsById.get(id)
      if (prior !== undefined && current !== undefined
        && !prior.sourceMemoryIds.includes(raw.id) && current.sourceMemoryIds.includes(raw.id)) {
        evidenceAliases.push(alias)
      }
    }
    if (evidenceAliases.length === 1) candidates.push({ operation: 'NOOP', aliases: evidenceAliases })
  }

  return {
    operation: candidates.length === 1 ? candidates[0].operation : null,
    targetAliases: candidates.length === 1 ? [...candidates[0].aliases].sort() : [],
    ambiguous: candidates.length !== 1,
    newDerived,
  }
}

function conflictLabel(expected, observed) {
  if (expected === null || observed === null) return null
  if (expected === 'SUPERSEDE') return observed === 'SUPERSEDE' ? 'TP' : 'FN'
  return observed === 'SUPERSEDE' ? 'FP' : 'TN'
}

async function evaluateCase(fixture) {
  const opened = await openCase()
  if (opened === undefined) throw new Error('Lifecycle Context setup did not complete')
  const { ctx, root } = opened
  const primaryErrors = []
  try {
    const scope = ownerScope(fixture.owner, fixture.sessionId)
    const aliases = new Map()
    for (const setup of fixture.setup) {
      const receipt = await ctx.memory.add({
        scope,
        content: setup.content,
        layer: setup.layer,
        idempotencyKey: `${fixture.id}-setup-${setup.alias}`,
      })
      const derivedId = receipt.createdMemoryIds[0]
      if (derivedId === undefined || ctx.memory.get(derivedId, scope) === undefined) {
        throw new Error(`Lifecycle setup '${fixture.id}/${setup.alias}' did not create a public derived record`)
      }
      aliases.set(setup.alias, derivedId)
    }
    const before = [...ctx.memory.export(scope)]
    const adapter = new ScriptAdapter(fixture.modelScript, aliases)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    const receipt = await ctx.memory.add({
      scope,
      content: fixture.content,
      mode: 'extract',
      idempotencyKey: fixture.idempotencyKey,
    })
    const after = [...ctx.memory.export(scope)]
    const rawCandidate = ctx.memory.get(receipt.rawMemoryId, scope)
    const rawInExport = after.find(record => record.id === receipt.rawMemoryId)
    const rawFirstPass = rawCandidate !== undefined
      && rawInExport !== undefined
      && rawCandidate.id === receipt.rawMemoryId
      && rawCandidate.layer === 'l1_raw'
      && rawCandidate.idempotencyKey === fixture.idempotencyKey
      && sameOwner(rawCandidate.scope, fixture.owner)
      && rawCandidate.status === 'active'
      && (receipt.status !== 'degraded' || rawCandidate.visibility === 'recallable')
    const raw = rawFirstPass ? rawCandidate : undefined
    const observation = classifyObservation(before, after, aliases, raw)
    const ownerLeaks = after.filter(record => !sameOwner(record.scope, fixture.owner)).length
    const unexpectedDerivedOnDegraded = receipt.status === 'degraded'
      ? observation.newDerived.length
      : 0
    const expectedDuplicateId = fixture.expected.duplicateTargetAlias === undefined
      ? undefined
      : aliases.get(fixture.expected.duplicateTargetAlias)
    const expectedDuplicate = expectedDuplicateId === undefined
      ? undefined
      : after.find(record => record.id === expectedDuplicateId)
    const noNewActiveDerived = fixture.measurements.duplicate
      ? observation.newDerived.length === 0
      : null
    const evidenceAttached = fixture.measurements.duplicate
      ? raw !== undefined && expectedDuplicate !== undefined && expectedDuplicate.sourceMemoryIds.includes(raw.id)
      : null
    const duplicateCompressed = fixture.measurements.duplicate
      ? noNewActiveDerived === true && evidenceAttached === true
      : null
    const ambiguity = fixture.faultScenario === 'nominal' && observation.ambiguous ? 1 : 0
    const observedOperation = fixture.faultScenario === 'nominal' ? observation.operation : null
    const observedTargetAliases = fixture.faultScenario === 'nominal' ? observation.targetAliases : []

    return {
      case: {
        id: fixture.id,
        language: fixture.language,
        role: fixture.role,
        scenario: fixture.faultScenario,
        expectedOperation: fixture.expected.operation,
        observedOperation,
        conflictLabel: conflictLabel(fixture.expected.operation, observedOperation),
        receiptStatus: receipt.status,
        observedTargetAliases,
        newActiveDerivedCount: observation.newDerived.length,
        duplicateObservation: {
          measured: fixture.measurements.duplicate,
          noNewActiveDerived,
          evidenceAttachedToExpectedTarget: evidenceAttached,
          compressed: duplicateCompressed,
        },
        rawFirstPass,
      },
      hardChecks: {
        rawFirstViolations: rawFirstPass ? 0 : 1,
        unexpectedDerivedOnDegraded,
        observationAmbiguities: ambiguity,
        scriptConsumptionErrors: adapter.consumptionErrors(),
        unexpectedReceiptStatuses: receipt.status === fixture.expected.receiptStatus ? 0 : 1,
        scopeLeaks: ownerLeaks,
      },
    }
  } catch (error) {
    primaryErrors.push(error)
  } finally {
    await finishCase(ctx, root, primaryErrors)
  }
}

function sumHardChecks(results) {
  const total = {
    rawFirstViolations: 0,
    unexpectedDerivedOnDegraded: 0,
    observationAmbiguities: 0,
    scriptConsumptionErrors: 0,
    unexpectedReceiptStatuses: 0,
    scopeLeaks: 0,
  }
  for (const result of results) {
    for (const key of Object.keys(total)) total[key] += result.hardChecks[key]
  }
  return total
}

async function evaluateOnce(dataset, repeats) {
  const results = []
  for (const fixture of dataset.cases) results.push(await evaluateCase(fixture))
  const cases = results.map(result => result.case)
  const metrics = computeLifecycleMetrics(cases.map(item => ({
    id: item.id,
    language: item.language,
    faultScenario: item.scenario,
    expectedOperation: item.expectedOperation,
    observedOperation: item.observedOperation,
    receiptStatus: item.receiptStatus,
    duplicateMeasured: item.duplicateObservation.measured,
    noNewActiveDerived: item.duplicateObservation.noNewActiveDerived,
    evidenceAttachedToExpectedTarget: item.duplicateObservation.evidenceAttachedToExpectedTarget,
  })))
  const report = {
    schemaVersion: 1,
    dataset: {
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      referenceCommit: dataset.referenceCommit,
    },
    runner: { version: 1, repeats },
    provenance: { ...dataset.provenance },
    counts: {
      totalCases: dataset.cases.length,
      nominalCases: dataset.cases.filter(item => item.faultScenario === 'nominal').length,
      faultCases: dataset.cases.filter(item => item.faultScenario !== 'nominal').length,
      acceptedExtractWrites: dataset.cases.length,
    },
    metrics,
    cases,
    hardChecks: sumHardChecks(results),
  }
  validateLifecycleReport(report)
  return report
}

async function loadDataset(path) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidDatasetError(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    validateLifecycleDataset(parsed)
  } catch (error) {
    throw new InvalidDatasetError(error instanceof Error ? error.message : String(error))
  }
  return parsed
}

/** Run every scripted case through a fresh real MemoryService pipeline per repeat. */
export async function runLifecycle({ datasetPath, repeats }) {
  if (typeof datasetPath !== 'string' || datasetPath.length === 0) throw new TypeError('datasetPath is required')
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new TypeError('repeats must be a positive integer')
  const dataset = await loadDataset(datasetPath)
  let report
  let canonical
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const current = await evaluateOnce(dataset, repeats)
    const currentCanonical = canonicalJson(current)
    if (canonical !== undefined && currentCanonical !== canonical) {
      throw new Error(`Lifecycle report is nondeterministic at repeat ${repeat + 1}`)
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
  for (const key of Object.keys(value)) if (!required.includes(key)) throw new InvalidGatesError(`${path} has additional property '${key}'`)
  return value
}

async function loadGates(path) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new InvalidGatesError(`cannot read JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const gates = gateObject(parsed, 'gates', ['schemaVersion', 'dataset', 'provenance', 'metrics', 'cases', 'hardChecks'])
  if (gates.schemaVersion !== 1) throw new InvalidGatesError('gates.schemaVersion must equal 1')
  try {
    validateLifecycleReport({
      schemaVersion: gates.schemaVersion,
      dataset: gates.dataset,
      runner: { version: 1, repeats: 1 },
      provenance: gates.provenance,
      counts: { totalCases: 20, nominalCases: 14, faultCases: 6, acceptedExtractWrites: 20 },
      metrics: gates.metrics,
      cases: gates.cases,
      hardChecks: gates.hardChecks,
    })
  } catch (error) {
    throw new InvalidGatesError(error instanceof Error ? error.message : String(error))
  }
  return gates
}

function conformanceProjection(report) {
  return {
    schemaVersion: 1,
    dataset: report.dataset,
    provenance: report.provenance,
    metrics: report.metrics,
    cases: report.cases,
    hardChecks: report.hardChecks,
  }
}

function nonzeroHardChecks(report) {
  return Object.entries(report.hardChecks).filter(([, value]) => value !== 0).map(([key]) => key)
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`lifecycle: argument error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  let gates
  if (options.gatesPath !== undefined) {
    try {
      gates = await loadGates(resolve(options.gatesPath))
    } catch (error) {
      if (error instanceof InvalidGatesError) {
        process.stderr.write(`lifecycle: gate error: ${error.message}\n`)
        return 1
      }
      throw error
    }
  }
  let report
  try {
    report = await runLifecycle({ datasetPath: resolve(options.datasetPath), repeats: options.repeats })
  } catch (error) {
    process.stderr.write(`lifecycle: runtime error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  process.stdout.write(`${canonicalJson(report)}\n`)
  const hardFailures = nonzeroHardChecks(report)
  if (hardFailures.length > 0) {
    process.stderr.write(`lifecycle: hard check failed: ${hardFailures.join(', ')}\n`)
    return 2
  }
  if (!options.reportOnly && gates !== undefined
    && canonicalJson(gates) !== canonicalJson(conformanceProjection(report))) {
    process.stderr.write('lifecycle: conformance mismatch: report differs from exact gates\n')
    return 2
  }
  return 0
}

const entry = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (entry === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2))
}
