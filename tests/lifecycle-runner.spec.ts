import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type {
  AddMemoryInput,
  MemoryRecord,
  MemoryScope,
  WriteReceipt,
} from '../src/types.ts'

type Language = 'zh' | 'en'
type Operation = 'ADD' | 'NOOP' | 'CONSOLIDATE' | 'SUPERSEDE'
type FaultScenario = 'nominal' | 'injected_model_failure' | 'invalid_json' | 'schema_failure'

interface LifecycleCaseFixture {
  readonly id: string
  readonly language: Language
  readonly role: string
  readonly faultScenario: FaultScenario
  readonly owner: { readonly tenantId?: string; readonly userId: string; readonly agentId: string }
  readonly sessionId: string
  readonly content: string
  readonly idempotencyKey: string
  readonly setup: readonly { readonly alias: string; readonly content: string; readonly layer: 'l2_fact' | 'l4_identity' }[]
  readonly modelScript: readonly unknown[]
  readonly measurements: { readonly conflict: boolean; readonly duplicate: boolean; readonly degradation: true }
  readonly expected: {
    readonly operation: Operation | null
    readonly targetAliases: readonly string[]
    readonly duplicateTargetAlias?: string
    readonly receiptStatus: 'completed' | 'degraded'
  }
}

interface LifecycleDataset {
  readonly schemaVersion: 1
  readonly datasetId: string
  readonly datasetVersion: string
  readonly referenceCommit: string
  readonly provenance: LifecycleReport['provenance']
  readonly cases: readonly LifecycleCaseFixture[]
}

interface CaseReport {
  readonly id: string
  readonly language: Language
  readonly role: string
  readonly scenario: FaultScenario
  readonly expectedOperation: Operation | null
  readonly observedOperation: Operation | null
  readonly conflictLabel: 'TP' | 'TN' | 'FP' | 'FN' | null
  readonly receiptStatus: 'completed' | 'degraded'
  readonly observedTargetAliases: readonly string[]
  readonly newActiveDerivedCount: number
  readonly duplicateObservation: {
    readonly measured: boolean
    readonly noNewActiveDerived: boolean | null
    readonly evidenceAttachedToExpectedTarget: boolean | null
    readonly compressed: boolean | null
  }
  readonly rawFirstPass: boolean
}

interface LifecycleReport {
  readonly schemaVersion: 1
  readonly dataset: { readonly id: string; readonly version: string; readonly referenceCommit: string }
  readonly runner: { readonly version: 1; readonly repeats: number }
  readonly provenance: {
    readonly mode: 'scripted'
    readonly interpretation: 'pipeline-conformance-only'
    readonly adapter: 'deterministic-script-adapter-v1'
    readonly externalNetwork: false
    readonly modelQualityClaim: false
  }
  readonly counts: {
    readonly totalCases: 20
    readonly nominalCases: 14
    readonly faultCases: 6
    readonly acceptedExtractWrites: 20
  }
  readonly metrics: {
    readonly conflictAccuracy: {
      readonly status: 'measured'
      readonly value: number
      readonly numerator: number
      readonly denominator: number
      readonly confusion: Readonly<Record<string, number>>
    }
    readonly duplicateCompressionRate: {
      readonly status: 'measured'
      readonly value: number
      readonly compressed: number
      readonly total: number
    }
    readonly degradationRate: {
      readonly status: 'measured_by_scenario'
      readonly scenarios: Readonly<Record<FaultScenario, {
        readonly accepted: number
        readonly degraded: number
        readonly value: number
      }>>
    }
  }
  readonly cases: readonly CaseReport[]
  readonly hardChecks: {
    readonly rawFirstViolations: number
    readonly unexpectedDerivedOnDegraded: number
    readonly observationAmbiguities: number
    readonly scriptConsumptionErrors: number
    readonly unexpectedReceiptStatuses: number
    readonly scopeLeaks: number
  }
}

interface RunnerModule {
  runLifecycle(options: { readonly datasetPath: string; readonly repeats: number }): Promise<LifecycleReport>
}

interface MetricsModule {
  canonicalJson(value: unknown): string
  validateLifecycleReport(value: unknown): void
  computeLifecycleMetrics(cases: readonly {
    readonly id: string
    readonly language: Language
    readonly faultScenario: FaultScenario
    readonly expectedOperation: Operation | null
    readonly observedOperation: Operation | null
    readonly receiptStatus: 'completed' | 'degraded'
    readonly duplicateMeasured: boolean
    readonly noNewActiveDerived: boolean | null
    readonly evidenceAttachedToExpectedTarget: boolean | null
  }[]): LifecycleReport['metrics']
}

interface MemoryPrototype {
  add(input: AddMemoryInput, signal?: AbortSignal): Promise<WriteReceipt>
  export(scope: MemoryScope): readonly MemoryRecord[]
  get(memoryId: MemoryRecord['id'], scope: MemoryScope): MemoryRecord | undefined
  list(input: { readonly scope: MemoryScope }): readonly MemoryRecord[]
  import(scope: MemoryScope, records: readonly MemoryRecord[]): Promise<number>
}

interface BuiltMemoryModule {
  readonly default: { readonly prototype: MemoryPrototype }
}

interface ConformanceGates {
  readonly schemaVersion: 1
  readonly dataset: LifecycleReport['dataset']
  readonly provenance: LifecycleReport['provenance']
  readonly metrics: LifecycleReport['metrics']
  readonly cases: LifecycleReport['cases']
  readonly hardChecks: LifecycleReport['hardChecks']
}

const workspace = fileURLToPath(new URL('..', import.meta.url))
const runnerPath = fileURLToPath(new URL('../evaluation/run-lifecycle.mjs', import.meta.url))
const runnerUrl = new URL('../evaluation/run-lifecycle.mjs', import.meta.url)
const metricsUrl = new URL('../evaluation/lifecycle-metrics.mjs', import.meta.url)
const builtMemoryUrl = new URL('../lib/index.js', import.meta.url)
const builtMemoryHref = builtMemoryUrl.href
const datasetPath = fileURLToPath(new URL('../evaluation/lifecycle/v1/cases.json', import.meta.url))
const baselinePath = fileURLToPath(new URL('../evaluation/lifecycle/v1/baseline.scripted-v1.json', import.meta.url))
const gatesPath = fileURLToPath(new URL('../evaluation/lifecycle/v1/gates.conformance.json', import.meta.url))
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const roots: string[] = []

async function loadRunner(): Promise<RunnerModule> {
  return await import(/* @vite-ignore */ runnerUrl.href) as RunnerModule
}

async function loadMetrics(): Promise<MetricsModule> {
  return await import(/* @vite-ignore */ metricsUrl.href) as MetricsModule
}

async function loadBuiltMemory(): Promise<BuiltMemoryModule> {
  return await import(builtMemoryUrl.href) as BuiltMemoryModule
}

async function readDataset(): Promise<LifecycleDataset> {
  return JSON.parse(await readFile(datasetPath, 'utf8')) as LifecycleDataset
}

async function temporaryJson(value: unknown, name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lifecycle-test-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

async function temporaryDataset(mutate: (value: { cases: LifecycleCaseFixture[] } & Omit<LifecycleDataset, 'cases'>) => void): Promise<string> {
  const value = structuredClone(await readDataset()) as { cases: LifecycleCaseFixture[] } & Omit<LifecycleDataset, 'cases'>
  mutate(value)
  return await temporaryJson(value, 'cases.json')
}

function runCli(args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}) {
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
    env: { ...env, ...extraEnv },
    maxBuffer: 16 * 1024 * 1024,
  })
}

async function temporaryModule(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-lifecycle-test-'))
  roots.push(root)
  const path = join(root, 'preload.mjs')
  await writeFile(path, source, 'utf8')
  return path
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

function stableObservation(item: CaseReport | undefined) {
  if (item === undefined) throw new Error('missing lifecycle case report')
  return {
    receiptStatus: item.receiptStatus,
    observedOperation: item.observedOperation,
    observedTargetAliases: item.observedTargetAliases,
    newActiveDerivedCount: item.newActiveDerivedCount,
    noNewActiveDerived: item.duplicateObservation.noNewActiveDerived,
    rawFirstPass: item.rawFirstPass,
  }
}

function activeDerivedRecord(record: MemoryRecord): boolean {
  return record.status === 'active' && (record.layer === 'l2_fact' || record.layer === 'l4_identity')
}

function installPublicStateTransform(
  prototype: MemoryPrototype,
  transform: (records: readonly MemoryRecord[]) => readonly MemoryRecord[],
): () => void {
  const originalExport = prototype.export
  const originalList = prototype.list
  const originalGet = prototype.get
  const exportSpy = vi.spyOn(prototype, 'export').mockImplementation(function (
    this: MemoryPrototype,
    scope: MemoryScope,
  ): readonly MemoryRecord[] {
    return transform(originalExport.call(this, scope))
  })
  const listSpy = vi.spyOn(prototype, 'list').mockImplementation(function (
    this: MemoryPrototype,
    input: { readonly scope: MemoryScope },
  ): readonly MemoryRecord[] {
    return transform(originalList.call(this, input))
  })
  const getSpy = vi.spyOn(prototype, 'get').mockImplementation(function (
    this: MemoryPrototype,
    memoryId: MemoryRecord['id'],
    scope: MemoryScope,
  ): MemoryRecord | undefined {
    const record = originalGet.call(this, memoryId, scope)
    return record === undefined ? undefined : transform([record])[0]
  })
  return () => {
    exportSpy.mockRestore()
    listSpy.mockRestore()
    getSpy.mockRestore()
  }
}

async function lifecycleTempRoots(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter(name => name.startsWith('dsh-memory-lifecycle-') && !name.startsWith('dsh-memory-lifecycle-test-'))
    .sort()
}

beforeAll(() => {
  const build = spawnSync('pnpm', ['build'], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (build.status !== 0) {
    throw new Error(`lifecycle runner precondition build failed\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`)
  }
}, 120_000)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('MEM-003B programmatic lifecycle runner', () => {
  it('runs all 20 cases through the real pipeline and reports the frozen conformance matrix', async () => {
    const [{ runLifecycle }, { validateLifecycleReport }] = await Promise.all([loadRunner(), loadMetrics()])
    const report = await runLifecycle({ datasetPath, repeats: 2 })

    expect(() => validateLifecycleReport(report)).not.toThrow()
    expect(report).toMatchObject({
      schemaVersion: 1,
      dataset: {
        id: 'dsh-memory-lifecycle-scripted',
        version: '1.0.0',
        referenceCommit: 'f32fbd7846ddf5c5130c5bb696c695b56b9d70a8',
      },
      runner: { version: 1, repeats: 2 },
      provenance: {
        mode: 'scripted',
        interpretation: 'pipeline-conformance-only',
        adapter: 'deterministic-script-adapter-v1',
        externalNetwork: false,
        modelQualityClaim: false,
      },
      counts: { totalCases: 20, nominalCases: 14, faultCases: 6, acceptedExtractWrites: 20 },
    })
    expect(report.cases).toHaveLength(20)
    for (const item of report.cases) {
      const expectedCount = item.scenario !== 'nominal' || item.observedOperation === 'NOOP' ? 0 : 1
      expect(item.newActiveDerivedCount, `${item.id}/${String(item.observedOperation)}`).toBe(expectedCount)
    }
    expect(report.metrics.conflictAccuracy).toMatchObject({
      status: 'measured',
      value: 0.714286,
      numerator: 10,
      denominator: 14,
      confusion: { truePositive: 2, trueNegative: 8, falsePositive: 2, falseNegative: 2 },
    })
    expect(report.metrics.duplicateCompressionRate).toMatchObject({
      status: 'measured', value: 0.666667, compressed: 4, total: 6,
    })
    expect(report.metrics.degradationRate.scenarios).toEqual({
      nominal: { accepted: 14, degraded: 0, value: 0 },
      injected_model_failure: { accepted: 2, degraded: 2, value: 1 },
      invalid_json: { accepted: 2, degraded: 2, value: 1 },
      schema_failure: { accepted: 2, degraded: 2, value: 1 },
    })
    expect(report.metrics.degradationRate).not.toHaveProperty('overall')
    expect(report.metrics.degradationRate).not.toHaveProperty('value')
    expect(report.hardChecks).toEqual({
      rawFirstViolations: 0,
      unexpectedDerivedOnDegraded: 0,
      observationAmbiguities: 0,
      scriptConsumptionErrors: 0,
      unexpectedReceiptStatuses: 0,
      scopeLeaks: 0,
    })
  }, 120_000)

  it('uses public add plus persisted-state reads, never import, fetch, or API secrets', async () => {
    const built = await loadBuiltMemory()
    const prototype = built.default.prototype
    const addSpy = vi.spyOn(prototype, 'add')
    const exportSpy = vi.spyOn(prototype, 'export')
    const getSpy = vi.spyOn(prototype, 'get')
    const listSpy = vi.spyOn(prototype, 'list')
    const importSpy = vi.spyOn(prototype, 'import')
    const streamSpy = vi.spyOn(LlmRuntime.prototype, 'stream')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Lifecycle runner must not access the network')
    })
    vi.stubEnv('OPENAI_API_KEY', 'expected-only-secret-sentinel')
    vi.stubEnv('DEEPSEEK_API_KEY', 'expected-only-secret-sentinel')
    const [{ runLifecycle }, dataset] = await Promise.all([loadRunner(), readDataset()])

    const report = await runLifecycle({ datasetPath, repeats: 2 })
    const setupWrites = dataset.cases.reduce((sum, item) => sum + item.setup.length, 0)

    expect(addSpy).toHaveBeenCalledTimes((dataset.cases.length + setupWrites) * 2)
    expect(streamSpy).toHaveBeenCalledTimes(74)
    expect(exportSpy.mock.calls.length + getSpy.mock.calls.length + listSpy.mock.calls.length).toBeGreaterThan(0)
    expect(importSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    const primaryWrites = addSpy.mock.calls.map(call => call[0]).filter(input => input.mode === 'extract')
    expect(primaryWrites).toHaveLength(40)
    for (const item of dataset.cases) {
      expect(primaryWrites.filter(input => input.idempotencyKey === item.idempotencyKey)).toHaveLength(2)
    }
    expect(report.runner.repeats).toBe(2)
    expect(JSON.stringify(report)).not.toContain('expected-only-secret-sentinel')
  }, 120_000)

  it('derives operation and targets from persisted state, independent of expected labels', async () => {
    const { runLifecycle } = await loadRunner()
    const streamSpy = vi.spyOn(LlmRuntime.prototype, 'stream')
    const operationRelabelPath = await temporaryDataset((value) => {
      const index = value.cases.findIndex(item => item.id === 'op-zh-supersede-tp')
      const item = value.cases[index]
      if (item === undefined) throw new Error('missing operation relabel fixture')
      value.cases[index] = { ...item, expected: { operation: 'ADD', targetAliases: [], receiptStatus: 'completed' } }
    })
    const duplicateRelabelPath = await temporaryDataset((value) => {
      const index = value.cases.findIndex(item => item.id === 'op-en-duplicate-exact')
      const item = value.cases[index]
      if (item === undefined) throw new Error('missing duplicate relabel fixture')
      value.cases[index] = {
        ...item,
        expected: {
          operation: 'NOOP',
          targetAliases: ['distractor'],
          duplicateTargetAlias: 'distractor',
          receiptStatus: 'completed',
        },
      }
    })
    const [original, operationRelabeled, duplicateRelabeled] = await Promise.all([
      runLifecycle({ datasetPath, repeats: 1 }),
      runLifecycle({ datasetPath: operationRelabelPath, repeats: 1 }),
      runLifecycle({ datasetPath: duplicateRelabelPath, repeats: 1 }),
    ])

    const originalOperation = original.cases.find(item => item.id === 'op-zh-supersede-tp')
    const relabeledOperation = operationRelabeled.cases.find(item => item.id === 'op-zh-supersede-tp')
    expect(stableObservation(relabeledOperation)).toEqual(stableObservation(originalOperation))
    expect(originalOperation?.expectedOperation).toBe('SUPERSEDE')
    expect(relabeledOperation?.expectedOperation).toBe('ADD')
    expect(originalOperation?.conflictLabel).toBe('TP')
    expect(relabeledOperation?.conflictLabel).toBe('FP')

    const originalDuplicate = original.cases.find(item => item.id === 'op-en-duplicate-exact')
    const relabeledDuplicate = duplicateRelabeled.cases.find(item => item.id === 'op-en-duplicate-exact')
    expect(stableObservation(relabeledDuplicate)).toEqual(stableObservation(originalDuplicate))
    expect(originalDuplicate?.duplicateObservation).toMatchObject({
      evidenceAttachedToExpectedTarget: true,
      compressed: true,
    })
    expect(relabeledDuplicate?.duplicateObservation).toMatchObject({
      evidenceAttachedToExpectedTarget: false,
      compressed: false,
    })
    expect(JSON.stringify(streamSpy.mock.calls.map(call => call[0]))).not.toContain('distractor')
  }, 120_000)

  it('treats public persisted relations as authoritative instead of copying modelScript operations', async () => {
    const built = await loadBuiltMemory()
    const { runLifecycle } = await loadRunner()
    const original = await runLifecycle({ datasetPath, repeats: 1 })
    const runWithStateMutation = async (
      transform: (records: readonly MemoryRecord[]) => readonly MemoryRecord[],
    ): Promise<LifecycleReport> => {
      const restore = installPublicStateTransform(built.default.prototype, transform)
      try {
        return await runLifecycle({ datasetPath, repeats: 1 })
      } finally {
        restore()
      }
    }
    const missingReverse = await runWithStateMutation(records => records.map(record =>
      record.scope.userId === 'user-op-zh-consolidate-tn'
        && record.content === '北极星项目在十五日上线。'
        ? { ...record, supersededBy: [] }
        : record))
    const missingForward = await runWithStateMutation(records => records.map(record =>
      record.scope.userId === 'user-op-zh-consolidate-tn'
        && record.status === 'active'
        && record.consolidates.length === 2
        ? { ...record, consolidates: [record.consolidates[0]!] }
        : record))

    const originalCase = original.cases.find(item => item.id === 'op-zh-consolidate-tn')
    expect(originalCase?.observedOperation).toBe('CONSOLIDATE')
    expect(new Set(originalCase?.observedTargetAliases)).toEqual(new Set(['month', 'day']))
    for (const invalidState of [missingReverse, missingForward]) {
      const invalidCase = invalidState.cases.find(item => item.id === 'op-zh-consolidate-tn')
      expect(invalidCase?.observedOperation).toBeNull()
      expect(invalidCase?.observedTargetAliases).toEqual([])
      expect(invalidState.hardChecks.observationAmbiguities).toBeGreaterThan(0)
      expect(invalidCase?.observedTargetAliases).not.toEqual(['month'])
    }
  }, 120_000)

  it('rejects ADD and evolution heads that are not linked to the receipt raw source', async () => {
    const built = await loadBuiltMemory()
    const { runLifecycle } = await loadRunner()
    const disconnectedCases = [
      { id: 'op-zh-add-tn', key: 'op-zh-add-tn-extract' },
      { id: 'op-zh-supersede-tp', key: 'op-zh-supersede-tp-extract' },
    ] as const

    for (const target of disconnectedCases) {
      const restore = installPublicStateTransform(built.default.prototype, (records) => {
        const raw = records.find(record => record.layer === 'l1_raw' && record.idempotencyKey === target.key)
        if (raw === undefined) return records
        return records.map(record => activeDerivedRecord(record) && record.sourceMemoryIds.includes(raw.id)
          ? { ...record, sourceMemoryIds: record.sourceMemoryIds.filter(id => id !== raw.id) }
          : record)
      })
      try {
        const report = await runLifecycle({ datasetPath, repeats: 1 })
        const item = report.cases.find(candidate => candidate.id === target.id)
        expect.soft(item?.observedOperation, `${target.id} operation`).toBeNull()
        expect.soft(item?.observedTargetAliases, `${target.id} targets`).toEqual([])
        expect.soft(report.hardChecks.observationAmbiguities, `${target.id} ambiguity`).toBeGreaterThan(0)
      } finally {
        restore()
      }
    }
  }, 120_000)

  it('uses receipt.rawMemoryId as the raw-first authority instead of recovering by idempotency key', async () => {
    const built = await loadBuiltMemory()
    const { runLifecycle } = await loadRunner()
    const originalAdd = built.default.prototype.add
    const addSpy = vi.spyOn(built.default.prototype, 'add').mockImplementation(async function (
      this: MemoryPrototype,
      input: AddMemoryInput,
      signal?: AbortSignal,
    ): Promise<WriteReceipt> {
      const receipt = await originalAdd.call(this, input, signal)
      return input.mode === 'extract' && input.idempotencyKey === 'fault-zh-model-extraction-extract'
        ? { ...receipt, rawMemoryId: 'memory-missing-receipt-raw' as WriteReceipt['rawMemoryId'] }
        : receipt
    })
    try {
      const report = await runLifecycle({ datasetPath, repeats: 1 })
      const item = report.cases.find(candidate => candidate.id === 'fault-zh-model-extraction')
      expect(item?.rawFirstPass).toBe(false)
      expect(report.hardChecks.rawFirstViolations).toBeGreaterThan(0)
    } finally {
      addSpy.mockRestore()
    }
  }, 120_000)

  it('keeps degraded writes raw-first and observes every successful operation from relations', async () => {
    const { runLifecycle } = await loadRunner()
    const report = await runLifecycle({ datasetPath, repeats: 1 })
    const nominal = report.cases.filter(item => item.scenario === 'nominal')
    const faults = report.cases.filter(item => item.scenario !== 'nominal')

    expect(nominal).toHaveLength(14)
    expect(faults).toHaveLength(6)
    expect(new Set(nominal.map(item => item.observedOperation))).toEqual(
      new Set(['ADD', 'NOOP', 'CONSOLIDATE', 'SUPERSEDE']),
    )
    expect(nominal.every(item => item.receiptStatus === 'completed' && item.rawFirstPass)).toBe(true)
    expect(faults.every(item => item.receiptStatus === 'degraded')).toBe(true)
    expect(faults.every(item => item.observedOperation === null && item.newActiveDerivedCount === 0 && item.rawFirstPass)).toBe(true)
    for (const item of nominal.filter(item => item.observedOperation === 'CONSOLIDATE')) {
      expect(item.observedTargetAliases.length).toBeGreaterThanOrEqual(2)
    }
  }, 120_000)

  it('derives raw-first, degraded-derived, ambiguity, and scope hard checks from public state reads', async () => {
    const built = await loadBuiltMemory()
    const { runLifecycle } = await loadRunner()
    const injections: readonly {
      readonly hardCheck: keyof LifecycleReport['hardChecks']
      readonly transform: (records: readonly MemoryRecord[]) => readonly MemoryRecord[]
    }[] = [
      {
        hardCheck: 'rawFirstViolations',
        transform: records => records.filter(record =>
          record.idempotencyKey !== 'fault-zh-model-extraction-extract'),
      },
      {
        hardCheck: 'unexpectedDerivedOnDegraded',
        transform: (records) => {
          const raw = records.find(record =>
            record.idempotencyKey === 'fault-zh-model-extraction-extract' && record.layer === 'l1_raw')
          if (raw === undefined || records.some(record => String(record.id) === 'memory-state-injected-degraded-derived')) {
            return records
          }
          const derived: MemoryRecord = {
            ...raw,
            id: 'memory-state-injected-degraded-derived' as MemoryRecord['id'],
            layer: 'l2_fact',
            status: 'active',
            visibility: 'recallable',
            sourceMemoryIds: [raw.id],
            supersedes: [],
            supersededBy: [],
            consolidates: [],
          }
          return [...records, derived]
        },
      },
      {
        hardCheck: 'observationAmbiguities',
        transform: (records) => {
          const raw = records.find(record =>
            record.idempotencyKey === 'op-zh-supersede-tp-extract' && record.layer === 'l1_raw')
          const evolved = raw === undefined ? undefined : records.find(record =>
            record.status === 'active'
            && (record.layer === 'l2_fact' || record.layer === 'l4_identity')
            && record.sourceMemoryIds.includes(raw.id))
          if (raw === undefined || evolved === undefined
            || records.some(record => String(record.id) === 'memory-state-injected-ambiguous-add')) return records
          const competingAdd: MemoryRecord = {
            ...evolved,
            id: 'memory-state-injected-ambiguous-add' as MemoryRecord['id'],
            supersedes: [],
            supersededBy: [],
            consolidates: [],
            sourceMemoryIds: [raw.id],
          }
          return [...records, competingAdd]
        },
      },
      {
        hardCheck: 'scopeLeaks',
        transform: records => records.map(record => record.idempotencyKey === 'fault-zh-model-extraction-extract'
          ? { ...record, scope: { ...record.scope, userId: 'state-injected-cross-owner' } }
          : record),
      },
    ]

    for (const injection of injections) {
      const restore = installPublicStateTransform(built.default.prototype, injection.transform)
      try {
        const report = await runLifecycle({ datasetPath, repeats: 1 })
        expect(report.hardChecks[injection.hardCheck], injection.hardCheck).toBeGreaterThan(0)
      } finally {
        restore()
      }
    }
  }, 120_000)

  it('counts runtime adapter consumption errors and unexpected receipts instead of hard-coding zeros', async () => {
    const built = await loadBuiltMemory()
    const { runLifecycle } = await loadRunner()
    const originalStream = LlmRuntime.prototype.stream
    let injected = false
    const streamSpy = vi.spyOn(LlmRuntime.prototype, 'stream').mockImplementation(function (
      this: LlmRuntime,
      options: Parameters<LlmRuntime['stream']>[0],
    ): ReturnType<LlmRuntime['stream']> {
      const first = originalStream.call(this, options)
      if (injected) return first
      injected = true
      const runtime = this
      return (async function * consumeOneExtraCall() {
        yield * first
        yield * originalStream.call(runtime, options)
      })()
    })
    try {
      const report = await runLifecycle({ datasetPath, repeats: 1 })
      expect(report.hardChecks.scriptConsumptionErrors).toBeGreaterThan(0)
    } finally {
      streamSpy.mockRestore()
    }

    const originalAdd = built.default.prototype.add
    const addSpy = vi.spyOn(built.default.prototype, 'add').mockImplementation(async function (
      this: MemoryPrototype,
      input: AddMemoryInput,
      signal?: AbortSignal,
    ): Promise<WriteReceipt> {
      const receipt = await originalAdd.call(this, input, signal)
      return input.mode === 'extract' && input.idempotencyKey === 'fault-zh-model-extraction-extract'
        ? { ...receipt, status: 'completed' }
        : receipt
    })
    try {
      const report = await runLifecycle({ datasetPath, repeats: 1 })
      expect(report.hardChecks.unexpectedReceiptStatuses).toBeGreaterThan(0)
    } finally {
      addSpy.mockRestore()
    }
  }, 120_000)

  it('produces byte-identical reports without runtime IDs, times, paths, secrets, responses, or vectors', async () => {
    const [{ runLifecycle }, { canonicalJson }] = await Promise.all([loadRunner(), loadMetrics()])
    const first = canonicalJson(await runLifecycle({ datasetPath, repeats: 1 }))
    const second = canonicalJson(await runLifecycle({ datasetPath, repeats: 1 }))

    expect(second).toBe(first)
    const parsed = JSON.parse(first) as unknown
    const keys = collectKeys(parsed)
    for (const forbidden of [
      'requestId', 'jobId', 'rawMemoryId', 'memoryId', 'createdAt', 'updatedAt', 'timestamp',
      'temporaryPath', 'warning', 'warnings', 'rawResponse', 'secret', 'vector',
    ]) expect(keys).not.toContain(forbidden)
    expect(first).not.toMatch(/memory-[0-9a-f]{8}-|memory-job-|\/tmp\//u)
  }, 120_000)

  it('preserves an extract primary error and removes the root even when dispose also fails', async () => {
    const built = await loadBuiltMemory()
    const before = await lifecycleTempRoots()
    const originalAdd = built.default.prototype.add
    const addSpy = vi.spyOn(built.default.prototype, 'add').mockImplementation(async function (
      this: MemoryPrototype,
      input: AddMemoryInput,
      signal?: AbortSignal,
    ): Promise<WriteReceipt> {
      if (input.mode === 'extract') throw new Error('primary-cleanup-sentinel')
      return await originalAdd.call(this, input, signal)
    })
    const disposeSpy = vi.spyOn(Fiber.prototype, 'restart')
      .mockRejectedValueOnce(new Error('dispose-cleanup-sentinel'))
    const { runLifecycle } = await loadRunner()

    let caught: unknown
    try {
      await runLifecycle({ datasetPath, repeats: 1 })
    } catch (error) {
      caught = error
    } finally {
      addSpy.mockRestore()
      disposeSpy.mockRestore()
    }
    expect(caught).toBeInstanceOf(AggregateError)
    const aggregate = caught as AggregateError
    expect(aggregate.cause).toMatchObject({ message: 'primary-cleanup-sentinel' })
    expect(aggregate.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'primary-cleanup-sentinel' }),
      expect.objectContaining({ message: 'dispose-cleanup-sentinel' }),
    ]))
    expect(await lifecycleTempRoots()).toEqual(before)
  }, 120_000)
})

describe('MEM-003B CLI, baseline, gate, and isolation contract', () => {
  it('prints one canonical report and exits 0 for report-only repeat evaluation', async () => {
    const { canonicalJson } = await loadMetrics()
    const result = runCli(['--dataset', datasetPath, '--repeat', '2', '--report-only'])

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout) as unknown
    expect(result.stdout).toBe(`${canonicalJson(parsed)}\n`)
  }, 120_000)

  it('rejects script overflow and every unknown, duplicate, missing-value, or invalid-repeat argument with exit 1', async () => {
    const invalidPath = await temporaryDataset((value) => {
      const item = value.cases[0]!
      value.cases[0] = { ...item, modelScript: [...item.modelScript, item.modelScript[1]!] }
    })
    const semantic = runCli(['--dataset', invalidPath, '--repeat', '1', '--report-only'])
    const invalidArguments = [
      ['--dataset', datasetPath, '--unknown'],
      ['--dataset', datasetPath, '--dataset', datasetPath],
      ['--dataset', datasetPath, '--gates', gatesPath, '--gates', gatesPath],
      ['--dataset', datasetPath, '--repeat', '1', '--repeat', '1'],
      ['--dataset', datasetPath, '--report-only', '--report-only'],
      [],
      ['--dataset'],
      ['--dataset', datasetPath, '--gates'],
      ['--dataset', datasetPath, '--repeat'],
      ['--dataset', datasetPath, '--repeat', '0'],
      ['--dataset', datasetPath, '--repeat', '-1'],
      ['--dataset', datasetPath, '--repeat', '1.5'],
      ['--dataset', datasetPath, '--repeat', 'many'],
    ].map(args => runCli(args))

    for (const result of [semantic, ...invalidArguments]) {
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/lifecycle:/i)
      expect(result.stderr).not.toMatch(/MODULE_NOT_FOUND|Cannot find module/i)
    }
  }, 120_000)

  it('passes exact checked-in conformance gates with exit 0 and fails a mismatch with exit 2', async () => {
    const gates = JSON.parse(await readFile(gatesPath, 'utf8')) as ConformanceGates
    const passed = runCli(['--dataset', datasetPath, '--gates', gatesPath, '--repeat', '2'])
    const relabeledPath = await temporaryDataset((value) => {
      const item = value.cases.find(candidate => candidate.id === 'op-zh-supersede-tp')
      if (item === undefined) throw new Error('missing valid mismatch fixture')
      const index = value.cases.indexOf(item)
      value.cases[index] = {
        ...item,
        expected: { operation: 'ADD', targetAliases: [], receiptStatus: 'completed' },
      }
    })
    const { runLifecycle } = await loadRunner()
    const mismatchReport = await runLifecycle({ datasetPath: relabeledPath, repeats: 1 })
    const validMismatch: ConformanceGates = {
      schemaVersion: 1,
      dataset: mismatchReport.dataset,
      provenance: mismatchReport.provenance,
      metrics: mismatchReport.metrics,
      cases: mismatchReport.cases,
      hardChecks: mismatchReport.hardChecks,
    }
    const mismatchPath = await temporaryJson(validMismatch, 'gates.conformance.json')
    const failed = runCli(['--dataset', datasetPath, '--gates', mismatchPath, '--repeat', '1'])

    expect(passed.status).toBe(0)
    expect(passed.stderr).toBe('')
    expect(() => JSON.parse(passed.stdout) as unknown).not.toThrow()
    expect(failed.status).toBe(2)
    expect(failed.stderr).toMatch(/lifecycle: (?:conformance|gate) mismatch:/i)
    const { canonicalJson } = await loadMetrics()
    const failedReport = JSON.parse(failed.stdout) as unknown
    expect(failed.stdout).toBe(`${canonicalJson(failedReport)}\n`)
  }, 120_000)

  it('rejects structurally or semantically invalid gates with exit 1 and no report stdout', async () => {
    const gates = JSON.parse(await readFile(gatesPath, 'utf8')) as ConformanceGates
    const invalid: Record<string, unknown>[] = []

    const extraTopLevel = structuredClone(gates) as unknown as Record<string, unknown>
    extraTopLevel['runtimeId'] = 'forbidden'
    invalid.push(extraTopLevel)

    const invalidNestedShape = structuredClone(gates) as unknown as Record<string, unknown>
    const nestedMetrics = invalidNestedShape['metrics'] as Record<string, unknown>
    const nestedDegradation = nestedMetrics['degradationRate'] as Record<string, unknown>
    nestedDegradation['overall'] = { accepted: 20, degraded: 6, value: 0.3 }
    invalid.push(invalidNestedShape)

    const invalidRatio = structuredClone(gates) as unknown as Record<string, unknown>
    const ratioMetrics = invalidRatio['metrics'] as Record<string, unknown>
    const ratioConflict = ratioMetrics['conflictAccuracy'] as Record<string, unknown>
    ratioConflict['value'] = 0.123456
    invalid.push(invalidRatio)

    const invalidCase = structuredClone(gates) as unknown as Record<string, unknown>
    const gateCases = invalidCase['cases'] as Array<Record<string, unknown>>
    gateCases[0]!['newActiveDerivedCount'] = 9
    invalid.push(invalidCase)

    for (const [index, gate] of invalid.entries()) {
      const path = await temporaryJson(gate, `invalid-gates-${index}.json`)
      const result = runCli(['--dataset', datasetPath, '--gates', path, '--repeat', '1'])
      expect.soft(result.status, `invalid gate ${index} status`).toBe(1)
      expect.soft(result.stdout, `invalid gate ${index} stdout`).toBe('')
      expect.soft(result.stderr, `invalid gate ${index} stderr`).toMatch(/lifecycle: gate error:/i)
    }
  }, 120_000)

  it('rejects self-consistent gates that drift fault matrices or receipt semantics', async () => {
    const [{ computeLifecycleMetrics }, checkedGates] = await Promise.all([
      loadMetrics(),
      readFile(gatesPath, 'utf8').then(text => JSON.parse(text) as ConformanceGates),
    ])
    const invalid: Array<{ readonly label: string; readonly gate: Record<string, unknown> }> = []
    const mutateGate = (
      label: string,
      mutate: (cases: Array<Record<string, unknown>>) => void,
    ): void => {
      const gate = structuredClone(checkedGates) as unknown as Record<string, unknown>
      const cases = gate['cases'] as Array<Record<string, unknown>>
      mutate(cases)
      gate['metrics'] = computeLifecycleMetrics(cases.map(item => {
        const duplicate = item['duplicateObservation'] as Record<string, unknown>
        return {
          id: item['id'] as string,
          language: item['language'] as Language,
          faultScenario: item['scenario'] as FaultScenario,
          expectedOperation: item['expectedOperation'] as Operation | null,
          observedOperation: item['observedOperation'] as Operation | null,
          receiptStatus: item['receiptStatus'] as 'completed' | 'degraded',
          duplicateMeasured: duplicate['measured'] as boolean,
          noNewActiveDerived: duplicate['noNewActiveDerived'] as boolean | null,
          evidenceAttachedToExpectedTarget: duplicate['evidenceAttachedToExpectedTarget'] as boolean | null,
        }
      }))
      invalid.push({ label, gate })
    }

    mutateGate('fault scenario distribution 1/3/2', (cases) => {
      const item = cases.find(candidate => candidate['id'] === 'fault-zh-model-extraction')
      if (item === undefined) throw new Error('missing injected fault gate case')
      item['scenario'] = 'invalid_json'
    })
    mutateGate('fault entering duplicate denominator', (cases) => {
      const item = cases.find(candidate => candidate['id'] === 'fault-zh-model-extraction')
      if (item === undefined) throw new Error('missing fault duplicate gate case')
      item['duplicateObservation'] = {
        measured: true,
        noNewActiveDerived: true,
        evidenceAttachedToExpectedTarget: true,
        compressed: true,
      }
    })
    mutateGate('nominal degraded receipt', (cases) => {
      const item = cases.find(candidate => candidate['scenario'] === 'nominal')
      if (item === undefined) throw new Error('missing nominal gate case')
      item['receiptStatus'] = 'degraded'
    })
    mutateGate('fault completed receipt', (cases) => {
      const item = cases.find(candidate => candidate['scenario'] !== 'nominal')
      if (item === undefined) throw new Error('missing fault gate case')
      item['receiptStatus'] = 'completed'
    })

    for (const [index, item] of invalid.entries()) {
      const path = await temporaryJson(item.gate, `invalid-semantic-gates-${index}.json`)
      const result = runCli(['--dataset', datasetPath, '--gates', path, '--repeat', '1'])
      expect.soft(result.status, `${item.label} status`).toBe(1)
      expect.soft(result.stdout, `${item.label} stdout`).toBe('')
      expect.soft(result.stderr, `${item.label} stderr`).toMatch(/lifecycle: gate error:/i)
    }
  }, 120_000)

  it('distinguishes runtime exit 1 from nonzero-hard exit 2 with canonical stdout', async () => {
    const runtimePreload = await temporaryModule([
      `import MemoryService from ${JSON.stringify(builtMemoryHref)}`,
      'const originalAdd = MemoryService.prototype.add',
      'MemoryService.prototype.add = async function (input, signal) {',
      "  if (input.mode === 'extract') throw new Error('cli-runtime-sentinel')",
      '  return await originalAdd.call(this, input, signal)',
      '}',
      '',
    ].join('\n'))
    const hardPreload = await temporaryModule([
      `import MemoryService from ${JSON.stringify(builtMemoryHref)}`,
      'const originalAdd = MemoryService.prototype.add',
      'MemoryService.prototype.add = async function (input, signal) {',
      '  const receipt = await originalAdd.call(this, input, signal)',
      "  if (input.mode === 'extract' && input.idempotencyKey === 'fault-zh-model-extraction-extract') {",
      "    return { ...receipt, status: 'completed' }",
      '  }',
      '  return receipt',
      '}',
      '',
    ].join('\n'))

    const runtime = runCli(
      ['--dataset', datasetPath, '--repeat', '1', '--report-only'],
      { NODE_OPTIONS: `--import=${runtimePreload}` },
    )
    const hard = runCli(
      ['--dataset', datasetPath, '--repeat', '1', '--report-only'],
      { NODE_OPTIONS: `--import=${hardPreload}` },
    )

    expect(runtime.status).toBe(1)
    expect(runtime.stdout).toBe('')
    expect(runtime.stderr).toMatch(/lifecycle: runtime error:.*cli-runtime-sentinel/is)
    expect(hard.status).toBe(2)
    expect(hard.stderr).toMatch(/lifecycle: hard check failed:/i)
    const { canonicalJson } = await loadMetrics()
    const hardReport = JSON.parse(hard.stdout) as LifecycleReport
    expect(hardReport.hardChecks.unexpectedReceiptStatuses).toBeGreaterThan(0)
    expect(hard.stdout).toBe(`${canonicalJson(hardReport)}\n`)
  }, 120_000)

  it('freezes an exact scripted baseline and a mechanically identical gate without quality floors', async () => {
    const [{ runLifecycle }, { canonicalJson }, baseline, gates] = await Promise.all([
      loadRunner(),
      loadMetrics(),
      readFile(baselinePath, 'utf8').then(text => JSON.parse(text) as LifecycleReport),
      readFile(gatesPath, 'utf8').then(text => JSON.parse(text) as ConformanceGates),
    ])
    const current = await runLifecycle({ datasetPath, repeats: 2 })

    expect(canonicalJson(baseline)).toBe(canonicalJson(current))
    expect(gates).toEqual({
      schemaVersion: 1,
      dataset: baseline.dataset,
      provenance: baseline.provenance,
      metrics: baseline.metrics,
      cases: baseline.cases,
      hardChecks: baseline.hardChecks,
    })
    expect(JSON.stringify(gates)).not.toMatch(/floor|threshold|qualityTarget/i)
  }, 120_000)

  it('defines an offline eval:lifecycle script and leaves 003A retrieval semantics isolated', async () => {
    const [manifest, retrievalReportSchema, lifecycleRunnerSource] = await Promise.all([
      readFile(packagePath, 'utf8').then(text => JSON.parse(text) as { scripts?: Readonly<Record<string, string>> }),
      readFile(fileURLToPath(new URL('../evaluation/golden/report.schema.json', import.meta.url)), 'utf8'),
      readFile(runnerPath, 'utf8'),
    ])
    const script = manifest.scripts?.['eval:lifecycle']

    expect(script).toBe(
      'pnpm run build && node evaluation/run-lifecycle.mjs --dataset evaluation/lifecycle/v1/cases.json --gates evaluation/lifecycle/v1/gates.conformance.json --repeat 2',
    )
    expect(script).not.toMatch(/(?:OPENAI|DEEPSEEK|API[_-]?KEY|TOKEN|SECRET|live-model|allow-network)/i)
    expect(retrievalReportSchema).toContain('not_measured')
    expect(lifecycleRunnerSource).not.toMatch(/evaluation\/golden|run-golden|retrieval\.json/u)
    const externalApiPattern = /DASHSCOPE_API_URL|DASHSCOPE_API_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|https?:\/\/|fetch\s*\(/u
    expect(lifecycleRunnerSource).not.toMatch(externalApiPattern)
    expect("import LlmRuntime from '@deepseek-ai/dsh-llm'").not.toMatch(externalApiPattern)
  })
})
