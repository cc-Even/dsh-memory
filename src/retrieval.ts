/** Portable hybrid retrieval using hashed vectors, BM25, and RRF. */

import type { MemoryHit, MemoryRecord } from './types.ts'

/** Stable local embedding space. A version change requires rebuilding stored vectors. */
export const HASH_EMBEDDING_SPACE_ID = 'dsh-memory/hash-token-char-v1/256/l2'
/** Fixed dimensions of the portable hashed embedding. */
export const HASH_EMBEDDING_DIMENSIONS = 256

const TOKEN_PATTERN = /[a-zA-Z0-9]+|[\u3400-\u9fff]+/gu
const NAVIGATIONAL_PATTERNS = [
  /`[^`]+`|"[^"]{2,}"|'[^']{2,}'/u,
  /[/\\][\w.-]+[/\\]|https?:\/\/\S+/u,
  /\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[A-Za-z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/u,
  /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/u,
]
const CONCEPTUAL_TERMS = [
  'how', 'why', 'explain', 'approach', 'strategy', 'tend', 'overall', 'pattern',
  '怎么', '为什么', '如何', '倾向', '风格', '整体', '通常', '模式',
]

/**
 * Split mixed Chinese/Latin text into normalized retrieval tokens.
 * @param text - Source or query text.
 * @returns normalized retrieval tokens in source order.
 */
export function tokenize(text: string): string[] {
  return Array.from(text.matchAll(TOKEN_PATTERN), match => match[0].toLowerCase())
}

/**
 * Classify a query for retrieval-channel weighting.
 * @param query - Search query.
 * @returns the weighting intent selected by deterministic heuristics.
 */
export function classifyIntent(query: string): 'navigational' | 'factual' | 'conceptual' {
  if (NAVIGATIONAL_PATTERNS.some(pattern => pattern.test(query))) return 'navigational'
  const lower = query.toLowerCase()
  return CONCEPTUAL_TERMS.some(term => lower.includes(term)) ? 'conceptual' : 'factual'
}

/**
 * Create a deterministic, normalized token/character-feature vector without external IO.
 * @param text - Text to embed in the portable hash space.
 * @returns one L2-normalized fixed-width vector.
 */
export function hashEmbedding(text: string): number[] {
  const vector = Array<number>(HASH_EMBEDDING_DIMENSIONS).fill(0)
  const features: string[] = []
  for (const token of tokenize(text)) {
    features.push(`t:${token}`)
    const points = Array.from(token)
    for (let index = 0; index + 1 < points.length; index += 1) {
      features.push(`b:${points[index]}${points[index + 1]}`)
    }
  }
  for (const feature of features) {
    let hash = 2166136261
    for (const point of feature) {
      hash ^= point.codePointAt(0) ?? 0
      hash = Math.imul(hash, 16777619)
    }
    const unsigned = hash >>> 0
    const index = unsigned % HASH_EMBEDDING_DIMENSIONS
    vector[index] = (vector[index] ?? 0) + ((unsigned & 1) === 0 ? 1 : -1)
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  return norm === 0 ? vector : vector.map(value => value / norm)
}

/**
 * Cosine similarity for normalized or ordinary equal-length vectors.
 * @param left - First vector.
 * @param right - Second vector of the same dimensions.
 * @returns cosine similarity, or zero for empty, mismatched, or zero vectors.
 */
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}

/**
 * BM25 scores over one bounded candidate pool.
 * @param query - Pre-tokenized query.
 * @param documents - Candidate texts in result order.
 * @param k1 - Term-frequency saturation.
 * @param b - Document-length normalization.
 * @returns one score per candidate document.
 */
export function bm25(query: readonly string[], documents: readonly string[], k1: number, b: number): number[] {
  if (query.length === 0 || documents.length === 0) return documents.map(() => 0)
  const tokenized = documents.map(tokenize)
  const lengths = tokenized.map(tokens => tokens.length)
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1
  const terms = [...new Set(query.filter(Boolean))]
  const frequencies = tokenized.map((tokens) => {
    const counts = new Map<string, number>()
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    return counts
  })
  return tokenized.map((_, index) => {
    let score = 0
    for (const term of terms) {
      const frequency = frequencies[index]?.get(term) ?? 0
      if (frequency === 0) continue
      const documentFrequency = frequencies.filter(counts => counts.has(term)).length
      const inverse = Math.log((documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5) + 1)
      const denominator = frequency + k1 * (1 - b + b * (lengths[index] ?? 0) / averageLength)
      score += inverse * frequency * (k1 + 1) / denominator
    }
    return score
  })
}

interface RankedChannel {
  readonly name: 'semantic' | 'lexical'
  readonly weight: number
  readonly records: readonly { record: MemoryRecord; score: number }[]
}

/**
 * Fuse ranked channels with Reciprocal Rank Fusion.
 * @param channels - Named weighted rankings.
 * @param rrfK - Reciprocal-rank smoothing constant.
 * @param includeEvolution - Whether to attach related revisions.
 * @param allRecords - Scope records used to resolve evolution relations.
 * @returns fused hits in descending stable score order.
 */
export function fuse(
  channels: readonly RankedChannel[],
  rrfK: number,
  includeEvolution: boolean,
  allRecords: readonly MemoryRecord[],
): MemoryHit[] {
  const accumulated = new Map<string, { record: MemoryRecord; score: number; matchedBy: Set<'semantic' | 'lexical'> }>()
  for (const channel of channels) {
    channel.records.forEach((entry, index) => {
      const current = accumulated.get(entry.record.id) ?? {
        record: entry.record,
        score: 0,
        matchedBy: new Set<'semantic' | 'lexical'>(),
      }
      current.score += channel.weight / (rrfK + index + 1)
      current.matchedBy.add(channel.name)
      accumulated.set(entry.record.id, current)
    })
  }
  return [...accumulated.values()]
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .map((entry): MemoryHit => ({
      memory: entry.record,
      score: entry.score,
      matchedBy: [...entry.matchedBy],
      ...includeEvolution ? { evolution: evolutionFor(entry.record, allRecords) } : {},
    }))
}

function evolutionFor(
  record: MemoryRecord,
  records: readonly MemoryRecord[],
): Array<Pick<MemoryRecord, 'id' | 'content' | 'occurredAt' | 'revision'>> {
  const ids = new Set<string>([record.id, ...record.supersedes, ...record.supersededBy, ...record.consolidates])
  if (record.chainId !== undefined) {
    for (const candidate of records) if (candidate.chainId === record.chainId) ids.add(candidate.id)
  }
  return records
    .filter(candidate => ids.has(candidate.id))
    .sort((left, right) => right.revision - left.revision)
    .map(candidate => ({
      id: candidate.id,
      content: candidate.content,
      ...(candidate.occurredAt === undefined ? {} : { occurredAt: candidate.occurredAt }),
      revision: candidate.revision,
    }))
}
