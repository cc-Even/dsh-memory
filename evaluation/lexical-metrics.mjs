const BUCKETS = ['continuous_cjk', 'mixed_language', 'punctuation_boundary', 'short_term']
const SPLITS = ['baseline', 'holdout']

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

function array(value, path, minimum, maximum = minimum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail(`${path} must contain from ${minimum} through ${maximum} item(s)`)
  }
  return value
}

function string(value, path, pattern) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
  if (pattern !== undefined && !pattern.test(value)) fail(`${path} has an invalid format`)
  return value
}

function enumeration(value, path, values) {
  if (!values.includes(value)) fail(`${path} has unsupported value '${String(value)}'`)
  return value
}

function integer(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function number(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${path} must be a number from ${minimum} through ${maximum}`)
  }
  return value
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail(`${path} must be boolean`)
  return value
}

function timestamp(value, path) {
  const text = string(value, path)
  if (!text.endsWith('Z') || Number.isNaN(Date.parse(text))) fail(`${path} must be an ISO UTC timestamp`)
  return text
}

function owner(value, path) {
  const result = object(value, path, ['tenantId', 'userId', 'agentId'])
  string(result.tenantId, `${path}.tenantId`)
  string(result.userId, `${path}.userId`)
  string(result.agentId, `${path}.agentId`)
  return result
}

function uniqueStrings(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, pattern) {
  const result = array(value, path, minimum, maximum)
    .map((item, index) => string(item, `${path}[${index}]`, pattern))
  if (new Set(result).size !== result.length) fail(`${path} must contain unique values`)
  return result
}

function ownerKey(value) {
  return JSON.stringify([value.tenantId, value.userId, value.agentId])
}

function validateRecord(value, path) {
  const record = object(value, path, ['id', 'content'])
  string(record.id, `${path}.id`, /^r[0-9a-f]{12}$/u)
  string(record.content, `${path}.content`)
  return record
}

/** Validate the compact frozen lexical dataset and every semantic reference. */
export function validateLexicalDataset(value) {
  const dataset = object(value, 'dataset', [
    'schemaVersion', 'datasetId', 'datasetVersion', 'referenceCommit', 'evaluationTime',
    'groups', 'filterRecords', 'filterQueries',
  ])
  if (dataset.schemaVersion !== 1) fail('dataset.schemaVersion must equal 1')
  if (dataset.datasetId !== 'dsh-memory-lexical') fail('dataset.datasetId must equal dsh-memory-lexical')
  if (dataset.datasetVersion !== '1.0.0') fail('dataset.datasetVersion must equal 1.0.0')
  string(dataset.referenceCommit, 'dataset.referenceCommit', /^[0-9a-f]{40}$/u)
  timestamp(dataset.evaluationTime, 'dataset.evaluationTime')

  const recordIds = new Set()
  const queryIds = new Set()
  const groupIds = new Set()
  const cells = new Map()
  for (const [groupIndex, raw] of array(dataset.groups, 'dataset.groups', 6).entries()) {
    const path = `dataset.groups[${groupIndex}]`
    const group = object(raw, path, [
      'id', 'owner', 'sourceSessionId', 'records', 'sharedInterference',
      'distractorCodes', 'distractorIds', 'queries',
    ])
    const groupId = string(group.id, `${path}.id`, /^g[0-9]{2}$/u)
    if (groupIds.has(groupId)) fail(`duplicate group id '${groupId}'`)
    groupIds.add(groupId)
    owner(group.owner, `${path}.owner`)
    string(group.sourceSessionId, `${path}.sourceSessionId`)
    const records = [
      ...array(group.records, `${path}.records`, 4).map((item, index) => validateRecord(item, `${path}.records[${index}]`)),
      ...array(group.sharedInterference, `${path}.sharedInterference`, 2)
        .map((item, index) => validateRecord(item, `${path}.sharedInterference[${index}]`)),
    ]
    const codes = object(group.distractorCodes, `${path}.distractorCodes`, [
      'continuous_cjk', 'punctuation_boundary', 'short_term',
    ])
    const ids = object(group.distractorIds, `${path}.distractorIds`, [
      'continuous_cjk', 'punctuation_boundary', 'short_term',
    ])
    for (const bucket of ['continuous_cjk', 'punctuation_boundary', 'short_term']) {
      uniqueStrings(codes[bucket], `${path}.distractorCodes.${bucket}`, 12, 12, /^[a-z0-9]{5}$/u)
      const bucketIds = uniqueStrings(ids[bucket], `${path}.distractorIds.${bucket}`, 12, 12, /^r[0-9a-f]{12}$/u)
      records.push(...bucketIds.map((id, index) => ({ id, content: codes[bucket][index] })))
    }
    for (const record of records) {
      if (recordIds.has(record.id)) fail(`duplicate record id '${record.id}'`)
      recordIds.add(record.id)
    }
    const localIds = new Set(records.map(record => record.id))
    for (const [queryIndex, rawQuery] of array(group.queries, `${path}.queries`, 4).entries()) {
      const queryPath = `${path}.queries[${queryIndex}]`
      const query = object(rawQuery, queryPath, ['id', 'bucket', 'split', 'query', 'relevantIds'])
      const id = string(query.id, `${queryPath}.id`, /^q[0-9]{4}$/u)
      if (queryIds.has(id)) fail(`duplicate query id '${id}'`)
      queryIds.add(id)
      const bucket = enumeration(query.bucket, `${queryPath}.bucket`, BUCKETS)
      const split = enumeration(query.split, `${queryPath}.split`, SPLITS)
      string(query.query, `${queryPath}.query`)
      const relevantIds = uniqueStrings(query.relevantIds, `${queryPath}.relevantIds`, 1, Number.MAX_SAFE_INTEGER, /^r[0-9a-f]{12}$/u)
      for (const recordId of relevantIds) if (!localIds.has(recordId)) fail(`${queryPath} references unknown local record '${recordId}'`)
      const cell = cells.get(bucket) ?? { count: 0, splits: new Set() }
      cell.count += 1
      cell.splits.add(split)
      cells.set(bucket, cell)
    }
  }

  for (const bucket of BUCKETS) {
    const cell = cells.get(bucket)
    if (cell?.count !== 6 || cell.splits.size !== 2) fail(`dataset bucket '${bucket}' must contain six queries and both splits`)
  }

  const filters = new Map()
  for (const [index, raw] of array(dataset.filterRecords, 'dataset.filterRecords', 6).entries()) {
    const path = `dataset.filterRecords[${index}]`
    const record = object(raw, path, [
      'id', 'owner', 'sourceSessionId', 'content', 'status', 'visibility',
    ], ['validUntil'])
    const id = string(record.id, `${path}.id`, /^r[0-9a-f]{12}$/u)
    if (recordIds.has(id)) fail(`duplicate record id '${id}'`)
    recordIds.add(id)
    owner(record.owner, `${path}.owner`)
    string(record.sourceSessionId, `${path}.sourceSessionId`)
    string(record.content, `${path}.content`)
    enumeration(record.status, `${path}.status`, ['active', 'deleted'])
    enumeration(record.visibility, `${path}.visibility`, ['recallable', 'source_only'])
    if (record.status === 'deleted' && record.visibility === 'recallable') fail(`${path} deleted record cannot be recallable`)
    if (record.validUntil !== undefined) timestamp(record.validUntil, `${path}.validUntil`)
    filters.set(id, record)
  }
  for (const [index, raw] of array(dataset.filterQueries, 'dataset.filterQueries', 6).entries()) {
    const path = `dataset.filterQueries[${index}]`
    const query = object(raw, path, ['id', 'owner', 'sessionId', 'sessionOnly', 'query', 'forbiddenIds'])
    const id = string(query.id, `${path}.id`, /^q[0-9]{4}$/u)
    if (queryIds.has(id)) fail(`duplicate query id '${id}'`)
    queryIds.add(id)
    owner(query.owner, `${path}.owner`)
    string(query.sessionId, `${path}.sessionId`)
    boolean(query.sessionOnly, `${path}.sessionOnly`)
    string(query.query, `${path}.query`)
    const forbiddenIds = uniqueStrings(query.forbiddenIds, `${path}.forbiddenIds`, 1, Number.MAX_SAFE_INTEGER, /^r[0-9a-f]{12}$/u)
    for (const recordId of forbiddenIds) if (!filters.has(recordId)) fail(`${path} references unknown filter record '${recordId}'`)
  }
  if (recordIds.size !== 258 || queryIds.size !== 30) fail('dataset must materialize 258 records and 30 queries')
}

function round6(value) {
  return Number(value.toFixed(6))
}

function aggregate(cases) {
  return {
    recallAt5: round6(cases.reduce((sum, item) => sum + item.recallAt5, 0) / cases.length),
    recallAt10: round6(cases.reduce((sum, item) => sum + item.recallAt10, 0) / cases.length),
    mrrAt10: round6(cases.reduce((sum, item) => sum + item.reciprocalRank, 0) / cases.length),
  }
}

function computeMode(rankings, kind, implementation) {
  const cases = []
  let scopeLeaks = 0
  let forbiddenHits = 0
  let duplicateResultIds = 0
  for (const ranking of rankings) {
    const returnedIds = [...ranking.returnedIds]
    const forbidden = [...new Set(returnedIds.filter(id => ranking.forbiddenIds.includes(id)))]
    scopeLeaks += ranking.scopeLeaks
    forbiddenHits += forbidden.length
    duplicateResultIds += returnedIds.length - new Set(returnedIds).size
    if (ranking.bucket === 'filter') {
      cases.push({
        id: ranking.id,
        bucket: 'filter',
        split: 'filter',
        relevantIds: [],
        forbiddenIds: [...ranking.forbiddenIds],
        returnedIds,
        firstRelevantRank: null,
        recallAt5: null,
        recallAt10: null,
        reciprocalRank: null,
        forbiddenHits: forbidden,
      })
      continue
    }
    const relevant = new Set(ranking.relevantIds)
    const firstIndex = returnedIds.slice(0, 10).findIndex(id => relevant.has(id))
    const firstRelevantRank = firstIndex < 0 ? null : firstIndex + 1
    cases.push({
      id: ranking.id,
      bucket: ranking.bucket,
      split: ranking.split,
      relevantIds: [...ranking.relevantIds],
      forbiddenIds: [...ranking.forbiddenIds],
      returnedIds,
      firstRelevantRank,
      recallAt5: round6(ranking.relevantIds.filter(id => returnedIds.slice(0, 5).includes(id)).length / ranking.relevantIds.length),
      recallAt10: round6(ranking.relevantIds.filter(id => returnedIds.slice(0, 10).includes(id)).length / ranking.relevantIds.length),
      reciprocalRank: firstRelevantRank === null ? 0 : round6(1 / firstRelevantRank),
      forbiddenHits: forbidden,
    })
  }
  const scored = cases.filter(item => item.bucket !== 'filter')
  return {
    tokenizer: { kind, implementation },
    metrics: aggregate(scored),
    buckets: BUCKETS.map(bucket => {
      const cell = scored.filter(item => item.bucket === bucket)
      return { bucket, queryCount: cell.length, ...aggregate(cell) }
    }),
    cases,
    hardChecks: { scopeLeaks, forbiddenHits, duplicateResultIds },
  }
}

/** Compute both modes, per-bucket metrics, deltas, and isolation totals from returned IDs. */
export function computeLexicalMetrics(legacy, cjkBigram) {
  const legacyMode = computeMode(legacy, 'legacy', 'LegacyTokenizer')
  const cjkMode = computeMode(cjkBigram, 'cjk-bigram', 'CjkBigramTokenizer')
  return {
    modes: { legacy: legacyMode, cjkBigram: cjkMode },
    delta: {
      recallAt5: round6(cjkMode.metrics.recallAt5 - legacyMode.metrics.recallAt5),
      recallAt10: round6(cjkMode.metrics.recallAt10 - legacyMode.metrics.recallAt10),
      mrrAt10: round6(cjkMode.metrics.mrrAt10 - legacyMode.metrics.mrrAt10),
    },
  }
}

function metricTriple(value, path, delta = false) {
  const metric = object(value, path, ['recallAt5', 'recallAt10', 'mrrAt10'])
  const minimum = delta ? -1 : 0
  number(metric.recallAt5, `${path}.recallAt5`, minimum, 1)
  number(metric.recallAt10, `${path}.recallAt10`, minimum, 1)
  number(metric.mrrAt10, `${path}.mrrAt10`, minimum, 1)
  return metric
}

function validateMode(value, path, expectedKind) {
  const mode = object(value, path, ['tokenizer', 'metrics', 'buckets', 'cases', 'hardChecks'])
  const tokenizer = object(mode.tokenizer, `${path}.tokenizer`, ['kind', 'implementation'])
  if (tokenizer.kind !== expectedKind) fail(`${path}.tokenizer.kind must equal ${expectedKind}`)
  string(tokenizer.implementation, `${path}.tokenizer.implementation`)
  metricTriple(mode.metrics, `${path}.metrics`)
  const seenBuckets = new Set()
  for (const [index, raw] of array(mode.buckets, `${path}.buckets`, 4).entries()) {
    const cellPath = `${path}.buckets[${index}]`
    const cell = object(raw, cellPath, ['bucket', 'queryCount', 'recallAt5', 'recallAt10', 'mrrAt10'])
    const bucket = enumeration(cell.bucket, `${cellPath}.bucket`, BUCKETS)
    if (seenBuckets.has(bucket)) fail(`${path}.buckets contains duplicate '${bucket}'`)
    seenBuckets.add(bucket)
    integer(cell.queryCount, `${cellPath}.queryCount`, 6, 6)
    number(cell.recallAt5, `${cellPath}.recallAt5`, 0, 1)
    number(cell.recallAt10, `${cellPath}.recallAt10`, 0, 1)
    number(cell.mrrAt10, `${cellPath}.mrrAt10`, 0, 1)
  }
  const caseIds = new Set()
  let scoredCount = 0
  let filterCount = 0
  const rankings = []
  for (const [index, raw] of array(mode.cases, `${path}.cases`, 30).entries()) {
    const casePath = `${path}.cases[${index}]`
    const item = object(raw, casePath, [
      'id', 'bucket', 'split', 'relevantIds', 'forbiddenIds', 'returnedIds',
      'firstRelevantRank', 'recallAt5', 'recallAt10', 'reciprocalRank', 'forbiddenHits',
    ])
    const id = string(item.id, `${casePath}.id`)
    if (caseIds.has(id)) fail(`${path}.cases contains duplicate id '${id}'`)
    caseIds.add(id)
    const returnedIds = array(item.returnedIds, `${casePath}.returnedIds`, 0, Number.MAX_SAFE_INTEGER)
      .map((entry, entryIndex) => string(entry, `${casePath}.returnedIds[${entryIndex}]`))
    if (item.bucket === 'filter') {
      filterCount += 1
      if (item.split !== 'filter') fail(`${casePath}.split must equal filter`)
      const relevantIds = uniqueStrings(item.relevantIds, `${casePath}.relevantIds`, 0, 0)
      const forbiddenIds = uniqueStrings(item.forbiddenIds, `${casePath}.forbiddenIds`, 1)
      if (item.firstRelevantRank !== null || item.recallAt5 !== null || item.recallAt10 !== null || item.reciprocalRank !== null) {
        fail(`${casePath} filter scores must be null`)
      }
      uniqueStrings(item.forbiddenHits, `${casePath}.forbiddenHits`, 0)
      rankings.push({ id, bucket: 'filter', split: 'filter', relevantIds, forbiddenIds, returnedIds, scopeLeaks: 0 })
    } else {
      scoredCount += 1
      const bucket = enumeration(item.bucket, `${casePath}.bucket`, BUCKETS)
      const split = enumeration(item.split, `${casePath}.split`, SPLITS)
      const relevantIds = uniqueStrings(item.relevantIds, `${casePath}.relevantIds`, 1)
      const forbiddenIds = uniqueStrings(item.forbiddenIds, `${casePath}.forbiddenIds`, 0, 0)
      if (item.firstRelevantRank !== null) integer(item.firstRelevantRank, `${casePath}.firstRelevantRank`, 1, 10)
      number(item.recallAt5, `${casePath}.recallAt5`, 0, 1)
      number(item.recallAt10, `${casePath}.recallAt10`, 0, 1)
      number(item.reciprocalRank, `${casePath}.reciprocalRank`, 0, 1)
      uniqueStrings(item.forbiddenHits, `${casePath}.forbiddenHits`, 0, 0)
      rankings.push({ id, bucket, split, relevantIds, forbiddenIds, returnedIds, scopeLeaks: 0 })
    }
  }
  if (scoredCount !== 24 || filterCount !== 6) fail(`${path}.cases must contain 24 scored and 6 filter cases`)
  const hard = object(mode.hardChecks, `${path}.hardChecks`, ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds'])
  integer(hard.scopeLeaks, `${path}.hardChecks.scopeLeaks`)
  integer(hard.forbiddenHits, `${path}.hardChecks.forbiddenHits`)
  integer(hard.duplicateResultIds, `${path}.hardChecks.duplicateResultIds`)

  const measured = computeMode(rankings, expectedKind, tokenizer.implementation)
  if (canonicalJson(mode.metrics) !== canonicalJson(measured.metrics)) fail(`${path}.metrics is inconsistent with returned IDs`)
  if (canonicalJson(mode.buckets) !== canonicalJson(measured.buckets)) fail(`${path}.buckets is inconsistent with returned IDs`)
  for (const [index, item] of mode.cases.entries()) {
    const expected = measured.cases[index]
    for (const key of ['firstRelevantRank', 'recallAt5', 'recallAt10', 'reciprocalRank', 'forbiddenHits']) {
      if (canonicalJson(item[key]) !== canonicalJson(expected[key])) fail(`${path}.cases[${index}].${key} is inconsistent with returned IDs`)
    }
  }
  if (hard.forbiddenHits !== measured.hardChecks.forbiddenHits
    || hard.duplicateResultIds !== measured.hardChecks.duplicateResultIds) {
    fail(`${path}.hardChecks is inconsistent with returned IDs`)
  }
}

/** Validate the complete deterministic two-mode lexical report. */
export function validateLexicalReport(value) {
  const report = object(value, 'report', ['schemaVersion', 'dataset', 'runner', 'embeddingSpace', 'modes', 'delta'])
  if (report.schemaVersion !== 1) fail('report.schemaVersion must equal 1')
  const dataset = object(report.dataset, 'report.dataset', ['id', 'version', 'referenceCommit'])
  if (dataset.id !== 'dsh-memory-lexical' || dataset.version !== '1.0.0') fail('report dataset provenance is invalid')
  string(dataset.referenceCommit, 'report.dataset.referenceCommit', /^[0-9a-f]{40}$/u)
  const runner = object(report.runner, 'report.runner', ['version', 'repeats', 'externalNetwork'])
  if (runner.version !== 1 || runner.externalNetwork !== false) fail('report runner provenance is invalid')
  integer(runner.repeats, 'report.runner.repeats', 1)
  const space = object(report.embeddingSpace, 'report.embeddingSpace', ['id', 'dimensions'])
  if (space.id !== 'dsh-memory/hash-token-char-v1/256/l2' || space.dimensions !== 256) fail('report embedding space is invalid')
  const modes = object(report.modes, 'report.modes', ['legacy', 'cjkBigram'])
  validateMode(modes.legacy, 'report.modes.legacy', 'legacy')
  validateMode(modes.cjkBigram, 'report.modes.cjkBigram', 'cjk-bigram')
  const delta = metricTriple(report.delta, 'report.delta', true)
  const expectedDelta = {
    recallAt5: round6(modes.cjkBigram.metrics.recallAt5 - modes.legacy.metrics.recallAt5),
    recallAt10: round6(modes.cjkBigram.metrics.recallAt10 - modes.legacy.metrics.recallAt10),
    mrrAt10: round6(modes.cjkBigram.metrics.mrrAt10 - modes.legacy.metrics.mrrAt10),
  }
  if (canonicalJson(delta) !== canonicalJson(expectedDelta)) {
    fail('report.delta is inconsistent with mode metrics')
  }
  for (let index = 0; index < modes.legacy.cases.length; index += 1) {
    const legacy = modes.legacy.cases[index]
    const cjk = modes.cjkBigram.cases[index]
    for (const key of ['id', 'bucket', 'split', 'relevantIds', 'forbiddenIds']) {
      if (canonicalJson(legacy[key]) !== canonicalJson(cjk[key])) {
        fail(`report modes are misaligned at cases[${index}].${key}`)
      }
    }
  }
}

function validateGates(value, report) {
  const gates = object(value, 'gates', ['schemaVersion', 'dataset', 'quality', 'hardChecks'])
  if (gates.schemaVersion !== 1) fail('gates.schemaVersion must equal 1')
  const dataset = object(gates.dataset, 'gates.dataset', ['id', 'version', 'referenceCommit'])
  if (canonicalJson(dataset) !== canonicalJson(report.dataset)) fail('gates dataset does not match report')
  const quality = object(gates.quality, 'gates.quality', [
    'cjkRecallAt10Floor', 'cjkMrrAt10Floor', 'recallAt10DeltaFloor', 'mrrAt10DeltaFloor',
    'bucketRecallAt10Floor', 'legacyRecallAt10MinimumExclusive', 'legacyRecallAt10Maximum',
    'legacyMrrAt10MinimumExclusive', 'legacyMrrAt10Maximum',
  ])
  for (const [key, value] of Object.entries(quality)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`gates.quality.${key} must be a finite number`)
  }
  const hard = object(gates.hardChecks, 'gates.hardChecks', ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds'])
  for (const key of ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds']) integer(hard[key], `gates.hardChecks.${key}`)
  return gates
}

/** Apply every configured quality, headroom, bucket, and hard-check gate. */
export function evaluateLexicalGates(report, value) {
  validateLexicalReport(report)
  const gates = validateGates(value, report)
  const failures = []
  const quality = gates.quality
  const legacy = report.modes.legacy.metrics
  const cjk = report.modes.cjkBigram.metrics
  const floor = (actual, configured, key) => {
    if (actual < configured) failures.push(`${key} below configured floor ${configured}`)
  }
  const maximum = (actual, configured, key) => {
    if (actual > configured) failures.push(`${key} exceeds configured maximum ${configured}`)
  }
  floor(cjk.recallAt10, quality.cjkRecallAt10Floor, 'cjkRecallAt10Floor')
  floor(cjk.mrrAt10, quality.cjkMrrAt10Floor, 'cjkMrrAt10Floor')
  floor(report.delta.recallAt10, quality.recallAt10DeltaFloor, 'recallAt10DeltaFloor')
  floor(report.delta.mrrAt10, quality.mrrAt10DeltaFloor, 'mrrAt10DeltaFloor')
  for (const bucket of report.modes.cjkBigram.buckets) {
    floor(bucket.recallAt10, quality.bucketRecallAt10Floor, `bucketRecallAt10Floor:${bucket.bucket}`)
  }
  if (legacy.recallAt10 <= quality.legacyRecallAt10MinimumExclusive) {
    failures.push(`legacyRecallAt10MinimumExclusive not exceeded ${quality.legacyRecallAt10MinimumExclusive}`)
  }
  maximum(legacy.recallAt10, quality.legacyRecallAt10Maximum, 'legacyRecallAt10Maximum')
  if (legacy.mrrAt10 <= quality.legacyMrrAt10MinimumExclusive) {
    failures.push(`legacyMrrAt10MinimumExclusive not exceeded ${quality.legacyMrrAt10MinimumExclusive}`)
  }
  maximum(legacy.mrrAt10, quality.legacyMrrAt10Maximum, 'legacyMrrAt10Maximum')
  for (const mode of Object.values(report.modes)) {
    for (const [key, actual] of Object.entries(mode.hardChecks)) {
      if (actual > gates.hardChecks[key]) failures.push(`${key} exceeds configured maximum ${gates.hardChecks[key]}`)
    }
  }
  return { passed: failures.length === 0, failures }
}

function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`))
  if (typeof value !== 'object') fail(`${path} contains a non-JSON value`)
  const result = {}
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key], `${path}.${key}`)
  return result
}

/** Stable JSON serialization with recursively sorted object keys. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}
