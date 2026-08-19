const LANGUAGES = ['en', 'zh']
const OPERATIONS = new Set(['ADD', 'NOOP', 'CONSOLIDATE', 'SUPERSEDE'])
const ROLES = new Set(['conformance', 'metric_sentinel', 'fault_injection'])
const SCENARIOS = ['nominal', 'injected_model_failure', 'invalid_json', 'schema_failure']
const SCENARIO_SET = new Set(SCENARIOS)
const PHASES = new Set(['extraction', 'reconciliation'])
const OUTCOMES = new Set(['json', 'throw', 'invalid_json'])
const LAYERS = new Set(['l2_fact', 'l4_identity'])
const RECEIPTS = new Set(['completed', 'degraded'])
const PROVENANCE = Object.freeze({
  mode: 'scripted',
  interpretation: 'pipeline-conformance-only',
  adapter: 'deterministic-script-adapter-v1',
  externalNetwork: false,
  modelQualityClaim: false,
})

function fail(message) {
  throw new Error(message)
}

function object(value, path, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`)
  const allowed = new Set([...required, ...optional])
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`)
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path} has additional property '${key}'`)
  return value
}

function array(value, path, minimum = 0, maximum = Number.POSITIVE_INFINITY) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${path} must contain ${minimum}..${maximum} items`)
  }
  return value
}

function string(value, path, pattern) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
  if (pattern !== undefined && !pattern.test(value)) fail(`${path} has invalid format`)
  return value
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be boolean`)
  return value
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${path} must be an integer >= ${minimum}`)
  return value
}

function unit(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must be a finite number from 0 through 1`)
  }
  return value
}

function enumValue(value, path, values) {
  if (!values.has(value)) fail(`${path} has unsupported value '${String(value)}'`)
  return value
}

function uniqueStrings(value, path, minimum = 0) {
  const items = array(value, path, minimum).map((item, index) => string(item, `${path}[${index}]`))
  if (new Set(items).size !== items.length) fail(`${path} must contain unique strings`)
  return items
}

function exact(value, expected, path) {
  if (value !== expected) fail(`${path} must equal ${JSON.stringify(expected)}`)
}

function roundRatio(numerator, denominator) {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000
}

function validateProvenance(value, path) {
  const result = object(value, path, Object.keys(PROVENANCE))
  for (const [key, expected] of Object.entries(PROVENANCE)) exact(result[key], expected, `${path}.${key}`)
  return result
}

function validateOwner(value, path) {
  const owner = object(value, path, ['userId', 'agentId'], ['tenantId'])
  string(owner.userId, `${path}.userId`)
  string(owner.agentId, `${path}.agentId`)
  if (owner.tenantId !== undefined) string(owner.tenantId, `${path}.tenantId`)
  return owner
}

function validateExtractionPayload(value, path) {
  const payload = object(value, path, ['basicProfilePatch', 'facts', 'identities'], ['summary'])
  object(payload.basicProfilePatch, `${path}.basicProfilePatch`, [], Object.keys(payload.basicProfilePatch ?? {}))
  const refs = []
  for (const group of ['facts', 'identities']) {
    for (const [index, itemValue] of array(payload[group], `${path}.${group}`).entries()) {
      const item = object(itemValue, `${path}.${group}[${index}]`, [
        'clientRef', 'content', 'layer', 'tags', 'confidence', 'evidenceTurnIndexes',
      ], ['occurredAt', 'speculate'])
      refs.push(string(item.clientRef, `${path}.${group}[${index}].clientRef`))
      string(item.content, `${path}.${group}[${index}].content`)
      enumValue(item.layer, `${path}.${group}[${index}].layer`, LAYERS)
      uniqueStrings(item.tags, `${path}.${group}[${index}].tags`)
      unit(item.confidence, `${path}.${group}[${index}].confidence`)
      for (const [turnIndex, turn] of array(item.evidenceTurnIndexes, `${path}.${group}[${index}].evidenceTurnIndexes`).entries()) {
        integer(turn, `${path}.${group}[${index}].evidenceTurnIndexes[${turnIndex}]`)
      }
      if (item.occurredAt !== undefined) string(item.occurredAt, `${path}.${group}[${index}].occurredAt`)
      if (item.speculate !== undefined) string(item.speculate, `${path}.${group}[${index}].speculate`)
    }
  }
  if (new Set(refs).size !== refs.length) fail(`${path} contains duplicate clientRef values`)
  if (payload.summary !== undefined) string(payload.summary, `${path}.summary`)
  return refs
}

function validateScriptStep(value, path) {
  const prelim = object(value, path, ['phase', 'outcome'], ['payload', 'rawText', 'errorCode'])
  enumValue(prelim.phase, `${path}.phase`, PHASES)
  enumValue(prelim.outcome, `${path}.outcome`, OUTCOMES)
  const required = prelim.outcome === 'json' ? ['phase', 'outcome', 'payload']
    : prelim.outcome === 'throw' ? ['phase', 'outcome', 'errorCode']
      : ['phase', 'outcome', 'rawText']
  const step = object(value, path, required)
  if (step.outcome === 'json') object(step.payload, `${path}.payload`, [], Object.keys(step.payload ?? {}))
  if (step.outcome === 'throw') string(step.errorCode, `${path}.errorCode`, /^[a-z][a-z0-9_]*$/u)
  if (step.outcome === 'invalid_json') {
    string(step.rawText, `${path}.rawText`)
    let parseable = true
    try {
      JSON.parse(step.rawText)
    } catch {
      parseable = false
    }
    if (parseable) fail(`${path}.rawText must not be valid JSON`)
  }
  return step
}

function scriptOperation(step, path, aliases, sourceRefs) {
  if (step === undefined || step.phase !== 'reconciliation' || step.outcome !== 'json') return null
  const payload = object(step.payload, `${path}.payload`, ['operations'])
  const operations = array(payload.operations, `${path}.payload.operations`, 1)
  const covered = []
  let singleType = null
  for (const [index, operationValue] of operations.entries()) {
    const operationPath = `${path}.payload.operations[${index}]`
    const pre = object(operationValue, operationPath, ['type'], [
      'sourceRef', 'sourceRefs', 'duplicateAlias', 'targetAliases', 'content', 'reason',
    ])
    enumValue(pre.type, `${operationPath}.type`, OPERATIONS)
    if (operations.length === 1) singleType = pre.type
    if (pre.type === 'ADD') {
      const operation = object(operationValue, operationPath, ['type', 'sourceRef'])
      covered.push(string(operation.sourceRef, `${operationPath}.sourceRef`))
    } else if (pre.type === 'NOOP') {
      const operation = object(operationValue, operationPath, ['type', 'sourceRef', 'duplicateAlias'])
      covered.push(string(operation.sourceRef, `${operationPath}.sourceRef`))
      if (!aliases.has(string(operation.duplicateAlias, `${operationPath}.duplicateAlias`))) {
        fail(`${operationPath}.duplicateAlias references an unknown setup alias`)
      }
    } else {
      const required = pre.type === 'SUPERSEDE'
        ? ['type', 'sourceRef', 'targetAliases', 'content', 'reason']
        : ['type', 'sourceRefs', 'targetAliases', 'content']
      const operation = object(operationValue, operationPath, required)
      if (pre.type === 'SUPERSEDE') covered.push(string(operation.sourceRef, `${operationPath}.sourceRef`))
      else covered.push(...uniqueStrings(operation.sourceRefs, `${operationPath}.sourceRefs`, 1))
      const targets = uniqueStrings(operation.targetAliases, `${operationPath}.targetAliases`, pre.type === 'CONSOLIDATE' ? 2 : 1)
      for (const alias of targets) if (!aliases.has(alias)) fail(`${operationPath} references unknown target alias '${alias}'`)
      string(operation.content, `${operationPath}.content`)
      if (pre.type === 'SUPERSEDE') string(operation.reason, `${operationPath}.reason`)
    }
  }
  if (covered.length !== sourceRefs.length || new Set(covered).size !== covered.length
    || covered.some(ref => !sourceRefs.includes(ref))) {
    fail(`${path} must cover every extracted sourceRef exactly once`)
  }
  return singleType
}

function validateExpected(value, path, aliases) {
  const expected = object(value, path, ['operation', 'targetAliases', 'receiptStatus'], ['duplicateTargetAlias'])
  if (expected.operation !== null) enumValue(expected.operation, `${path}.operation`, OPERATIONS)
  const targets = uniqueStrings(expected.targetAliases, `${path}.targetAliases`)
  for (const alias of targets) if (!aliases.has(alias)) fail(`${path}.targetAliases references unknown alias '${alias}'`)
  enumValue(expected.receiptStatus, `${path}.receiptStatus`, RECEIPTS)
  if (expected.duplicateTargetAlias !== undefined) {
    const alias = string(expected.duplicateTargetAlias, `${path}.duplicateTargetAlias`)
    if (!aliases.has(alias)) fail(`${path}.duplicateTargetAlias references unknown alias '${alias}'`)
  }
  return expected
}

function validateLifecycleCase(value, path) {
  const item = object(value, path, [
    'id', 'language', 'role', 'faultScenario', 'owner', 'sessionId', 'content', 'idempotencyKey',
    'setup', 'modelScript', 'measurements', 'expected',
  ])
  string(item.id, `${path}.id`, /^[a-z][a-z0-9-]*$/u)
  enumValue(item.language, `${path}.language`, new Set(LANGUAGES))
  enumValue(item.role, `${path}.role`, ROLES)
  enumValue(item.faultScenario, `${path}.faultScenario`, SCENARIO_SET)
  validateOwner(item.owner, `${path}.owner`)
  string(item.sessionId, `${path}.sessionId`)
  string(item.content, `${path}.content`)
  string(item.idempotencyKey, `${path}.idempotencyKey`)
  const aliases = new Set()
  for (const [index, setupValue] of array(item.setup, `${path}.setup`, 0, 4).entries()) {
    const setup = object(setupValue, `${path}.setup[${index}]`, ['alias', 'content', 'layer'])
    const alias = string(setup.alias, `${path}.setup[${index}].alias`, /^[a-z][a-z0-9-]*$/u)
    if (aliases.has(alias)) fail(`${path}.setup contains duplicate alias '${alias}'`)
    aliases.add(alias)
    string(setup.content, `${path}.setup[${index}].content`)
    enumValue(setup.layer, `${path}.setup[${index}].layer`, LAYERS)
  }
  const script = array(item.modelScript, `${path}.modelScript`, 1, 2)
    .map((step, index) => validateScriptStep(step, `${path}.modelScript[${index}]`))
  const phaseNames = script.map(step => step.phase)
  if (new Set(phaseNames).size !== phaseNames.length || phaseNames[0] !== 'extraction'
    || (phaseNames.length === 2 && phaseNames[1] !== 'reconciliation')) {
    fail(`${path}.modelScript phases must be extraction then optional reconciliation`)
  }
  const intentionalExtractionSchemaFailure = item.faultScenario === 'schema_failure'
    && script.at(-1)?.phase === 'extraction'
  const intentionalReconciliationSchemaFailure = item.faultScenario === 'schema_failure'
    && script.at(-1)?.phase === 'reconciliation'
  let sourceRefs = []
  if (script[0].outcome === 'json' && !intentionalExtractionSchemaFailure) {
    sourceRefs = validateExtractionPayload(script[0].payload, `${path}.modelScript[0].payload`)
  }
  const operation = intentionalReconciliationSchemaFailure
    ? null
    : scriptOperation(script[1], `${path}.modelScript[1]`, aliases, sourceRefs)
  const measurements = object(item.measurements, `${path}.measurements`, ['conflict', 'duplicate', 'degradation'])
  boolean(measurements.conflict, `${path}.measurements.conflict`)
  boolean(measurements.duplicate, `${path}.measurements.duplicate`)
  exact(measurements.degradation, true, `${path}.measurements.degradation`)
  const expected = validateExpected(item.expected, `${path}.expected`, aliases)

  if (item.faultScenario === 'nominal') {
    exact(measurements.conflict, true, `${path}.measurements.conflict`)
    exact(expected.receiptStatus, 'completed', `${path}.expected.receiptStatus`)
    if (expected.operation === null || script.length !== 2 || operation === null) fail(`${path} nominal case requires one observed operation`)
    const frozenSentinelRole = item.id.endsWith('-fn') || item.id.endsWith('-fp')
    exact(item.role, frozenSentinelRole ? 'metric_sentinel' : 'conformance', `${path}.role`)
  } else {
    exact(item.role, 'fault_injection', `${path}.role`)
    exact(measurements.conflict, false, `${path}.measurements.conflict`)
    exact(measurements.duplicate, false, `${path}.measurements.duplicate`)
    exact(expected.operation, null, `${path}.expected.operation`)
    exact(expected.targetAliases.length, 0, `${path}.expected.targetAliases.length`)
    exact(expected.receiptStatus, 'degraded', `${path}.expected.receiptStatus`)
    const last = script.at(-1)
    if (last.phase === 'reconciliation' && (script.length !== 2 || script[0].outcome !== 'json')) {
      fail(`${path} reconciliation fault requires a successful JSON extraction step`)
    }
    if (item.faultScenario === 'injected_model_failure') exact(last.outcome, 'throw', `${path}.modelScript[last].outcome`)
    if (item.faultScenario === 'invalid_json') exact(last.outcome, 'invalid_json', `${path}.modelScript[last].outcome`)
    if (item.faultScenario === 'schema_failure') {
      exact(last.outcome, 'json', `${path}.modelScript[last].outcome`)
      if (last.phase === 'extraction') {
        let valid = true
        try {
          validateExtractionPayload(last.payload, `${path}.modelScript[last].payload`)
        } catch {
          valid = false
        }
        if (valid) fail(`${path} schema failure payload unexpectedly passed extraction shape`)
      }
      if (last.phase === 'reconciliation') {
        let valid = true
        try {
          scriptOperation(last, `${path}.modelScript[last]`, aliases, sourceRefs)
        } catch {
          valid = false
        }
        if (valid) fail(`${path} schema failure payload unexpectedly passed reconciliation shape`)
      }
    }
  }
  if (measurements.duplicate) {
    exact(expected.operation, 'NOOP', `${path}.expected.operation`)
    if (expected.duplicateTargetAlias === undefined || !expected.targetAliases.includes(expected.duplicateTargetAlias)) {
      fail(`${path} duplicate case must identify its expected target`)
    }
  } else if (expected.duplicateTargetAlias !== undefined) {
    fail(`${path}.expected.duplicateTargetAlias is only valid for duplicate measurement`)
  }
  return { item, operation, finalPhase: script.at(-1).phase }
}

function frozenNominalOperation(id) {
  if (id.endsWith('-supersede-tp') || id.endsWith('-duplicate-fp')) return 'SUPERSEDE'
  if (id.endsWith('-supersede-fn') || id.endsWith('-add-tn')) return 'ADD'
  if (id.endsWith('-duplicate-exact') || id.endsWith('-duplicate-paraphrase')) return 'NOOP'
  if (id.endsWith('-consolidate-tn')) return 'CONSOLIDATE'
  return undefined
}

/** Validate both the strict JSON shape and the frozen MEM-003B semantic matrix. */
export function validateLifecycleDataset(value) {
  const dataset = object(value, 'dataset', [
    'schemaVersion', 'datasetId', 'datasetVersion', 'referenceCommit', 'provenance', 'cases',
  ])
  exact(dataset.schemaVersion, 1, 'dataset.schemaVersion')
  exact(dataset.datasetId, 'dsh-memory-lifecycle-scripted', 'dataset.datasetId')
  string(dataset.datasetVersion, 'dataset.datasetVersion')
  string(dataset.referenceCommit, 'dataset.referenceCommit', /^[0-9a-f]{40}$/u)
  validateProvenance(dataset.provenance, 'dataset.provenance')
  const seen = new Set()
  const parsed = array(dataset.cases, 'dataset.cases', 20, 20).map((item, index) => {
    const result = validateLifecycleCase(item, `dataset.cases[${index}]`)
    if (seen.has(result.item.id)) fail(`duplicate lifecycle case id '${result.item.id}'`)
    seen.add(result.item.id)
    return result
  })
  for (const language of LANGUAGES) {
    const cases = parsed.filter(result => result.item.language === language)
    exact(cases.length, 10, `dataset ${language} case count`)
    exact(cases.filter(result => result.item.faultScenario === 'nominal').length, 7, `dataset ${language} nominal count`)
    exact(cases.filter(result => result.item.role === 'conformance').length, 5, `dataset ${language} conformance count`)
    exact(cases.filter(result => result.item.role === 'metric_sentinel').length, 2, `dataset ${language} sentinel count`)
    exact(cases.filter(result => result.item.role === 'fault_injection').length, 3, `dataset ${language} fault count`)
    exact(cases.filter(result => result.item.measurements.duplicate).length, 3, `dataset ${language} duplicate count`)
  }
  const nominal = parsed.filter(result => result.item.faultScenario === 'nominal')
  for (const result of nominal) {
    const expectedScript = frozenNominalOperation(result.item.id)
    if (expectedScript === undefined) fail(`dataset has unknown nominal case id '${result.item.id}'`)
    exact(result.operation, expectedScript, `dataset scripted operation for '${result.item.id}'`)
  }
  const operationCounts = Object.fromEntries([...OPERATIONS].map(operation => [
    operation,
    nominal.filter(result => result.operation === operation).length,
  ]))
  exact(operationCounts.ADD, 4, 'dataset scripted ADD count')
  exact(operationCounts.NOOP, 4, 'dataset scripted NOOP count')
  exact(operationCounts.CONSOLIDATE, 2, 'dataset scripted CONSOLIDATE count')
  exact(operationCounts.SUPERSEDE, 4, 'dataset scripted SUPERSEDE count')
  const duplicateCases = nominal.filter(result => result.item.measurements.duplicate)
  exact(duplicateCases.length, 6, 'dataset duplicate denominator')
  exact(duplicateCases.filter(result => result.operation === 'NOOP').length, 4, 'dataset compressed duplicate script count')
  for (const scenario of SCENARIOS.slice(1)) {
    const cases = parsed.filter(result => result.item.faultScenario === scenario)
    exact(cases.length, 2, `dataset ${scenario} count`)
    if (new Set(cases.map(result => result.item.language)).size !== 2) fail(`dataset ${scenario} must cover both languages`)
    const zh = cases.find(result => result.item.language === 'zh')
    const en = cases.find(result => result.item.language === 'en')
    exact(zh?.finalPhase, 'extraction', `dataset ${scenario} zh phase`)
    exact(en?.finalPhase, 'reconciliation', `dataset ${scenario} en phase`)
  }
  return dataset
}

function confusionFor(cases) {
  const confusion = { truePositive: 0, trueNegative: 0, falsePositive: 0, falseNegative: 0 }
  for (const item of cases) {
    const expectedPositive = item.expectedOperation === 'SUPERSEDE'
    const predictedPositive = item.observedOperation === 'SUPERSEDE'
    if (expectedPositive && predictedPositive) confusion.truePositive += 1
    else if (!expectedPositive && !predictedPositive) confusion.trueNegative += 1
    else if (!expectedPositive && predictedPositive) confusion.falsePositive += 1
    else confusion.falseNegative += 1
  }
  return confusion
}

function conflictMetric(cases) {
  const confusion = confusionFor(cases)
  const denominator = cases.length
  const numerator = confusion.truePositive + confusion.trueNegative
  return { value: roundRatio(numerator, denominator), numerator, denominator, confusion }
}

function duplicateMetric(cases) {
  const total = cases.length
  const compressed = cases.filter(item => item.noNewActiveDerived === true
    && item.evidenceAttachedToExpectedTarget === true).length
  return { value: roundRatio(compressed, total), compressed, total }
}

/** Compute lifecycle metrics exclusively from persisted-state observations. */
export function computeLifecycleMetrics(cases) {
  if (!Array.isArray(cases)) fail('observations must be an array')
  const nominal = cases.filter(item => item.faultScenario === 'nominal' && item.expectedOperation !== null)
  const conflict = conflictMetric(nominal)
  const duplicates = cases.filter(item => item.duplicateMeasured === true)
  const duplicate = duplicateMetric(duplicates)
  return {
    conflictAccuracy: {
      status: 'measured',
      ...conflict,
      byLanguage: LANGUAGES.map((language) => ({
        language,
        ...conflictMetric(nominal.filter(item => item.language === language)),
      })),
    },
    duplicateCompressionRate: {
      status: 'measured',
      ...duplicate,
      byLanguage: LANGUAGES.map((language) => ({
        language,
        ...duplicateMetric(duplicates.filter(item => item.language === language)),
      })),
    },
    degradationRate: {
      status: 'measured_by_scenario',
      scenarios: Object.fromEntries(SCENARIOS.map((scenario) => {
        const accepted = cases.filter(item => item.faultScenario === scenario).length
        const degraded = cases.filter(item => item.faultScenario === scenario && item.receiptStatus === 'degraded').length
        return [scenario, { accepted, degraded, value: roundRatio(degraded, accepted) }]
      })),
    },
  }
}

function validateConfusion(value, path) {
  const result = object(value, path, ['truePositive', 'trueNegative', 'falsePositive', 'falseNegative'])
  for (const key of Object.keys(result)) integer(result[key], `${path}.${key}`)
  return result
}

function validateCaseReport(value, path) {
  const item = object(value, path, [
    'id', 'language', 'role', 'scenario', 'expectedOperation', 'observedOperation', 'conflictLabel',
    'receiptStatus', 'observedTargetAliases', 'newActiveDerivedCount', 'duplicateObservation', 'rawFirstPass',
  ])
  string(item.id, `${path}.id`)
  enumValue(item.language, `${path}.language`, new Set(LANGUAGES))
  enumValue(item.role, `${path}.role`, ROLES)
  enumValue(item.scenario, `${path}.scenario`, SCENARIO_SET)
  if (item.expectedOperation !== null) enumValue(item.expectedOperation, `${path}.expectedOperation`, OPERATIONS)
  if (item.observedOperation !== null) enumValue(item.observedOperation, `${path}.observedOperation`, OPERATIONS)
  const validLabels = new Set(['TP', 'TN', 'FP', 'FN', null])
  enumValue(item.conflictLabel, `${path}.conflictLabel`, validLabels)
  enumValue(item.receiptStatus, `${path}.receiptStatus`, RECEIPTS)
  uniqueStrings(item.observedTargetAliases, `${path}.observedTargetAliases`)
  integer(item.newActiveDerivedCount, `${path}.newActiveDerivedCount`)
  boolean(item.rawFirstPass, `${path}.rawFirstPass`)
  const duplicate = object(item.duplicateObservation, `${path}.duplicateObservation`, [
    'measured', 'noNewActiveDerived', 'evidenceAttachedToExpectedTarget', 'compressed',
  ])
  boolean(duplicate.measured, `${path}.duplicateObservation.measured`)
  for (const key of ['noNewActiveDerived', 'evidenceAttachedToExpectedTarget', 'compressed']) {
    if (duplicate[key] !== null) boolean(duplicate[key], `${path}.duplicateObservation.${key}`)
  }
  if (item.scenario === 'nominal') {
    if (item.expectedOperation === null) fail(`${path} nominal expected operation cannot be null`)
    const label = item.observedOperation === null ? null
      : item.expectedOperation === 'SUPERSEDE'
        ? item.observedOperation === 'SUPERSEDE' ? 'TP' : 'FN'
        : item.observedOperation === 'SUPERSEDE' ? 'FP' : 'TN'
    exact(item.conflictLabel, label, `${path}.conflictLabel`)
    const frozenSentinelRole = item.id.endsWith('-fn') || item.id.endsWith('-fp')
    exact(item.role, frozenSentinelRole ? 'metric_sentinel' : 'conformance', `${path}.role`)
  } else {
    exact(item.role, 'fault_injection', `${path}.role`)
    exact(item.expectedOperation, null, `${path}.expectedOperation`)
    exact(item.observedOperation, null, `${path}.observedOperation`)
    exact(item.conflictLabel, null, `${path}.conflictLabel`)
    exact(duplicate.measured, false, `${path}.duplicateObservation.measured`)
  }
  if (duplicate.measured) {
    if (duplicate.noNewActiveDerived === null || duplicate.evidenceAttachedToExpectedTarget === null) {
      fail(`${path}.duplicateObservation measured fields cannot be null`)
    }
    exact(duplicate.compressed,
      duplicate.noNewActiveDerived && duplicate.evidenceAttachedToExpectedTarget,
      `${path}.duplicateObservation.compressed`)
  } else {
    for (const key of ['noNewActiveDerived', 'evidenceAttachedToExpectedTarget', 'compressed']) {
      exact(duplicate[key], null, `${path}.duplicateObservation.${key}`)
    }
  }
  return item
}

function reportObservations(cases) {
  return cases.map(item => ({
    id: item.id,
    language: item.language,
    faultScenario: item.scenario,
    expectedOperation: item.expectedOperation,
    observedOperation: item.observedOperation,
    receiptStatus: item.receiptStatus,
    duplicateMeasured: item.duplicateObservation.measured,
    noNewActiveDerived: item.duplicateObservation.noNewActiveDerived,
    evidenceAttachedToExpectedTarget: item.duplicateObservation.evidenceAttachedToExpectedTarget,
  }))
}

/** Strictly validate a stable lifecycle report and every redundant formula. */
export function validateLifecycleReport(value) {
  const report = object(value, 'report', [
    'schemaVersion', 'dataset', 'runner', 'provenance', 'counts', 'metrics', 'cases', 'hardChecks',
  ])
  exact(report.schemaVersion, 1, 'report.schemaVersion')
  const dataset = object(report.dataset, 'report.dataset', ['id', 'version', 'referenceCommit'])
  exact(dataset.id, 'dsh-memory-lifecycle-scripted', 'report.dataset.id')
  string(dataset.version, 'report.dataset.version')
  string(dataset.referenceCommit, 'report.dataset.referenceCommit', /^[0-9a-f]{40}$/u)
  const runner = object(report.runner, 'report.runner', ['version', 'repeats'])
  exact(runner.version, 1, 'report.runner.version')
  integer(runner.repeats, 'report.runner.repeats', 1)
  validateProvenance(report.provenance, 'report.provenance')
  const counts = object(report.counts, 'report.counts', ['totalCases', 'nominalCases', 'faultCases', 'acceptedExtractWrites'])
  exact(counts.totalCases, 20, 'report.counts.totalCases')
  exact(counts.nominalCases, 14, 'report.counts.nominalCases')
  exact(counts.faultCases, 6, 'report.counts.faultCases')
  exact(counts.acceptedExtractWrites, 20, 'report.counts.acceptedExtractWrites')
  const cases = array(report.cases, 'report.cases', 20, 20).map((item, index) => validateCaseReport(item, `report.cases[${index}]`))
  if (new Set(cases.map(item => item.id)).size !== cases.length) fail('report.cases has duplicate IDs')
  const nominalCases = cases.filter(item => item.scenario === 'nominal')
  const faultCases = cases.filter(item => item.scenario !== 'nominal')
  exact(nominalCases.length, 14, 'report nominal case count')
  exact(faultCases.length, 6, 'report fault case count')
  for (const scenario of SCENARIOS.slice(1)) {
    exact(cases.filter(item => item.scenario === scenario).length, 2, `report ${scenario} case count`)
  }
  exact(counts.totalCases, cases.length, 'report.counts.totalCases consistency')
  exact(counts.nominalCases, nominalCases.length, 'report.counts.nominalCases consistency')
  exact(counts.faultCases, faultCases.length, 'report.counts.faultCases consistency')
  exact(counts.acceptedExtractWrites, cases.length, 'report.counts.acceptedExtractWrites consistency')
  for (const language of LANGUAGES) {
    exact(cases.filter(item => item.language === language).length, 10, `report ${language} case count`)
  }

  const metrics = object(report.metrics, 'report.metrics', [
    'conflictAccuracy', 'duplicateCompressionRate', 'degradationRate',
  ])
  const conflict = object(metrics.conflictAccuracy, 'report.metrics.conflictAccuracy', [
    'status', 'value', 'numerator', 'denominator', 'confusion', 'byLanguage',
  ])
  exact(conflict.status, 'measured', 'report.metrics.conflictAccuracy.status')
  unit(conflict.value, 'report.metrics.conflictAccuracy.value')
  integer(conflict.numerator, 'report.metrics.conflictAccuracy.numerator')
  integer(conflict.denominator, 'report.metrics.conflictAccuracy.denominator', 1)
  validateConfusion(conflict.confusion, 'report.metrics.conflictAccuracy.confusion')
  const conflictLanguages = array(conflict.byLanguage, 'report.metrics.conflictAccuracy.byLanguage', 2, 2)
  for (const [index, value] of conflictLanguages.entries()) {
    const item = object(value, `report.metrics.conflictAccuracy.byLanguage[${index}]`, [
      'language', 'value', 'numerator', 'denominator', 'confusion',
    ])
    enumValue(item.language, `report.metrics.conflictAccuracy.byLanguage[${index}].language`, new Set(LANGUAGES))
    unit(item.value, `report.metrics.conflictAccuracy.byLanguage[${index}].value`)
    integer(item.numerator, `report.metrics.conflictAccuracy.byLanguage[${index}].numerator`)
    integer(item.denominator, `report.metrics.conflictAccuracy.byLanguage[${index}].denominator`, 1)
    validateConfusion(item.confusion, `report.metrics.conflictAccuracy.byLanguage[${index}].confusion`)
  }
  if (new Set(conflictLanguages.map(item => item.language)).size !== 2) fail('conflict byLanguage must contain en and zh once')

  const duplicate = object(metrics.duplicateCompressionRate, 'report.metrics.duplicateCompressionRate', [
    'status', 'value', 'compressed', 'total', 'byLanguage',
  ])
  exact(duplicate.status, 'measured', 'report.metrics.duplicateCompressionRate.status')
  unit(duplicate.value, 'report.metrics.duplicateCompressionRate.value')
  integer(duplicate.compressed, 'report.metrics.duplicateCompressionRate.compressed')
  integer(duplicate.total, 'report.metrics.duplicateCompressionRate.total', 1)
  const duplicateLanguages = array(duplicate.byLanguage, 'report.metrics.duplicateCompressionRate.byLanguage', 2, 2)
  for (const [index, value] of duplicateLanguages.entries()) {
    const item = object(value, `report.metrics.duplicateCompressionRate.byLanguage[${index}]`, [
      'language', 'value', 'compressed', 'total',
    ])
    enumValue(item.language, `report.metrics.duplicateCompressionRate.byLanguage[${index}].language`, new Set(LANGUAGES))
    unit(item.value, `report.metrics.duplicateCompressionRate.byLanguage[${index}].value`)
    integer(item.compressed, `report.metrics.duplicateCompressionRate.byLanguage[${index}].compressed`)
    integer(item.total, `report.metrics.duplicateCompressionRate.byLanguage[${index}].total`, 1)
  }
  if (new Set(duplicateLanguages.map(item => item.language)).size !== 2) fail('duplicate byLanguage must contain en and zh once')

  const degradation = object(metrics.degradationRate, 'report.metrics.degradationRate', ['status', 'scenarios'])
  exact(degradation.status, 'measured_by_scenario', 'report.metrics.degradationRate.status')
  const scenarios = object(degradation.scenarios, 'report.metrics.degradationRate.scenarios', SCENARIOS)
  for (const scenario of SCENARIOS) {
    const item = object(scenarios[scenario], `report.metrics.degradationRate.scenarios.${scenario}`, ['accepted', 'degraded', 'value'])
    integer(item.accepted, `report.metrics.degradationRate.scenarios.${scenario}.accepted`, 1)
    integer(item.degraded, `report.metrics.degradationRate.scenarios.${scenario}.degraded`)
    unit(item.value, `report.metrics.degradationRate.scenarios.${scenario}.value`)
  }

  const expectedMetrics = computeLifecycleMetrics(reportObservations(cases))
  if (canonicalJson(metrics) !== canonicalJson(expectedMetrics)) fail('report.metrics are inconsistent with case observations')
  const hard = object(report.hardChecks, 'report.hardChecks', [
    'rawFirstViolations', 'unexpectedDerivedOnDegraded', 'observationAmbiguities',
    'scriptConsumptionErrors', 'unexpectedReceiptStatuses', 'scopeLeaks',
  ])
  for (const key of Object.keys(hard)) integer(hard[key], `report.hardChecks.${key}`)
  const receiptMismatches = cases.filter(item => item.scenario === 'nominal'
    ? item.receiptStatus !== 'completed'
    : item.receiptStatus !== 'degraded').length
  if (receiptMismatches > hard.unexpectedReceiptStatuses) {
    fail('report contains receipt-status drift not accounted by unexpectedReceiptStatuses')
  }
  const nullNominal = cases.some(item => item.scenario === 'nominal' && item.observedOperation === null)
  if (nullNominal && hard.observationAmbiguities === 0) {
    fail('report contains an unaccounted nominal observation ambiguity')
  }
  for (const item of cases) {
    const expectedCount = item.observedOperation === null || item.observedOperation === 'NOOP' ? 0 : 1
    if (item.newActiveDerivedCount === expectedCount) continue
    const accounted = item.scenario !== 'nominal'
      ? hard.unexpectedDerivedOnDegraded > 0
      : hard.observationAmbiguities > 0
    if (!accounted) fail(`report case '${item.id}' has an unaccounted derived-count mismatch`)
  }
  return report
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]))
  }
  return value
}

/** Serialize deterministic reports with recursively sorted object keys. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}
