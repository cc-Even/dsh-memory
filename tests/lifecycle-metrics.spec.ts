import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

type Language = 'zh' | 'en'
type Operation = 'ADD' | 'NOOP' | 'CONSOLIDATE' | 'SUPERSEDE'
type FaultScenario = 'nominal' | 'injected_model_failure' | 'invalid_json' | 'schema_failure'

interface LifecycleCase {
  readonly id: string
  readonly language: Language
  readonly role: string
  readonly faultScenario: FaultScenario
  readonly owner: { readonly tenantId?: string; readonly userId: string; readonly agentId: string }
  readonly sessionId: string
  readonly content: string
  readonly idempotencyKey: string
  readonly setup: readonly { readonly alias: string; readonly content: string; readonly layer: 'l2_fact' | 'l4_identity' }[]
  readonly modelScript: readonly {
    readonly phase: 'extraction' | 'reconciliation'
    readonly outcome: 'json' | 'throw' | 'invalid_json'
    readonly payload?: Record<string, unknown>
    readonly rawText?: string
    readonly errorCode?: string
  }[]
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
  readonly provenance: {
    readonly mode: 'scripted'
    readonly interpretation: 'pipeline-conformance-only'
    readonly adapter: 'deterministic-script-adapter-v1'
    readonly externalNetwork: false
    readonly modelQualityClaim: false
  }
  readonly cases: readonly LifecycleCase[]
}

interface LifecycleObservation {
  readonly id: string
  readonly language: Language
  readonly faultScenario: FaultScenario
  readonly expectedOperation: Operation | null
  readonly observedOperation: Operation | null
  readonly receiptStatus: 'completed' | 'degraded'
  readonly duplicateMeasured: boolean
  readonly noNewActiveDerived: boolean | null
  readonly evidenceAttachedToExpectedTarget: boolean | null
}

interface LifecycleMetricResult {
  readonly conflictAccuracy: {
    readonly status: 'measured'
    readonly value: number
    readonly numerator: number
    readonly denominator: number
    readonly confusion: {
      readonly truePositive: number
      readonly trueNegative: number
      readonly falsePositive: number
      readonly falseNegative: number
    }
    readonly byLanguage: readonly unknown[]
  }
  readonly duplicateCompressionRate: {
    readonly status: 'measured'
    readonly value: number
    readonly compressed: number
    readonly total: number
    readonly byLanguage: readonly unknown[]
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

interface LifecycleMetricsModule {
  validateLifecycleDataset(dataset: unknown): void
  validateLifecycleReport(report: unknown): void
  computeLifecycleMetrics(cases: readonly LifecycleObservation[]): LifecycleMetricResult
  canonicalJson(value: unknown): string
}

const datasetPath = fileURLToPath(new URL('../evaluation/lifecycle/v1/cases.json', import.meta.url))
const datasetSchemaPath = fileURLToPath(new URL('../evaluation/lifecycle/v1/dataset.schema.json', import.meta.url))
const reportSchemaPath = fileURLToPath(new URL('../evaluation/lifecycle/report.schema.json', import.meta.url))
const metricsUrl = new URL('../evaluation/lifecycle-metrics.mjs', import.meta.url)

const dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as LifecycleDataset
const datasetSchema = JSON.parse(readFileSync(datasetSchemaPath, 'utf8')) as Record<string, unknown>
const reportSchema = JSON.parse(readFileSync(reportSchemaPath, 'utf8')) as Record<string, unknown>

async function loadMetrics(): Promise<LifecycleMetricsModule> {
  return await import(/* @vite-ignore */ metricsUrl.href) as LifecycleMetricsModule
}

function mutableDataset(): { cases: LifecycleCase[] } & Omit<LifecycleDataset, 'cases'> {
  return structuredClone(dataset) as { cases: LifecycleCase[] } & Omit<LifecycleDataset, 'cases'>
}

function reconciliationOperation(item: LifecycleCase): Operation | null {
  const step = item.modelScript.find(candidate => candidate.phase === 'reconciliation')
  if (step?.outcome !== 'json') return null
  const operations = step.payload?.['operations']
  if (!Array.isArray(operations) || operations.length !== 1) return null
  const operation = operations[0]
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return null
  const type = (operation as Record<string, unknown>)['type']
  return type === 'ADD' || type === 'NOOP' || type === 'CONSOLIDATE' || type === 'SUPERSEDE' ? type : null
}

function handWrittenObservations(): LifecycleObservation[] {
  const nominal = [
    ['op-zh-supersede-tp', 'zh', 'SUPERSEDE', 'SUPERSEDE', false, null, null],
    ['op-zh-supersede-fn', 'zh', 'SUPERSEDE', 'ADD', false, null, null],
    ['op-zh-add-tn', 'zh', 'ADD', 'ADD', false, null, null],
    ['op-zh-duplicate-exact', 'zh', 'NOOP', 'NOOP', true, true, true],
    ['op-zh-duplicate-paraphrase', 'zh', 'NOOP', 'NOOP', true, true, true],
    ['op-zh-consolidate-tn', 'zh', 'CONSOLIDATE', 'CONSOLIDATE', false, null, null],
    ['op-zh-duplicate-fp', 'zh', 'NOOP', 'SUPERSEDE', true, false, false],
    ['op-en-supersede-tp', 'en', 'SUPERSEDE', 'SUPERSEDE', false, null, null],
    ['op-en-supersede-fn', 'en', 'SUPERSEDE', 'ADD', false, null, null],
    ['op-en-add-tn', 'en', 'ADD', 'ADD', false, null, null],
    ['op-en-duplicate-exact', 'en', 'NOOP', 'NOOP', true, true, true],
    ['op-en-duplicate-paraphrase', 'en', 'NOOP', 'NOOP', true, true, true],
    ['op-en-consolidate-tn', 'en', 'CONSOLIDATE', 'CONSOLIDATE', false, null, null],
    ['op-en-duplicate-fp', 'en', 'NOOP', 'SUPERSEDE', true, false, false],
  ] as const
  const observations: LifecycleObservation[] = nominal.map(([
    id, language, expectedOperation, observedOperation, duplicateMeasured,
    noNewActiveDerived, evidenceAttachedToExpectedTarget,
  ]) => ({
    id,
    language,
    faultScenario: 'nominal',
    expectedOperation,
    observedOperation,
    receiptStatus: 'completed',
    duplicateMeasured,
    noNewActiveDerived,
    evidenceAttachedToExpectedTarget,
  }))
  for (const [scenario, language, id] of [
    ['injected_model_failure', 'zh', 'fault-zh-model-extraction'],
    ['injected_model_failure', 'en', 'fault-en-model-reconciliation'],
    ['invalid_json', 'zh', 'fault-zh-invalid-json-extraction'],
    ['invalid_json', 'en', 'fault-en-invalid-json-reconciliation'],
    ['schema_failure', 'zh', 'fault-zh-schema-extraction'],
    ['schema_failure', 'en', 'fault-en-schema-reconciliation'],
  ] as const) {
    observations.push({
      id,
      language,
      faultScenario: scenario,
      expectedOperation: null,
      observedOperation: null,
      receiptStatus: 'degraded',
      duplicateMeasured: false,
      noNewActiveDerived: null,
      evidenceAttachedToExpectedTarget: null,
    })
  }
  return observations
}

function conflictLabel(expected: Operation | null, observed: Operation | null): 'TP' | 'TN' | 'FP' | 'FN' | null {
  if (expected === null) return null
  if (expected === 'SUPERSEDE') return observed === 'SUPERSEDE' ? 'TP' : 'FN'
  return observed === 'SUPERSEDE' ? 'FP' : 'TN'
}

function validReportFixture(): Record<string, unknown> {
  const observations = handWrittenObservations()
  const cases = observations.map((item) => {
    const compressed = item.duplicateMeasured
      ? item.noNewActiveDerived === true && item.evidenceAttachedToExpectedTarget === true
      : null
    const observedTargetAliases = item.observedOperation === 'CONSOLIDATE'
      ? ['one', 'two']
      : item.observedOperation === 'NOOP' || item.observedOperation === 'SUPERSEDE' ? ['old'] : []
    return {
      id: item.id,
      language: item.language,
      role: item.faultScenario !== 'nominal'
        ? 'fault_injection'
        : item.id.endsWith('-fn') || item.id.endsWith('-fp') ? 'metric_sentinel' : 'conformance',
      scenario: item.faultScenario,
      expectedOperation: item.expectedOperation,
      observedOperation: item.observedOperation,
      conflictLabel: conflictLabel(item.expectedOperation, item.observedOperation),
      receiptStatus: item.receiptStatus,
      observedTargetAliases,
      newActiveDerivedCount: item.observedOperation === null || item.observedOperation === 'NOOP' ? 0 : 1,
      duplicateObservation: {
        measured: item.duplicateMeasured,
        noNewActiveDerived: item.noNewActiveDerived,
        evidenceAttachedToExpectedTarget: item.evidenceAttachedToExpectedTarget,
        compressed,
      },
      rawFirstPass: true,
    }
  })
  return {
    schemaVersion: 1,
    dataset: {
      id: 'dsh-memory-lifecycle-scripted',
      version: 'manual-validator-fixture',
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
    metrics: {
      conflictAccuracy: {
        status: 'measured', value: 0.714286, numerator: 10, denominator: 14,
        confusion: { truePositive: 2, trueNegative: 8, falsePositive: 2, falseNegative: 2 },
        byLanguage: [
          {
            language: 'en', value: 0.714286, numerator: 5, denominator: 7,
            confusion: { truePositive: 1, trueNegative: 4, falsePositive: 1, falseNegative: 1 },
          },
          {
            language: 'zh', value: 0.714286, numerator: 5, denominator: 7,
            confusion: { truePositive: 1, trueNegative: 4, falsePositive: 1, falseNegative: 1 },
          },
        ],
      },
      duplicateCompressionRate: {
        status: 'measured', value: 0.666667, compressed: 4, total: 6,
        byLanguage: [
          { language: 'en', value: 0.666667, compressed: 2, total: 3 },
          { language: 'zh', value: 0.666667, compressed: 2, total: 3 },
        ],
      },
      degradationRate: {
        status: 'measured_by_scenario',
        scenarios: {
          nominal: { accepted: 14, degraded: 0, value: 0 },
          injected_model_failure: { accepted: 2, degraded: 2, value: 1 },
          invalid_json: { accepted: 2, degraded: 2, value: 1 },
          schema_failure: { accepted: 2, degraded: 2, value: 1 },
        },
      },
    },
    cases,
    hardChecks: {
      rawFirstViolations: 0,
      unexpectedDerivedOnDegraded: 0,
      observationAmbiguities: 0,
      scriptConsumptionErrors: 0,
      unexpectedReceiptStatuses: 0,
      scopeLeaks: 0,
    },
  }
}

describe('MEM-003B lifecycle schemas and frozen dataset', () => {
  it('parses two strict versioned schemas and freezes the non-claiming provenance', () => {
    expect(datasetSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
    })
    expect(reportSchema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
    })
    expect(dataset).toMatchObject({
      schemaVersion: 1,
      datasetId: 'dsh-memory-lifecycle-scripted',
      datasetVersion: '1.0.0',
      referenceCommit: 'f32fbd7846ddf5c5130c5bb696c695b56b9d70a8',
      provenance: {
        mode: 'scripted',
        interpretation: 'pipeline-conformance-only',
        adapter: 'deterministic-script-adapter-v1',
        externalNetwork: false,
        modelQualityClaim: false,
      },
    })
  })

  it('contains the exact bilingual 14 nominal plus 6 fault matrix', () => {
    expect(dataset.cases).toHaveLength(20)
    expect(new Set(dataset.cases.map(item => item.id)).size).toBe(20)
    for (const language of ['zh', 'en'] as const) {
      const languageCases = dataset.cases.filter(item => item.language === language)
      expect(languageCases).toHaveLength(10)
      expect(languageCases.filter(item => item.faultScenario === 'nominal')).toHaveLength(7)
      expect(languageCases.filter(item => item.role === 'fault_injection')).toHaveLength(3)
      expect(languageCases.filter(item => item.role === 'conformance')).toHaveLength(5)
      expect(languageCases.filter(item => item.role === 'metric_sentinel')).toHaveLength(2)
      expect(languageCases.filter(item => item.measurements.duplicate)).toHaveLength(3)
    }
    expect(dataset.cases.filter(item => item.faultScenario === 'nominal')).toHaveLength(14)
    expect(dataset.cases.filter(item => item.faultScenario !== 'nominal')).toHaveLength(6)
    expect(new Set(dataset.cases.map(item => item.role))).toEqual(
      new Set(['conformance', 'metric_sentinel', 'fault_injection']),
    )
    expect(dataset.cases.filter(item => item.measurements.duplicate)).toHaveLength(6)
    for (const scenario of ['injected_model_failure', 'invalid_json', 'schema_failure'] as const) {
      const faultCases = dataset.cases.filter(item => item.faultScenario === scenario)
      expect(faultCases).toHaveLength(2)
      expect(new Set(faultCases.map(item => item.language))).toEqual(new Set(['zh', 'en']))
      expect(new Set(faultCases.flatMap(item => item.modelScript.map(step => step.phase))))
        .toEqual(new Set(['extraction', 'reconciliation']))
      expect(faultCases.find(item => item.language === 'zh')?.modelScript.at(-1)?.phase).toBe('extraction')
      expect(faultCases.find(item => item.language === 'en')?.modelScript.at(-1)?.phase).toBe('reconciliation')
    }
  })

  it('freezes metric sentinels, L2/L4 coverage, and multi-target consolidation', () => {
    const nominal = dataset.cases.filter(item => item.faultScenario === 'nominal')
    const labels = nominal.map(item => ({
      expectedPositive: item.expected.operation === 'SUPERSEDE',
      predictedPositive: reconciliationOperation(item) === 'SUPERSEDE',
    }))
    expect(labels.filter(item => item.expectedPositive && item.predictedPositive)).toHaveLength(2)
    expect(labels.filter(item => !item.expectedPositive && !item.predictedPositive)).toHaveLength(8)
    expect(labels.filter(item => !item.expectedPositive && item.predictedPositive)).toHaveLength(2)
    expect(labels.filter(item => item.expectedPositive && !item.predictedPositive)).toHaveLength(2)

    const duplicateCases = nominal.filter(item => item.measurements.duplicate)
    expect(duplicateCases.filter(item => reconciliationOperation(item) === 'NOOP')).toHaveLength(4)
    expect(duplicateCases.filter(item => reconciliationOperation(item) !== 'NOOP')).toHaveLength(2)
    expect(new Set(nominal.flatMap(item => item.setup.map(setup => setup.layer))))
      .toEqual(new Set(['l2_fact', 'l4_identity']))
    const consolidations = nominal.filter(item => item.expected.operation === 'CONSOLIDATE')
    expect(consolidations).toHaveLength(2)
    expect(consolidations.every(item => item.expected.targetAliases.length >= 2)).toBe(true)
  })

  it('accepts the fixture and rejects phase/order/coverage/cardinality/role/fault/provenance violations', async () => {
    const { validateLifecycleDataset } = await loadMetrics()
    expect(() => validateLifecycleDataset(dataset)).not.toThrow()

    const invalid: LifecycleDataset[] = []
    const duplicateId = mutableDataset()
    duplicateId.cases[1] = { ...duplicateId.cases[1]!, id: duplicateId.cases[0]!.id }
    invalid.push(duplicateId)

    const duplicateAlias = mutableDataset()
    duplicateAlias.cases[3] = {
      ...duplicateAlias.cases[3]!,
      setup: [duplicateAlias.cases[3]!.setup[0]!, duplicateAlias.cases[3]!.setup[0]!],
    }
    invalid.push(duplicateAlias)

    const unknownAlias = mutableDataset()
    unknownAlias.cases[3] = {
      ...unknownAlias.cases[3]!,
      modelScript: unknownAlias.cases[3]!.modelScript.map(step => step.phase === 'reconciliation'
        ? { ...step, payload: { operations: [{ type: 'NOOP', sourceRef: 'new-memory', duplicateAlias: 'missing' }] } }
        : step),
    }
    invalid.push(unknownAlias)

    const missingSourceCoverage = mutableDataset()
    missingSourceCoverage.cases[2] = {
      ...missingSourceCoverage.cases[2]!,
      modelScript: missingSourceCoverage.cases[2]!.modelScript.map(step => step.phase === 'reconciliation'
        ? { ...step, payload: { operations: [{ type: 'ADD', sourceRef: 'wrong-ref' }] } }
        : step),
    }
    invalid.push(missingSourceCoverage)

    const duplicatePhase = mutableDataset()
    duplicatePhase.cases[0] = {
      ...duplicatePhase.cases[0]!,
      modelScript: [duplicatePhase.cases[0]!.modelScript[0]!, duplicatePhase.cases[0]!.modelScript[0]!],
    }
    invalid.push(duplicatePhase)

    const reversedPhases = mutableDataset()
    reversedPhases.cases[0] = {
      ...reversedPhases.cases[0]!,
      modelScript: [...reversedPhases.cases[0]!.modelScript].reverse(),
    }
    invalid.push(reversedPhases)

    const missingPhase = mutableDataset()
    missingPhase.cases[0] = {
      ...missingPhase.cases[0]!,
      modelScript: [missingPhase.cases[0]!.modelScript[0]!],
    }
    invalid.push(missingPhase)

    const overflowPhase = mutableDataset()
    overflowPhase.cases[0] = {
      ...overflowPhase.cases[0]!,
      modelScript: [...overflowPhase.cases[0]!.modelScript, overflowPhase.cases[0]!.modelScript[1]!],
    }
    invalid.push(overflowPhase)

    const danglingExpectedAlias = mutableDataset()
    danglingExpectedAlias.cases[0] = {
      ...danglingExpectedAlias.cases[0]!,
      expected: { ...danglingExpectedAlias.cases[0]!.expected, targetAliases: ['missing'] },
    }
    invalid.push(danglingExpectedAlias)

    const danglingDuplicateAlias = mutableDataset()
    danglingDuplicateAlias.cases[3] = {
      ...danglingDuplicateAlias.cases[3]!,
      expected: { ...danglingDuplicateAlias.cases[3]!.expected, duplicateTargetAlias: 'missing' },
    }
    invalid.push(danglingDuplicateAlias)

    const addWithTarget = mutableDataset()
    addWithTarget.cases[2] = {
      ...addWithTarget.cases[2]!,
      modelScript: addWithTarget.cases[2]!.modelScript.map(step => step.phase === 'reconciliation'
        ? {
            ...step,
            payload: { operations: [{ type: 'ADD', sourceRef: 'new-memory', targetAliases: ['missing'] }] },
          }
        : step),
    }
    invalid.push(addWithTarget)

    const noopWithoutTarget = mutableDataset()
    noopWithoutTarget.cases[3] = {
      ...noopWithoutTarget.cases[3]!,
      modelScript: noopWithoutTarget.cases[3]!.modelScript.map(step => step.phase === 'reconciliation'
        ? { ...step, payload: { operations: [{ type: 'NOOP', sourceRef: 'new-memory' }] } }
        : step),
    }
    invalid.push(noopWithoutTarget)

    const supersedeWithoutTarget = mutableDataset()
    supersedeWithoutTarget.cases[0] = {
      ...supersedeWithoutTarget.cases[0]!,
      modelScript: supersedeWithoutTarget.cases[0]!.modelScript.map(step => step.phase === 'reconciliation'
        ? {
            ...step,
            payload: {
              operations: [{
                type: 'SUPERSEDE', sourceRef: 'new-memory', targetAliases: [],
                content: '北极星项目将在十一月上线。', reason: 'invalid empty targets',
              }],
            },
          }
        : step),
    }
    invalid.push(supersedeWithoutTarget)

    const oneTargetConsolidation = mutableDataset()
    oneTargetConsolidation.cases[5] = {
      ...oneTargetConsolidation.cases[5]!,
      modelScript: oneTargetConsolidation.cases[5]!.modelScript.map(step => step.phase === 'reconciliation'
        ? {
            ...step,
            payload: {
              operations: [{
                type: 'CONSOLIDATE',
                sourceRefs: ['new-memory'],
                targetAliases: ['month'],
                content: '北极星项目定于十月十五日上线。',
              }],
            },
          }
        : step),
    }
    invalid.push(oneTargetConsolidation)

    const invalidDuplicateLabel = mutableDataset()
    invalidDuplicateLabel.cases[3] = {
      ...invalidDuplicateLabel.cases[3]!,
      expected: { operation: 'ADD', targetAliases: [], receiptStatus: 'completed' },
    }
    invalid.push(invalidDuplicateLabel)

    const invalidNominalRole = mutableDataset()
    invalidNominalRole.cases[0] = { ...invalidNominalRole.cases[0]!, role: 'fault_injection' }
    invalid.push(invalidNominalRole)

    const invalidRoleCounts = mutableDataset()
    invalidRoleCounts.cases[0] = { ...invalidRoleCounts.cases[0]!, role: 'metric_sentinel' }
    invalid.push(invalidRoleCounts)

    const swappedNominalRoles = mutableDataset()
    const conformance = swappedNominalRoles.cases[0]!
    const sentinel = swappedNominalRoles.cases[1]!
    swappedNominalRoles.cases[0] = { ...conformance, role: sentinel.role }
    swappedNominalRoles.cases[1] = { ...sentinel, role: conformance.role }
    invalid.push(swappedNominalRoles)

    const swappedFaultRole = mutableDataset()
    const nominalCase = swappedFaultRole.cases[0]!
    const faultCase = swappedFaultRole.cases[14]!
    swappedFaultRole.cases[0] = { ...nominalCase, role: faultCase.role }
    swappedFaultRole.cases[14] = { ...faultCase, role: nominalCase.role }
    invalid.push(swappedFaultRole)

    const invalidRoleLanguageMatrix = mutableDataset()
    invalidRoleLanguageMatrix.cases[14] = { ...invalidRoleLanguageMatrix.cases[14]!, language: 'en' }
    invalid.push(invalidRoleLanguageMatrix)

    const faultEnteringConflict = mutableDataset()
    faultEnteringConflict.cases[14] = {
      ...faultEnteringConflict.cases[14]!,
      measurements: { conflict: true, duplicate: false, degradation: true },
    }
    invalid.push(faultEnteringConflict)

    const mismatchedFault = mutableDataset()
    mismatchedFault.cases[14] = {
      ...mismatchedFault.cases[14]!,
      faultScenario: 'invalid_json',
    }
    invalid.push(mismatchedFault)

    const claimingProvenance = mutableDataset()
    ;(claimingProvenance.provenance as { modelQualityClaim: boolean }).modelQualityClaim = true
    invalid.push(claimingProvenance)

    for (const [index, value] of invalid.entries()) {
      expect(() => validateLifecycleDataset(value), `invalid fixture ${index}`).toThrow()
    }
  })

  it('rejects drift in the frozen confusion, duplicate, and fault-injection matrices', async () => {
    const { validateLifecycleDataset } = await loadMetrics()
    const invalid: Array<{ readonly label: string; readonly value: LifecycleDataset }> = []

    const truePositiveScriptedAsAdd = mutableDataset()
    truePositiveScriptedAsAdd.cases[0] = {
      ...truePositiveScriptedAsAdd.cases[0]!,
      modelScript: truePositiveScriptedAsAdd.cases[0]!.modelScript.map(step => step.phase === 'reconciliation'
        ? { ...step, payload: { operations: [{ type: 'ADD', sourceRef: 'new-memory' }] } }
        : step),
    }
    invalid.push({ label: 'TP scripted as ADD', value: truePositiveScriptedAsAdd })

    const duplicateScriptedAsAdd = mutableDataset()
    duplicateScriptedAsAdd.cases[3] = {
      ...duplicateScriptedAsAdd.cases[3]!,
      modelScript: duplicateScriptedAsAdd.cases[3]!.modelScript.map(step => step.phase === 'reconciliation'
        ? { ...step, payload: { operations: [{ type: 'ADD', sourceRef: 'new-memory' }] } }
        : step),
    }
    invalid.push({ label: 'duplicate NOOP scripted as ADD', value: duplicateScriptedAsAdd })

    const reconciliationFaultWithoutSuccessfulExtraction = mutableDataset()
    reconciliationFaultWithoutSuccessfulExtraction.cases[15] = {
      ...reconciliationFaultWithoutSuccessfulExtraction.cases[15]!,
      modelScript: [
        { phase: 'extraction', outcome: 'invalid_json', rawText: 'not-json' },
        reconciliationFaultWithoutSuccessfulExtraction.cases[15]!.modelScript[1]!,
      ],
    }
    invalid.push({
      label: 'reconciliation fault without successful JSON extraction',
      value: reconciliationFaultWithoutSuccessfulExtraction,
    })

    const driftedFaultDistribution = mutableDataset()
    driftedFaultDistribution.cases[14] = {
      ...driftedFaultDistribution.cases[14]!,
      faultScenario: 'invalid_json',
      modelScript: [{ phase: 'extraction', outcome: 'invalid_json', rawText: 'not-json' }],
    }
    invalid.push({ label: 'fault scenario distribution drift from 2/2/2', value: driftedFaultDistribution })

    const faultEnteringDuplicate = mutableDataset()
    faultEnteringDuplicate.cases[14] = {
      ...faultEnteringDuplicate.cases[14]!,
      measurements: { conflict: false, duplicate: true, degradation: true },
    }
    invalid.push({ label: 'fault entering duplicate denominator', value: faultEnteringDuplicate })

    const parseableInvalidJson = mutableDataset()
    parseableInvalidJson.cases[16] = {
      ...parseableInvalidJson.cases[16]!,
      modelScript: [{ phase: 'extraction', outcome: 'invalid_json', rawText: '{"valid":"json"}' }],
    }
    invalid.push({ label: 'invalid_json rawText accepted by JSON.parse', value: parseableInvalidJson })

    for (const item of invalid) {
      expect.soft(() => validateLifecycleDataset(item.value), item.label).toThrow()
    }
  })
})

describe('MEM-003B lifecycle metric formulas', () => {
  it('uses supplied observer outcomes for the frozen TP/TN/FP/FN and duplicate denominators', async () => {
    const { computeLifecycleMetrics } = await loadMetrics()
    const metrics = computeLifecycleMetrics(handWrittenObservations())

    expect(metrics.conflictAccuracy).toEqual({
      status: 'measured',
      value: 0.714286,
      numerator: 10,
      denominator: 14,
      confusion: {
        truePositive: 2,
        trueNegative: 8,
        falsePositive: 2,
        falseNegative: 2,
      },
      byLanguage: [
        {
          language: 'en', value: 0.714286, numerator: 5, denominator: 7,
          confusion: { truePositive: 1, trueNegative: 4, falsePositive: 1, falseNegative: 1 },
        },
        {
          language: 'zh', value: 0.714286, numerator: 5, denominator: 7,
          confusion: { truePositive: 1, trueNegative: 4, falsePositive: 1, falseNegative: 1 },
        },
      ],
    })
    expect(metrics.duplicateCompressionRate).toEqual({
      status: 'measured',
      value: 0.666667,
      compressed: 4,
      total: 6,
      byLanguage: [
        { language: 'en', value: 0.666667, compressed: 2, total: 3 },
        { language: 'zh', value: 0.666667, compressed: 2, total: 3 },
      ],
    })
  })

  it('reports degradation by scenario only and rounds every ratio to six decimals', async () => {
    const { computeLifecycleMetrics } = await loadMetrics()
    const observations = handWrittenObservations()
    const metrics = computeLifecycleMetrics(observations)

    expect(metrics.degradationRate).toEqual({
      status: 'measured_by_scenario',
      scenarios: {
        nominal: { accepted: 14, degraded: 0, value: 0 },
        injected_model_failure: { accepted: 2, degraded: 2, value: 1 },
        invalid_json: { accepted: 2, degraded: 2, value: 1 },
        schema_failure: { accepted: 2, degraded: 2, value: 1 },
      },
    })
    expect(metrics.degradationRate).not.toHaveProperty('value')
    expect(metrics.degradationRate).not.toHaveProperty('overall')

    const oneNominalDegraded = observations.map((item, index) => index === 0
      ? { ...item, receiptStatus: 'degraded' as const }
      : item)
    expect(computeLifecycleMetrics(oneNominalDegraded).degradationRate.scenarios.nominal.value).toBe(0.071429)
  })

  it('requires both duplicate conditions and serializes recursively sorted canonical JSON', async () => {
    const { canonicalJson, computeLifecycleMetrics } = await loadMetrics()
    const observations = handWrittenObservations()
    const index = observations.findIndex(item => item.id === 'op-en-duplicate-exact')
    observations[index] = {
      ...observations[index]!,
      noNewActiveDerived: true,
      evidenceAttachedToExpectedTarget: false,
    }
    expect(computeLifecycleMetrics(observations).duplicateCompressionRate).toMatchObject({
      value: 0.5,
      compressed: 3,
      total: 6,
    })
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
  })
})

describe('MEM-003B lifecycle report validation', () => {
  it('accepts an independent legal report and allows nonzero hard checks for exit-2 reporting', async () => {
    const { validateLifecycleReport } = await loadMetrics()
    const report = validReportFixture()
    expect(() => validateLifecycleReport(report)).not.toThrow()

    const nonzeroHard = structuredClone(report)
    const hardChecks = nonzeroHard['hardChecks'] as Record<string, unknown>
    hardChecks['rawFirstViolations'] = 1
    expect(() => validateLifecycleReport(nonzeroHard)).not.toThrow()
  })

  it('rejects repeated languages, inconsistent ratios, overall degradation, null misuse, and runtime fields', async () => {
    const { validateLifecycleReport } = await loadMetrics()
    const invalid: Record<string, unknown>[] = []

    const repeatedLanguage = structuredClone(validReportFixture())
    const repeatedMetrics = repeatedLanguage['metrics'] as Record<string, unknown>
    const repeatedConflict = repeatedMetrics['conflictAccuracy'] as Record<string, unknown>
    const repeatedByLanguage = repeatedConflict['byLanguage'] as Array<Record<string, unknown>>
    repeatedByLanguage[1]!['language'] = 'en'
    invalid.push(repeatedLanguage)

    const swappedNominalRoles = structuredClone(validReportFixture())
    const nominalRoleCases = swappedNominalRoles['cases'] as Array<Record<string, unknown>>
    const conformanceRole = nominalRoleCases[0]!['role']
    nominalRoleCases[0]!['role'] = nominalRoleCases[1]!['role']
    nominalRoleCases[1]!['role'] = conformanceRole
    invalid.push(swappedNominalRoles)

    const swappedFaultRole = structuredClone(validReportFixture())
    const faultRoleCases = swappedFaultRole['cases'] as Array<Record<string, unknown>>
    const nominalRole = faultRoleCases[0]!['role']
    faultRoleCases[0]!['role'] = faultRoleCases[14]!['role']
    faultRoleCases[14]!['role'] = nominalRole
    invalid.push(swappedFaultRole)

    const inconsistentDenominator = structuredClone(validReportFixture())
    const inconsistentMetrics = inconsistentDenominator['metrics'] as Record<string, unknown>
    const inconsistentConflict = inconsistentMetrics['conflictAccuracy'] as Record<string, unknown>
    inconsistentConflict['numerator'] = 11
    invalid.push(inconsistentDenominator)

    const inconsistentRounding = structuredClone(validReportFixture())
    const roundingMetrics = inconsistentRounding['metrics'] as Record<string, unknown>
    const roundingConflict = roundingMetrics['conflictAccuracy'] as Record<string, unknown>
    roundingConflict['value'] = 0.714285
    invalid.push(inconsistentRounding)

    const degradationOverall = structuredClone(validReportFixture())
    const degradationMetrics = degradationOverall['metrics'] as Record<string, unknown>
    const degradation = degradationMetrics['degradationRate'] as Record<string, unknown>
    degradation['overall'] = { accepted: 20, degraded: 6, value: 0.3 }
    invalid.push(degradationOverall)

    const invalidCaseNulls = structuredClone(validReportFixture())
    const nullCases = invalidCaseNulls['cases'] as Array<Record<string, unknown>>
    nullCases[0]!['observedOperation'] = null
    nullCases[0]!['conflictLabel'] = null
    invalid.push(invalidCaseNulls)

    const invalidDerivedAddCount = structuredClone(validReportFixture())
    const addCountCases = invalidDerivedAddCount['cases'] as Array<Record<string, unknown>>
    const addCase = addCountCases.find(item => item['observedOperation'] === 'ADD')
    if (addCase === undefined) throw new Error('missing ADD count fixture')
    addCase['newActiveDerivedCount'] = 0
    invalid.push(invalidDerivedAddCount)

    const invalidDerivedSupersedeCount = structuredClone(validReportFixture())
    const supersedeCountCases = invalidDerivedSupersedeCount['cases'] as Array<Record<string, unknown>>
    const supersedeCase = supersedeCountCases.find(item => item['observedOperation'] === 'SUPERSEDE')
    if (supersedeCase === undefined) throw new Error('missing SUPERSEDE count fixture')
    supersedeCase['newActiveDerivedCount'] = 0
    invalid.push(invalidDerivedSupersedeCount)

    const invalidDerivedConsolidateCount = structuredClone(validReportFixture())
    const consolidateCountCases = invalidDerivedConsolidateCount['cases'] as Array<Record<string, unknown>>
    const consolidateCase = consolidateCountCases.find(item => item['observedOperation'] === 'CONSOLIDATE')
    if (consolidateCase === undefined) throw new Error('missing CONSOLIDATE count fixture')
    consolidateCase['newActiveDerivedCount'] = 0
    invalid.push(invalidDerivedConsolidateCount)

    const invalidDerivedNoopCount = structuredClone(validReportFixture())
    const noopCountCases = invalidDerivedNoopCount['cases'] as Array<Record<string, unknown>>
    const noopCase = noopCountCases.find(item => item['observedOperation'] === 'NOOP')
    if (noopCase === undefined) throw new Error('missing NOOP count fixture')
    noopCase['newActiveDerivedCount'] = 1
    invalid.push(invalidDerivedNoopCount)

    const invalidDerivedFaultCount = structuredClone(validReportFixture())
    const faultCountCases = invalidDerivedFaultCount['cases'] as Array<Record<string, unknown>>
    const nullCase = faultCountCases.find(item => item['observedOperation'] === null)
    if (nullCase === undefined) throw new Error('missing fault/null count fixture')
    nullCase['newActiveDerivedCount'] = 1
    invalid.push(invalidDerivedFaultCount)

    const extraRuntimeField = structuredClone(validReportFixture())
    const runtimeCases = extraRuntimeField['cases'] as Array<Record<string, unknown>>
    runtimeCases[0]!['requestId'] = 'random-runtime-id'
    invalid.push(extraRuntimeField)

    for (const [index, report] of invalid.entries()) {
      expect(() => validateLifecycleReport(report), `invalid report ${index}`).toThrow()
    }
  })
})
