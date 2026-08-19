const LANGUAGES = new Set(['zh', 'en'])
const BUCKETS = new Set([
  'synonym',
  'pronoun',
  'multi_topic',
  'current_head',
  'temporal',
  'cross_session',
  'exact_id',
])
const CHANNELS = new Set(['normal', 'profile'])
const LAYERS = new Set(['l0_basic_info', 'l1_raw', 'l2_fact', 'l3_summary', 'l4_identity'])
const STATUSES = new Set(['active', 'superseded', 'archived', 'deleted'])
const VISIBILITIES = new Set(['recallable', 'source_only'])
const SOURCE_TYPES = new Set(['explicit', 'inferred', 'composite'])
const SPLITS = new Set(['baseline', 'holdout'])
const PROFILE_LAYERS = new Set(['l0_basic_info', 'l4_identity'])

function fail(message) {
  throw new Error(message)
}

function object(value, path, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`)
  }
  const allowed = new Set([...required, ...optional])
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} has additional property '${key}'`)
  }
  return value
}

function array(value, path, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    fail(`${path} must be an array with at least ${minimum} item(s)`)
  }
  return value
}

function string(value, path) {
  if (typeof value !== 'string' || value.length === 0) fail(`${path} must be a non-empty string`)
  return value
}

function enumValue(value, path, values) {
  if (!values.has(value)) fail(`${path} has an unsupported enum value '${String(value)}'`)
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

function dateTime(value, path) {
  const text = string(value, path)
  if (!text.endsWith('Z') || Number.isNaN(Date.parse(text))) fail(`${path} must be an ISO 8601 UTC timestamp`)
  return text
}

function stringArray(value, path, unique = true) {
  const values = array(value, path).map((item, index) => string(item, `${path}[${index}]`))
  if (unique && new Set(values).size !== values.length) fail(`${path} must contain unique IDs`)
  return values
}

function owner(value, path) {
  const result = object(value, path, ['userId', 'agentId'], ['tenantId'])
  string(result.userId, `${path}.userId`)
  string(result.agentId, `${path}.agentId`)
  if (result.tenantId !== undefined) string(result.tenantId, `${path}.tenantId`)
  return result
}

function ownerKey(value) {
  return JSON.stringify([value.tenantId ?? '', value.userId, value.agentId])
}

function channelFor(record) {
  return PROFILE_LAYERS.has(record.layer) ? 'profile' : 'normal'
}

function activeAt(record, instant) {
  return (record.validFrom === undefined || Date.parse(record.validFrom) <= instant)
    && (record.validUntil === undefined || Date.parse(record.validUntil) > instant)
}

function validateRecord(value, path) {
  const record = object(value, path, [
    'id', 'owner', 'sourceSessionId', 'layer', 'content', 'tags', 'status', 'visibility',
    'sourceType', 'confidence', 'createdAt', 'updatedAt', 'revision', 'relations',
  ], ['occurredAt', 'validFrom', 'validUntil'])
  string(record.id, `${path}.id`)
  owner(record.owner, `${path}.owner`)
  string(record.sourceSessionId, `${path}.sourceSessionId`)
  enumValue(record.layer, `${path}.layer`, LAYERS)
  string(record.content, `${path}.content`)
  stringArray(record.tags, `${path}.tags`)
  enumValue(record.status, `${path}.status`, STATUSES)
  enumValue(record.visibility, `${path}.visibility`, VISIBILITIES)
  enumValue(record.sourceType, `${path}.sourceType`, SOURCE_TYPES)
  unit(record.confidence, `${path}.confidence`)
  if (record.occurredAt !== undefined) dateTime(record.occurredAt, `${path}.occurredAt`)
  if (record.validFrom !== undefined) dateTime(record.validFrom, `${path}.validFrom`)
  if (record.validUntil !== undefined) dateTime(record.validUntil, `${path}.validUntil`)
  dateTime(record.createdAt, `${path}.createdAt`)
  dateTime(record.updatedAt, `${path}.updatedAt`)
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) fail(`${path}.updatedAt precedes createdAt`)
  if (record.validFrom !== undefined && record.validUntil !== undefined
    && Date.parse(record.validUntil) <= Date.parse(record.validFrom)) {
    fail(`${path}.validUntil must be after validFrom`)
  }
  integer(record.revision, `${path}.revision`, 1)
  const relations = object(record.relations, `${path}.relations`, [
    'supersedes', 'supersededBy', 'consolidates', 'sourceMemoryIds',
  ], ['chainId'])
  if (relations.chainId !== undefined) string(relations.chainId, `${path}.relations.chainId`)
  for (const field of ['supersedes', 'supersededBy', 'consolidates', 'sourceMemoryIds']) {
    stringArray(relations[field], `${path}.relations.${field}`)
    if (relations[field].includes(record.id)) fail(`${path}.relations.${field} cannot reference itself`)
  }
  if (record.status === 'deleted' && record.visibility === 'recallable') {
    fail(`${path} deleted record cannot be recallable`)
  }
  if (record.status === 'superseded' && record.visibility !== 'source_only') {
    fail(`${path} superseded record must be source_only`)
  }
  if (record.status !== 'deleted'
    && (record.layer === 'l2_fact' || record.layer === 'l3_summary' || record.layer === 'l4_identity')
    && record.sourceType !== 'explicit' && relations.sourceMemoryIds.length === 0) {
    fail(`${path} non-explicit derived record must have raw sourceMemoryIds`)
  }
  return record
}

function validateQuery(value, path) {
  const query = object(value, path, [
    'id', 'corpusId', 'language', 'bucket', 'owner', 'sessionId', 'sessionOnly', 'channel',
    'query', 'relevantIds', 'forbiddenIds', 'split',
  ])
  string(query.id, `${path}.id`)
  string(query.corpusId, `${path}.corpusId`)
  enumValue(query.language, `${path}.language`, LANGUAGES)
  enumValue(query.bucket, `${path}.bucket`, BUCKETS)
  owner(query.owner, `${path}.owner`)
  string(query.sessionId, `${path}.sessionId`)
  if (typeof query.sessionOnly !== 'boolean') fail(`${path}.sessionOnly must be a boolean`)
  enumValue(query.channel, `${path}.channel`, CHANNELS)
  string(query.query, `${path}.query`)
  stringArray(query.relevantIds, `${path}.relevantIds`)
  stringArray(query.forbiddenIds, `${path}.forbiddenIds`)
  enumValue(query.split, `${path}.split`, SPLITS)
  const forbidden = new Set(query.forbiddenIds)
  if (query.relevantIds.some(id => forbidden.has(id))) fail(`${path} relevantIds and forbiddenIds overlap`)
  return query
}

/** Strictly validate the checked-in v1 dataset shape and semantic relationships. */
export function validateDataset(value) {
  const dataset = object(value, 'dataset', [
    'schemaVersion', 'datasetId', 'datasetVersion', 'referenceCommit', 'evaluationTime', 'corpora', 'queries',
  ])
  if (dataset.schemaVersion !== 1) fail('dataset.schemaVersion must equal 1')
  if (dataset.datasetId !== 'dsh-memory-retrieval') fail('dataset.datasetId must equal dsh-memory-retrieval')
  if (dataset.datasetVersion !== '1.0.0') fail('dataset.datasetVersion must equal 1.0.0')
  if (dataset.referenceCommit !== 'dc000a4877538b193a51444e890fe552147ffa9f') {
    fail('dataset.referenceCommit must match the v1 reference commit')
  }
  dateTime(dataset.evaluationTime, 'dataset.evaluationTime')

  const corpusIds = new Set()
  const recordIds = new Set()
  const recordLocations = new Map()
  for (const [corpusIndex, corpusValue] of array(dataset.corpora, 'dataset.corpora', 1).entries()) {
    const path = `dataset.corpora[${corpusIndex}]`
    const corpus = object(corpusValue, path, ['id', 'records'])
    const corpusId = string(corpus.id, `${path}.id`)
    if (corpusIds.has(corpusId)) fail(`duplicate corpus id '${corpusId}'`)
    corpusIds.add(corpusId)
    for (const [recordIndex, recordValue] of array(corpus.records, `${path}.records`, 1).entries()) {
      const record = validateRecord(recordValue, `${path}.records[${recordIndex}]`)
      if (recordIds.has(record.id)) fail(`duplicate record id '${record.id}'`)
      recordIds.add(record.id)
      recordLocations.set(record.id, { corpusId, record })
    }
  }

  for (const { corpusId, record } of recordLocations.values()) {
    const relationFields = ['supersedes', 'supersededBy', 'consolidates', 'sourceMemoryIds']
    for (const field of relationFields) {
      for (const relatedId of record.relations[field]) {
        const related = recordLocations.get(relatedId)
        if (related === undefined || related.corpusId !== corpusId) {
          fail(`record '${record.id}' has ${field} reference missing from its corpus: '${relatedId}'`)
        }
        if (ownerKey(related.record.owner) !== ownerKey(record.owner)) {
          fail(`record relation '${record.id}' -> '${relatedId}' crosses owner`)
        }
        if (field === 'sourceMemoryIds' && related.record.layer !== 'l1_raw') {
          fail(`record '${record.id}' sourceMemoryIds must reference l1_raw records`)
        }
      }
    }
    for (const oldId of [...record.relations.supersedes, ...record.relations.consolidates]) {
      const old = recordLocations.get(oldId).record
      if (!old.relations.supersededBy.includes(record.id)) {
        fail(`evolution relation '${record.id}' -> '${oldId}' is not bidirectional; missing reverse edge`)
      }
      if (record.revision <= old.revision) fail(`evolution revision for '${record.id}' is not increasing`)
      if (record.relations.chainId === undefined || record.relations.chainId !== old.relations.chainId) {
        fail(`evolution relation '${record.id}' -> '${oldId}' must share a chainId`)
      }
      if (old.status !== 'superseded' || old.visibility !== 'source_only') {
        fail(`evolution target '${oldId}' must be superseded and source_only`)
      }
    }
    for (const newId of record.relations.supersededBy) {
      const newer = recordLocations.get(newId).record
      if (!newer.relations.supersedes.includes(record.id) && !newer.relations.consolidates.includes(record.id)) {
        fail(`evolution relation '${record.id}' -> '${newId}' is not bidirectional; missing reverse edge`)
      }
    }
  }

  const heads = new Set()
  for (const { record } of recordLocations.values()) {
    if (record.relations.chainId !== undefined && record.status === 'active' && record.visibility === 'recallable') {
      const key = `${ownerKey(record.owner)}\u0000${record.relations.chainId}`
      if (heads.has(key)) fail(`evolution chain '${record.relations.chainId}' has multiple active heads`)
      heads.add(key)
    }
  }

  const queryIds = new Set()
  const queries = array(dataset.queries, 'dataset.queries', 48).map((queryValue, queryIndex) => {
    const query = validateQuery(queryValue, `dataset.queries[${queryIndex}]`)
    if (queryIds.has(query.id)) fail(`duplicate query id '${query.id}'`)
    queryIds.add(query.id)
    if (!corpusIds.has(query.corpusId)) fail(`query '${query.id}' references unknown corpus '${query.corpusId}'`)
    for (const id of query.relevantIds) {
      const location = recordLocations.get(id)
      if (location === undefined || location.corpusId !== query.corpusId) {
        fail(`query '${query.id}' relevant ID is missing or unknown in its corpus: '${id}'`)
      }
      const record = location.record
      if (ownerKey(record.owner) !== ownerKey(query.owner)) fail(`query '${query.id}' relevant owner mismatch for '${id}'`)
      if (channelFor(record) !== query.channel) fail(`query '${query.id}' relevant channel mismatch for '${id}'`)
      if (record.status !== 'active' || record.visibility !== 'recallable') {
        fail(`query '${query.id}' relevant record '${id}' must be active and recallable`)
      }
      if (!activeAt(record, Date.parse(dataset.evaluationTime))) fail(`query '${query.id}' relevant record '${id}' is not valid`)
      if (query.sessionOnly && record.sourceSessionId !== query.sessionId) {
        fail(`query '${query.id}' relevant record '${id}' is outside its session`)
      }
    }
    for (const id of query.forbiddenIds) {
      const location = recordLocations.get(id)
      if (location === undefined || location.corpusId !== query.corpusId) {
        fail(`query '${query.id}' forbidden ID is missing or unknown in its corpus: '${id}'`)
      }
    }
    if (query.bucket === 'multi_topic' && query.relevantIds.length > 0 && query.relevantIds.length < 2) {
      fail(`query '${query.id}' multi_topic requires at least two relevant IDs`)
    }
    if (query.bucket === 'exact_id') {
      for (const id of query.relevantIds) {
        if (!query.query.includes(id)) fail(`query '${query.id}' exact_id text must contain '${id}'`)
        const record = recordLocations.get(id).record
        if (`${record.content}\n${record.tags.join(' ')}`.includes(id)) {
          fail(`query '${query.id}' exact_id answer is polluted into content or tags`)
        }
      }
    }
    return query
  })

  const scored = queries.filter(query => query.relevantIds.length > 0)
  const negative = queries.filter(query => query.relevantIds.length === 0)
  if (negative.length < 6) fail('dataset must include at least 6 negative queries')
  for (const bucket of BUCKETS) {
    for (const language of LANGUAGES) {
      const cell = scored.filter(query => query.bucket === bucket && query.language === language)
      if (cell.length < 3) fail(`bucket ${bucket}/${language} must contain at least 3 scored queries`)
      if (!cell.some(query => query.split === 'holdout')) fail(`bucket ${bucket}/${language} requires a holdout query`)
    }
  }
}

function round6(value) {
  return Number(value.toFixed(6))
}

/** Compute stable macro/micro Recall and MRR@10 while retaining hard failures. */
export function computeRetrievalMetrics(cases) {
  const results = []
  let scoredQueries = 0
  let excludedQueries = 0
  let relevantItems = 0
  let macro5 = 0
  let macro10 = 0
  let hits5 = 0
  let hits10 = 0
  let reciprocalRanks = 0
  let forbiddenHits = 0
  let duplicateResultIds = 0

  for (const ranking of cases) {
    const relevant = new Set(ranking.relevantIds)
    const forbidden = new Set(ranking.forbiddenIds)
    const uniqueReturned = []
    const seen = new Set()
    for (const id of ranking.returnedIds) {
      if (seen.has(id)) duplicateResultIds += 1
      else {
        seen.add(id)
        uniqueReturned.push(id)
      }
      if (forbidden.has(id)) forbiddenHits += 1
    }
    if (relevant.size === 0) {
      excludedQueries += 1
      results.push({
        id: ranking.id,
        firstRelevantRank: null,
        recallAt5: null,
        recallAt10: null,
        reciprocalRank: null,
      })
      continue
    }
    scoredQueries += 1
    relevantItems += relevant.size
    const top5Hits = uniqueReturned.slice(0, 5).filter(id => relevant.has(id)).length
    const top10 = uniqueReturned.slice(0, 10)
    const top10Hits = top10.filter(id => relevant.has(id)).length
    const firstIndex = top10.findIndex(id => relevant.has(id))
    const firstRelevantRank = firstIndex < 0 ? null : firstIndex + 1
    const recallAt5 = top5Hits / relevant.size
    const recallAt10 = top10Hits / relevant.size
    const reciprocalRank = firstRelevantRank === null ? 0 : 1 / firstRelevantRank
    macro5 += recallAt5
    macro10 += recallAt10
    hits5 += top5Hits
    hits10 += top10Hits
    reciprocalRanks += reciprocalRank
    results.push({
      id: ranking.id,
      firstRelevantRank,
      recallAt5: round6(recallAt5),
      recallAt10: round6(recallAt10),
      reciprocalRank: round6(reciprocalRank),
    })
  }

  return {
    counts: { scoredQueries, excludedQueries, relevantItems },
    recallAt5: {
      macro: round6(scoredQueries === 0 ? 0 : macro5 / scoredQueries),
      micro: round6(relevantItems === 0 ? 0 : hits5 / relevantItems),
    },
    recallAt10: {
      macro: round6(scoredQueries === 0 ? 0 : macro10 / scoredQueries),
      micro: round6(relevantItems === 0 ? 0 : hits10 / relevantItems),
    },
    mrrAt10: { cutoff: 10, value: round6(scoredQueries === 0 ? 0 : reciprocalRanks / scoredQueries) },
    cases: results,
    hardChecks: { forbiddenHits, duplicateResultIds },
  }
}

/** Honest placeholders for lifecycle metrics deferred to MEM-003B. */
export function createNotMeasuredMetrics() {
  const reason = 'requires MEM-003B lifecycle evaluation'
  return {
    conflictAccuracy: { status: 'not_measured', value: null, reason },
    duplicateCompressionRate: { status: 'not_measured', value: null, reason },
    degradationRate: { status: 'not_measured', value: null, reason },
  }
}

function recall(value, path) {
  const metric = object(value, path, ['macro', 'micro'])
  unit(metric.macro, `${path}.macro`)
  unit(metric.micro, `${path}.micro`)
}

function mrr(value, path) {
  const metric = object(value, path, ['cutoff', 'value'])
  if (metric.cutoff !== 10) fail(`${path}.cutoff must equal 10`)
  unit(metric.value, `${path}.value`)
}

function notMeasured(value, path) {
  const metric = object(value, path, ['status', 'value', 'reason'])
  if (metric.status !== 'not_measured') fail(`${path}.status must equal not_measured`)
  if (metric.value !== null) fail(`${path}.value must be null`)
  string(metric.reason, `${path}.reason`)
}

/** Strictly validate the stable v1 report shape without a runtime schema package. */
export function validateReport(value) {
  const report = object(value, 'report', [
    'schemaVersion', 'dataset', 'runner', 'embeddingSpace', 'counts', 'metrics', 'buckets', 'cases', 'hardChecks',
  ])
  if (report.schemaVersion !== 1) fail('report.schemaVersion must equal 1')
  const dataset = object(report.dataset, 'report.dataset', ['id', 'version', 'referenceCommit'])
  if (dataset.id !== 'dsh-memory-retrieval') fail('report.dataset.id must equal dsh-memory-retrieval')
  string(dataset.version, 'report.dataset.version')
  if (!/^[0-9a-f]{40}$/u.test(dataset.referenceCommit)) fail('report.dataset.referenceCommit must be a 40-character SHA')
  const runner = object(report.runner, 'report.runner', ['version', 'repeats'])
  integer(runner.version, 'report.runner.version', 1)
  integer(runner.repeats, 'report.runner.repeats', 1)
  const embedding = object(report.embeddingSpace, 'report.embeddingSpace', ['id', 'dimensions'])
  string(embedding.id, 'report.embeddingSpace.id')
  integer(embedding.dimensions, 'report.embeddingSpace.dimensions', 1)
  const counts = object(report.counts, 'report.counts', [
    'corpora', 'records', 'queries', 'relevantQueries', 'negativeQueries',
  ])
  integer(counts.corpora, 'report.counts.corpora', 1)
  integer(counts.records, 'report.counts.records', 1)
  integer(counts.queries, 'report.counts.queries', 1)
  integer(counts.relevantQueries, 'report.counts.relevantQueries', 1)
  integer(counts.negativeQueries, 'report.counts.negativeQueries', 0)
  const metrics = object(report.metrics, 'report.metrics', [
    'recallAt5', 'recallAt10', 'mrrAt10', 'conflictAccuracy', 'duplicateCompressionRate', 'degradationRate',
  ])
  recall(metrics.recallAt5, 'report.metrics.recallAt5')
  recall(metrics.recallAt10, 'report.metrics.recallAt10')
  mrr(metrics.mrrAt10, 'report.metrics.mrrAt10')
  notMeasured(metrics.conflictAccuracy, 'report.metrics.conflictAccuracy')
  notMeasured(metrics.duplicateCompressionRate, 'report.metrics.duplicateCompressionRate')
  notMeasured(metrics.degradationRate, 'report.metrics.degradationRate')

  for (const [index, value] of array(report.buckets, 'report.buckets').entries()) {
    const path = `report.buckets[${index}]`
    const bucket = object(value, path, [
      'bucket', 'language', 'queryCount', 'relevantQueryCount', 'negativeQueryCount', 'recallAt5', 'recallAt10', 'mrrAt10',
    ])
    enumValue(bucket.bucket, `${path}.bucket`, BUCKETS)
    enumValue(bucket.language, `${path}.language`, LANGUAGES)
    integer(bucket.queryCount, `${path}.queryCount`, 1)
    integer(bucket.relevantQueryCount, `${path}.relevantQueryCount`, 0)
    integer(bucket.negativeQueryCount, `${path}.negativeQueryCount`, 0)
    recall(bucket.recallAt5, `${path}.recallAt5`)
    recall(bucket.recallAt10, `${path}.recallAt10`)
    mrr(bucket.mrrAt10, `${path}.mrrAt10`)
  }

  for (const [index, value] of array(report.cases, 'report.cases').entries()) {
    const path = `report.cases[${index}]`
    const result = object(value, path, [
      'id', 'corpusId', 'language', 'bucket', 'split', 'channel', 'relevantIds', 'forbiddenIds', 'returnedIds',
      'firstRelevantRank', 'recallAt5', 'recallAt10', 'reciprocalRank', 'forbiddenHits',
    ])
    string(result.id, `${path}.id`)
    string(result.corpusId, `${path}.corpusId`)
    enumValue(result.language, `${path}.language`, LANGUAGES)
    enumValue(result.bucket, `${path}.bucket`, BUCKETS)
    enumValue(result.split, `${path}.split`, SPLITS)
    enumValue(result.channel, `${path}.channel`, CHANNELS)
    stringArray(result.relevantIds, `${path}.relevantIds`)
    stringArray(result.forbiddenIds, `${path}.forbiddenIds`)
    stringArray(result.returnedIds, `${path}.returnedIds`, false)
    if (result.firstRelevantRank !== null) integer(result.firstRelevantRank, `${path}.firstRelevantRank`, 1)
    if (result.firstRelevantRank !== null && result.firstRelevantRank > 10) fail(`${path}.firstRelevantRank must be <= 10`)
    for (const field of ['recallAt5', 'recallAt10', 'reciprocalRank']) {
      if (result[field] !== null) unit(result[field], `${path}.${field}`)
    }
    stringArray(result.forbiddenHits, `${path}.forbiddenHits`)
  }
  const hard = object(report.hardChecks, 'report.hardChecks', ['scopeLeaks', 'forbiddenHits', 'duplicateResultIds'])
  integer(hard.scopeLeaks, 'report.hardChecks.scopeLeaks', 0)
  integer(hard.forbiddenHits, 'report.hardChecks.forbiddenHits', 0)
  integer(hard.duplicateResultIds, 'report.hardChecks.duplicateResultIds', 0)
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

/** Serialize JSON with recursively sorted object keys and preserved array order. */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}
