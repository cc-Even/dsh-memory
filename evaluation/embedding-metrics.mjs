const LANGUAGES = ['zh', 'en']
const BUCKETS = ['synonym', 'exact']
const SPLITS = new Set(['baseline', 'holdout'])

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

function array(value, path, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) fail(`${path} must be an array with at least ${minimum} item(s)`)
  return value
}

function string(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
  return value
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${path} must be an integer >= ${minimum}`)
  return value
}

function unit(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${path} must be a number from 0 through 1`)
  }
  return value
}

function enumValue(value, path, values) {
  if (!values.includes(value)) fail(`${path} has unsupported value '${String(value)}'`)
  return value
}

function ids(value, path, unique = true) {
  const result = array(value, path).map((item, index) => string(item, `${path}[${index}]`))
  if (unique && new Set(result).size !== result.length) fail(`${path} must contain unique IDs`)
  return result
}

function owner(value, path) {
  const result = object(value, path, ['tenantId', 'userId', 'agentId'])
  string(result.tenantId, `${path}.tenantId`)
  string(result.userId, `${path}.userId`)
  string(result.agentId, `${path}.agentId`)
  return result
}

function ownerKey(value) {
  return JSON.stringify([value.tenantId, value.userId, value.agentId])
}

function timestamp(value, path) {
  const text = string(value, path)
  if (!text.endsWith('Z') || Number.isNaN(Date.parse(text))) fail(`${path} must be an ISO UTC timestamp`)
  return text
}

/** Validate the frozen bilingual embedding corpus and its semantic references. */
export function validateEmbeddingDataset(value) {
  const dataset = object(value, 'dataset', [
    'schemaVersion', 'datasetId', 'datasetVersion', 'referenceCommit', 'evaluationTime', 'records', 'queries',
  ])
  if (dataset.schemaVersion !== 1) fail('dataset.schemaVersion must equal 1')
  if (dataset.datasetId !== 'dsh-memory-embedding') fail('dataset.datasetId must equal dsh-memory-embedding')
  if (dataset.datasetVersion !== '1.0.0') fail('dataset.datasetVersion must equal 1.0.0')
  if (dataset.referenceCommit !== 'cf9234c4038289f966deef1303edb8a03635da97') {
    fail('dataset.referenceCommit must match the frozen MEM-101 reference commit')
  }
  timestamp(dataset.evaluationTime, 'dataset.evaluationTime')

  const records = new Map()
  for (const [index, raw] of array(dataset.records, 'dataset.records', 29).entries()) {
    const path = `dataset.records[${index}]`
    const record = object(raw, path, [
      'id', 'language', 'owner', 'sourceSessionId', 'content', 'tags', 'status', 'visibility', 'createdAt',
    ])
    const id = string(record.id, `${path}.id`)
    if (records.has(id)) fail(`duplicate record id '${id}'`)
    enumValue(record.language, `${path}.language`, LANGUAGES)
    owner(record.owner, `${path}.owner`)
    string(record.sourceSessionId, `${path}.sourceSessionId`)
    string(record.content, `${path}.content`)
    const tags = ids(record.tags, `${path}.tags`)
    if (tags.length !== 0) fail(`${path}.tags must be empty so labels cannot leak into search`)
    enumValue(record.status, `${path}.status`, ['active', 'deleted'])
    enumValue(record.visibility, `${path}.visibility`, ['recallable', 'source_only'])
    if (record.status === 'deleted' && record.visibility === 'recallable') fail(`${path} deleted record cannot be recallable`)
    timestamp(record.createdAt, `${path}.createdAt`)
    records.set(id, record)
  }

  const queryIds = new Set()
  const cells = new Map()
  for (const [index, raw] of array(dataset.queries, 'dataset.queries', 26).entries()) {
    const path = `dataset.queries[${index}]`
    const query = object(raw, path, [
      'id', 'language', 'bucket', 'split', 'owner', 'sessionId', 'query', 'relevantIds', 'forbiddenIds',
    ])
    const id = string(query.id, `${path}.id`)
    if (queryIds.has(id)) fail(`duplicate query id '${id}'`)
    queryIds.add(id)
    enumValue(query.language, `${path}.language`, LANGUAGES)
    enumValue(query.bucket, `${path}.bucket`, BUCKETS)
    enumValue(query.split, `${path}.split`, [...SPLITS])
    owner(query.owner, `${path}.owner`)
    string(query.sessionId, `${path}.sessionId`)
    const queryText = string(query.query, `${path}.query`)
    if (queryText.includes(id)) fail(`query '${id}' leaks its case label`)
    const relevant = ids(query.relevantIds, `${path}.relevantIds`)
    if (relevant.length === 0) fail(`${path}.relevantIds must not be empty`)
    const forbidden = ids(query.forbiddenIds, `${path}.forbiddenIds`)
    if (relevant.some(recordId => forbidden.includes(recordId))) fail(`${path} relevantIds and forbiddenIds overlap`)
    for (const recordId of [...relevant, ...forbidden]) {
      if (!records.has(recordId)) fail(`query '${id}' references unknown record '${recordId}'`)
    }
    for (const recordId of relevant) {
      const record = records.get(recordId)
      if (record.language !== query.language) fail(`query '${id}' relevant language mismatch for '${recordId}'`)
      if (ownerKey(record.owner) !== ownerKey(query.owner)) fail(`query '${id}' relevant owner mismatch for '${recordId}'`)
      if (record.status !== 'active' || record.visibility !== 'recallable') {
        fail(`query '${id}' relevant record '${recordId}' must be active and recallable`)
      }
    }
    const key = `${query.bucket}/${query.language}`
    const cell = cells.get(key) ?? { count: 0, splits: new Set() }
    cell.count += 1
    cell.splits.add(query.split)
    cells.set(key, cell)
  }
  for (const bucket of BUCKETS) {
    const zh = cells.get(`${bucket}/zh`)
    const en = cells.get(`${bucket}/en`)
    const minimum = bucket === 'synonym' ? 10 : 3
    if (zh === undefined || en === undefined || zh.count < minimum || en.count < minimum || zh.count !== en.count) {
      fail(`dataset ${bucket} language cells must be balanced with at least ${minimum} queries`)
    }
    if (zh.splits.size !== 2 || en.splits.size !== 2) fail(`dataset ${bucket} cells must cover baseline and holdout`)
  }
}

function round6(value) {
  return Number(value.toFixed(6))
}

function metric(cases) {
  return {
    recallAt5: round6(cases.reduce((sum, item) => sum + item.recallAt5, 0) / cases.length),
    recallAt10: round6(cases.reduce((sum, item) => sum + item.recallAt10, 0) / cases.length),
    mrrAt10: round6(cases.reduce((sum, item) => sum + item.reciprocalRank, 0) / cases.length),
  }
}

/** Compute per-case rankings, bilingual macro metrics, and hard-check totals. */
export function computeEmbeddingMetrics(rankings) {
  const cases = []
  let scopeLeaks = 0
  let forbiddenHits = 0
  let duplicateResultIds = 0
  for (const ranking of rankings) {
    const returnedIds = [...ranking.returnedIds]
    const relevant = new Set(ranking.relevantIds)
    const firstIndex = returnedIds.slice(0, 10).findIndex(id => relevant.has(id))
    const firstRelevantRank = firstIndex < 0 ? null : firstIndex + 1
    const caseForbidden = [...new Set(returnedIds.filter(id => ranking.forbiddenIds.includes(id)))]
    const recallAt5 = ranking.relevantIds.filter(id => returnedIds.slice(0, 5).includes(id)).length / ranking.relevantIds.length
    const recallAt10 = ranking.relevantIds.filter(id => returnedIds.slice(0, 10).includes(id)).length / ranking.relevantIds.length
    cases.push({
      id: ranking.id,
      language: ranking.language,
      bucket: ranking.bucket,
      split: ranking.split,
      relevantIds: [...ranking.relevantIds],
      forbiddenIds: [...ranking.forbiddenIds],
      returnedIds,
      firstRelevantRank,
      recallAt5: round6(recallAt5),
      recallAt10: round6(recallAt10),
      reciprocalRank: firstRelevantRank === null ? 0 : round6(1 / firstRelevantRank),
      forbiddenHits: caseForbidden,
    })
    scopeLeaks += ranking.scopeLeaks
    forbiddenHits += caseForbidden.length
    duplicateResultIds += returnedIds.length - new Set(returnedIds).size
  }
  const buckets = BUCKETS.flatMap(bucket => LANGUAGES.map(language => {
    const cell = cases.filter(item => item.bucket === bucket && item.language === language)
    return { bucket, language, queryCount: cell.length, ...metric(cell) }
  }))
  return {
    metrics: {
      synonym: metric(cases.filter(item => item.bucket === 'synonym')),
      exact: metric(cases.filter(item => item.bucket === 'exact')),
    },
    buckets,
    cases,
    hardChecks: { scopeLeaks, forbiddenHits, duplicateResultIds },
  }
}

function validateMetric(value, path, optional = []) {
  const result = object(value, path, ['recallAt5', 'recallAt10', 'mrrAt10'], optional)
  unit(result.recallAt5, `${path}.recallAt5`)
  unit(result.recallAt10, `${path}.recallAt10`)
  unit(result.mrrAt10, `${path}.mrrAt10`)
  return result
}

/** Validate report shape, provenance, and every aggregate against returned IDs. */
export function validateEmbeddingReport(value) {
  const report = object(value, 'report', [
    'schemaVersion', 'dataset', 'runner', 'provider', 'metrics', 'buckets', 'cases', 'hardChecks',
  ])
  if (report.schemaVersion !== 1) fail('report.schemaVersion must equal 1')
  const dataset = object(report.dataset, 'report.dataset', ['id', 'version', 'referenceCommit'])
  if (dataset.id !== 'dsh-memory-embedding') fail('report.dataset.id must equal dsh-memory-embedding')
  string(dataset.version, 'report.dataset.version')
  if (!/^[0-9a-f]{40}$/u.test(dataset.referenceCommit)) fail('report.dataset.referenceCommit must be a SHA')
  const runner = object(report.runner, 'report.runner', ['version', 'repeats', 'mode', 'externalNetwork'])
  if (runner.version !== 1) fail('report.runner.version must equal 1')
  integer(runner.repeats, 'report.runner.repeats', 1)
  enumValue(runner.mode, 'report.runner.mode', ['offline-hash', 'live'])
  if (typeof runner.externalNetwork !== 'boolean') fail('report.runner.externalNetwork must be boolean')
  const provider = object(report.provider, 'report.provider', [
    'quality', 'model', 'spaceId', 'dimensions', 'normalization',
  ])
  enumValue(provider.quality, 'report.provider.quality', ['portable-hash', 'trained'])
  if (provider.model !== null) string(provider.model, 'report.provider.model')
  string(provider.spaceId, 'report.provider.spaceId')
  integer(provider.dimensions, 'report.provider.dimensions', 1)
  if (provider.normalization !== 'l2') fail('report.provider.normalization must equal l2')
  if (runner.mode === 'offline-hash'
    && (runner.externalNetwork !== false || provider.quality !== 'portable-hash' || provider.model !== null)) {
    fail('report offline mode/network/provider provenance is inconsistent')
  }
  if (runner.mode === 'live'
    && (runner.externalNetwork !== true || provider.quality !== 'trained' || provider.model === null)) {
    fail('report live mode/network/provider provenance is inconsistent')
  }

  const metrics = object(report.metrics, 'report.metrics', ['synonym', 'exact'])
  validateMetric(metrics.synonym, 'report.metrics.synonym')
  validateMetric(metrics.exact, 'report.metrics.exact')
  const bucketValues = array(report.buckets, 'report.buckets', 4)
  if (bucketValues.length !== 4) fail('report.buckets must contain four cells')
  const bucketKeys = new Set()
  for (const [index, raw] of bucketValues.entries()) {
    const path = `report.buckets[${index}]`
    const cell = object(raw, path, ['bucket', 'language', 'queryCount', 'recallAt5', 'recallAt10', 'mrrAt10'])
    enumValue(cell.bucket, `${path}.bucket`, BUCKETS)
    enumValue(cell.language, `${path}.language`, LANGUAGES)
    integer(cell.queryCount, `${path}.queryCount`, 1)
    validateMetric(cell, path, ['bucket', 'language', 'queryCount'])
    const key = `${cell.bucket}/${cell.language}`
    if (bucketKeys.has(key)) fail(`report.buckets has duplicate cell '${key}'`)
    bucketKeys.add(key)
  }

  const rankings = []
  const caseIds = new Set()
  for (const [index, raw] of array(report.cases, 'report.cases', 26).entries()) {
    const path = `report.cases[${index}]`
    const item = object(raw, path, [
      'id', 'language', 'bucket', 'split', 'relevantIds', 'forbiddenIds', 'returnedIds',
      'firstRelevantRank', 'recallAt5', 'recallAt10', 'reciprocalRank', 'forbiddenHits',
    ])
    string(item.id, `${path}.id`)
    if (caseIds.has(item.id)) fail(`report contains duplicate case id '${item.id}'`)
    caseIds.add(item.id)
    enumValue(item.language, `${path}.language`, LANGUAGES)
    enumValue(item.bucket, `${path}.bucket`, BUCKETS)
    enumValue(item.split, `${path}.split`, [...SPLITS])
    const relevantIds = ids(item.relevantIds, `${path}.relevantIds`)
    if (relevantIds.length === 0) fail(`${path}.relevantIds must not be empty`)
    const forbiddenIds = ids(item.forbiddenIds, `${path}.forbiddenIds`)
    const returnedIds = ids(item.returnedIds, `${path}.returnedIds`, false)
    if (item.firstRelevantRank !== null) integer(item.firstRelevantRank, `${path}.firstRelevantRank`, 1)
    unit(item.recallAt5, `${path}.recallAt5`)
    unit(item.recallAt10, `${path}.recallAt10`)
    unit(item.reciprocalRank, `${path}.reciprocalRank`)
    ids(item.forbiddenHits, `${path}.forbiddenHits`)
    rankings.push({
      id: item.id,
      language: item.language,
      bucket: item.bucket,
      split: item.split,
      relevantIds,
      forbiddenIds,
      returnedIds,
      scopeLeaks: 0,
    })
  }
  const measured = computeEmbeddingMetrics(rankings)
  for (const [index, item] of report.cases.entries()) {
    const expected = measured.cases[index]
    for (const key of ['firstRelevantRank', 'recallAt5', 'recallAt10', 'reciprocalRank', 'forbiddenHits']) {
      if (canonicalJson(item[key]) !== canonicalJson(expected[key])) {
        fail(`report.cases[${index}].${key} is inconsistent with returnedIds`)
      }
    }
  }
  if (canonicalJson(report.metrics) !== canonicalJson(measured.metrics)) fail('report aggregate metrics are inconsistent with cases')
  if (canonicalJson(report.buckets) !== canonicalJson(measured.buckets)) fail('report bucket metrics are inconsistent with cases')
  const hard = object(report.hardChecks, 'report.hardChecks', ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds'])
  integer(hard.scopeLeaks, 'report.hardChecks.scopeLeaks', 0)
  integer(hard.forbiddenHits, 'report.hardChecks.forbiddenHits', 0)
  integer(hard.duplicateResultIds, 'report.hardChecks.duplicateResultIds', 0)
  if (hard.forbiddenHits !== measured.hardChecks.forbiddenHits
    || hard.duplicateResultIds !== measured.hardChecks.duplicateResultIds) {
    fail('report hard-check metrics are inconsistent with cases')
  }
}

/** Apply the trained-provider relative quality, exact non-regression, and isolation gates. */
export function evaluateEmbeddingGates(baseline, live, gates) {
  const denominator = baseline.metrics.synonym.recallAt10
  const relative = denominator === 0
    ? Number.POSITIVE_INFINITY
    : (live.metrics.synonym.recallAt10 - denominator) / denominator
  const failures = []
  const relativeFloor = gates.live.relativeSynonymRecallAt10Floor
  const exactFloor = gates.live.exactRecallAt10Floor
  if (relative + Number.EPSILON < relativeFloor) {
    failures.push(`relative synonym Recall@10 below ${relativeFloor}`)
  }
  if (live.metrics.exact.recallAt10 + Number.EPSILON < exactFloor) {
    failures.push(`exact Recall@10 below configured floor ${exactFloor}`)
  }
  for (const [key, value] of Object.entries(live.hardChecks)) {
    const maximum = gates.hardChecks[key]
    if (value > maximum) failures.push(`hard check ${key} exceeds configured maximum ${maximum}`)
  }
  return {
    passed: failures.length === 0,
    relativeSynonymRecallAt10: Number.isFinite(relative) ? round6(relative) : relative,
    failures,
  }
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

/** Stable serialization with recursively sorted object keys. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}
