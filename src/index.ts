/**
 * Durable memory service with raw-first writes, structured
 * extraction, atomic reconciliation, hybrid recall, and Harness turn hooks.
 *
 * @module @evyn/dsh-memory
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  EmbeddingProvider,
  HashEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from './embedding.ts'
import type { EmbeddingDescription } from './embedding.ts'
import { MemoryError } from './error.ts'
import { extractMemories, reconcileMemories } from './model.ts'
import type { ExtractedMemory, ExtractionResult, ReconcileOperation } from './model.ts'
import {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
  CjkBigramTokenizer,
  bm25,
  classifyIntent,
  cosine,
  fuse,
  hashEmbedding,
} from './retrieval.ts'
import type { LexicalTokenizer } from './retrieval.ts'
import { memoryDomainSpec } from './schema.ts'
import type { MemoryScopeKey, MemoryScopeState, StoredMemoryJob } from './schema.ts'
import { findMemoryStateViolation } from './state-invariant.ts'
import type {
  AddMemoryInput,
  ForgetReceipt,
  ListMemoryInput,
  MemoryCapability,
  MemoryHealthReport,
  MemoryHit,
  MemoryId,
  MemoryJobId,
  MemoryLayer,
  MemoryRecord,
  MemoryScope,
  SearchMemoryInput,
  SearchResult,
  WriteReceipt,
} from './types.ts'

export { MemoryError } from './error.ts'
export type { MemoryErrorCode } from './error.ts'
export {
  EmbeddingProvider,
  HashEmbeddingProvider,
  OpenAICompatibleEmbeddingProvider,
} from './embedding.ts'
export type {
  EmbeddingDescription,
  OpenAICompatibleEmbeddingOptions,
} from './embedding.ts'
export type * from './types.ts'
export {
  HASH_EMBEDDING_DIMENSIONS,
  HASH_EMBEDDING_SPACE_ID,
  CjkBigramTokenizer,
  bm25,
  classifyIntent,
  cosine,
  fuse,
  hashEmbedding,
  tokenize,
} from './retrieval.ts'
export type { LexicalTokenizer } from './retrieval.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Loader-selectable embedding implementation. Secrets are referenced by environment-variable name. */
export type EmbeddingConfig =
  | { readonly kind: 'hash' }
  | {
    readonly kind: 'openai-compatible'
    readonly baseUrl: string
    readonly apiKeyEnv: string
    readonly model: string
    readonly spaceId: string
    readonly dimensions: number
    readonly batchSize?: number
    readonly timeoutMs?: number
    readonly maxRetries?: number
    readonly retryBaseDelayMs?: number
  }

/** Loader-selectable BM25 tokenization policy. */
export type TokenizerConfig =
  | { readonly kind: 'cjk-bigram' }
  | { readonly kind: 'legacy' }

/** Deployment configuration for extraction, hybrid recall, and automatic turn integration. */
export interface Config {
  /** LLM provider route used for extraction and reconciliation. */
  provider: string
  /** Model id used for extraction and reconciliation. */
  model: string
  /** Harness-user override; omitted derives the stable anonymous harness-home id. */
  userId?: string
  /** Optional deployment tenant namespace. */
  tenantId?: string
  /** Capture completed turns through structured memory extraction. */
  autoCapture?: boolean
  /** Inject recalled memories before a step containing direct user input. */
  autoRecall?: boolean
  /** Maximum output tokens for each extraction or reconciliation call. */
  maxModelTokens?: number
  /** Maximum accepted raw input characters. */
  maxInputChars?: number
  /** Maximum characters retained in one derived memory. */
  maxRecordChars?: number
  /** Normal-channel result count. */
  recallLimit?: number
  /** Independently reserved profile-channel result count. */
  profileLimit?: number
  /** Maximum characters injected into one recalled-context message. */
  maxContextChars?: number
  /** Candidate count presented to reconciliation. */
  reconcileCandidateLimit?: number
  /** Minimum hashed-vector cosine admitted to semantic ranking without a lexical hit. */
  minSemanticScore?: number
  /** RRF smoothing constant. */
  rrfK?: number
  /** BM25 term-frequency saturation. */
  bm25K1?: number
  /** BM25 document-length normalization. */
  bm25B?: number
  /** L0 keys the extractor may update. */
  profileFields?: string[]
  /** Programmatic embedding provider; mutually exclusive with `embedding`. */
  embeddingProvider?: EmbeddingProvider
  /** Loader-safe embedding configuration. The default is the portable hash provider. */
  embedding?: EmbeddingConfig
  /** Trusted programmatic lexical tokenizer; mutually exclusive with `tokenizer`. */
  lexicalTokenizer?: LexicalTokenizer
  /** Loader-safe lexical tokenizer selection. */
  tokenizer?: TokenizerConfig
}

type ResolvedEmbeddingConfig = EmbeddingConfig | {
  readonly kind: 'programmatic'
  readonly spaceId: string
  readonly dimensions: number
  readonly maxBatchSize: number
  readonly normalization: 'l2'
  readonly quality: 'portable-hash' | 'trained'
}

type ResolvedTokenizerConfig = TokenizerConfig | { readonly kind: 'programmatic' }

/** Fully materialized, secret-free service policy. */
export interface ResolvedConfig {
  readonly provider: string
  readonly model: string
  readonly userId: string
  readonly tenantId?: string
  readonly autoCapture: boolean
  readonly autoRecall: boolean
  readonly maxModelTokens: number
  readonly maxInputChars: number
  readonly maxRecordChars: number
  readonly recallLimit: number
  readonly profileLimit: number
  readonly maxContextChars: number
  readonly reconcileCandidateLimit: number
  readonly minSemanticScore: number
  readonly rrfK: number
  readonly bm25K1: number
  readonly bm25B: number
  readonly profileFields: readonly string[]
  readonly embedding: ResolvedEmbeddingConfig
  readonly tokenizer: ResolvedTokenizerConfig
}

const DEFAULT_PROFILE_FIELDS = ['name', 'age', 'location', 'timezone', 'language', 'occupation']
const PROFILE_LAYERS = new Set<MemoryLayer>(['l0_basic_info', 'l4_identity'])
const WRITABLE_LAYERS = new Set<MemoryLayer>([
  'l0_basic_info', 'l1_raw', 'l2_fact', 'l3_summary', 'l4_identity',
])

/** Schemastery loader validation for memory configuration. */
export const Config: s<Config> = s.object({
  provider: s.string().required(),
  model: s.string().required(),
  userId: s.string(),
  tenantId: s.string(),
  autoCapture: s.boolean().default(true),
  autoRecall: s.boolean().default(true),
  maxModelTokens: s.number().step(1).min(256).default(4096),
  maxInputChars: s.number().step(1).min(1).default(50000),
  maxRecordChars: s.number().step(1).min(1).default(4000),
  recallLimit: s.number().step(1).min(1).default(8),
  profileLimit: s.number().step(1).min(0).default(4),
  maxContextChars: s.number().step(1).min(1).default(6000),
  reconcileCandidateLimit: s.number().step(1).min(1).default(12),
  minSemanticScore: s.number().min(-1).max(1).default(0.08),
  rrfK: s.number().step(1).min(1).default(60),
  bm25K1: s.number().min(0).default(1.5),
  bm25B: s.number().min(0).max(1).default(0.75),
  profileFields: s.array(s.string()).default(DEFAULT_PROFILE_FIELDS),
  embeddingProvider: s.any<EmbeddingProvider>().hidden(),
  embedding: s.union([
    s.object({ kind: s.const('hash').required() }),
    s.object({
      kind: s.const('openai-compatible').required(),
      baseUrl: s.string().required(),
      apiKeyEnv: s.string().required(),
      model: s.string().required(),
      spaceId: s.string().required(),
      dimensions: s.number().step(1).min(1).required(),
      batchSize: s.number().step(1).min(1),
      timeoutMs: s.number().step(1).min(1),
      maxRetries: s.number().step(1).min(0),
      retryBaseDelayMs: s.number().step(1).min(1),
    }),
  ]),
  lexicalTokenizer: s.any<LexicalTokenizer>().hidden(),
  tokenizer: s.union([
    s.object({ kind: s.const('cjk-bigram').required() }),
    s.object({ kind: s.const('legacy').required() }),
  ]),
})

/**
 * Materialize defaults and reject direct construction with invalid configuration.
 * @param config - Loader or programmatic memory configuration.
 * @returns a validated configuration with every default materialized.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.embeddingProvider !== undefined && config.embedding !== undefined) {
    throw new MemoryError('INVALID_INPUT', 'embeddingProvider and embedding config are mutually exclusive')
  }
  if (config.lexicalTokenizer !== undefined && config.tokenizer !== undefined) {
    throw new MemoryError('INVALID_INPUT', 'lexicalTokenizer and tokenizer config are mutually exclusive')
  }
  const provider = requireNonEmpty(config.provider, 'provider')
  const model = requireNonEmpty(config.model, 'model')
  const userId = config.userId === undefined
    ? getOrCreateAnonymousUserId()
    : requireNonEmpty(config.userId, 'userId')
  const embedding = config.embeddingProvider === undefined
    ? normalizeEmbeddingConfig(config.embedding)
    : programmaticEmbeddingConfig(describeEmbeddingProvider(config.embeddingProvider))
  const tokenizer = config.lexicalTokenizer === undefined
    ? normalizeTokenizerConfig(config.tokenizer)
    : programmaticTokenizerConfig(config.lexicalTokenizer)
  const resolved: ResolvedConfig = {
    provider,
    model,
    userId,
    ...(config.tenantId === undefined ? {} : { tenantId: requireNonEmpty(config.tenantId, 'tenantId') }),
    autoCapture: config.autoCapture ?? true,
    autoRecall: config.autoRecall ?? true,
    maxModelTokens: positiveInteger(config.maxModelTokens ?? 4096, 'maxModelTokens'),
    maxInputChars: positiveInteger(config.maxInputChars ?? 50000, 'maxInputChars'),
    maxRecordChars: positiveInteger(config.maxRecordChars ?? 4000, 'maxRecordChars'),
    recallLimit: positiveInteger(config.recallLimit ?? 8, 'recallLimit'),
    profileLimit: nonNegativeInteger(config.profileLimit ?? 4, 'profileLimit'),
    maxContextChars: positiveInteger(config.maxContextChars ?? 6000, 'maxContextChars'),
    reconcileCandidateLimit: positiveInteger(config.reconcileCandidateLimit ?? 12, 'reconcileCandidateLimit'),
    minSemanticScore: bounded(config.minSemanticScore ?? 0.08, -1, 1, 'minSemanticScore'),
    rrfK: positiveInteger(config.rrfK ?? 60, 'rrfK'),
    bm25K1: bounded(config.bm25K1 ?? 1.5, 0, Number.MAX_VALUE, 'bm25K1'),
    bm25B: bounded(config.bm25B ?? 0.75, 0, 1, 'bm25B'),
    profileFields: normalizeTags(config.profileFields ?? DEFAULT_PROFILE_FIELDS),
    embedding,
    tokenizer,
  }
  return resolved
}

function normalizeTokenizerConfig(value: TokenizerConfig | undefined): TokenizerConfig {
  if (value === undefined) return { kind: 'cjk-bigram' }
  if (value === null || typeof value !== 'object') {
    throw new MemoryError('INVALID_INPUT', 'tokenizer config must be an object')
  }
  if (value.kind !== 'cjk-bigram' && value.kind !== 'legacy') {
    throw new MemoryError('INVALID_INPUT', 'tokenizer kind is invalid')
  }
  assertAllowedKeys(value, ['kind'], 'tokenizer')
  return { kind: value.kind }
}

function programmaticTokenizerConfig(tokenizer: LexicalTokenizer): ResolvedTokenizerConfig {
  if (tokenizer === null || typeof tokenizer !== 'object') {
    throw new MemoryError('INVALID_INPUT', 'lexicalTokenizer must provide tokenize(text)')
  }
  let method: unknown
  try {
    method = tokenizer.tokenize
  } catch {
    throw tokenizationFailure()
  }
  if (typeof method !== 'function') {
    throw new MemoryError('INVALID_INPUT', 'lexicalTokenizer must provide tokenize(text)')
  }
  const tokens = safeTokenizerCall(tokenizer, '')
  if (tokens.length !== 0) throw tokenizationFailure()
  return { kind: 'programmatic' }
}

const LEGACY_TOKEN_PATTERN = /[a-zA-Z0-9]+|[\u3400-\u9fff]+/gu
const MAX_TOKEN_COUNT = 100_000
const MAX_TOKEN_CHARS = 256

class LegacyLexicalTokenizer implements LexicalTokenizer {
  tokenize(text: string): string[] {
    return Array.from(text.matchAll(LEGACY_TOKEN_PATTERN), match => match[0].toLowerCase())
  }
}

class ValidatingLexicalTokenizer implements LexicalTokenizer {
  constructor(private readonly implementation: LexicalTokenizer) {}

  tokenize(text: string): string[] {
    return safeTokenizerCall(this.implementation, text)
  }
}

function tokenizerFromConfig(
  programmatic: LexicalTokenizer | undefined,
  config: ResolvedTokenizerConfig,
): LexicalTokenizer {
  if (programmatic !== undefined) return new ValidatingLexicalTokenizer(programmatic)
  if (config.kind === 'legacy') return new LegacyLexicalTokenizer()
  if (config.kind === 'cjk-bigram') return new CjkBigramTokenizer()
  throw new MemoryError('INVALID_INPUT', 'programmatic lexicalTokenizer is missing')
}

function safeTokenizerCall(tokenizer: LexicalTokenizer, text: string): string[] {
  try {
    const method = tokenizer.tokenize
    if (typeof method !== 'function') throw tokenizationFailure()
    const value = method.call(tokenizer, text)
    if (!Array.isArray(value)) throw tokenizationFailure()
    const length = value.length
    if (length > MAX_TOKEN_COUNT) throw tokenizationFailure()
    const copy: string[] = []
    for (const token of value) {
      if (copy.length >= MAX_TOKEN_COUNT
        || typeof token !== 'string'
        || token.length === 0
        || token.length > MAX_TOKEN_CHARS) throw tokenizationFailure()
      copy.push(token)
    }
    return copy
  } catch {
    throw tokenizationFailure()
  }
}

function tokenizationFailure(): MemoryError {
  return new MemoryError('TOKENIZATION_FAILED', 'lexical tokenizer failed')
}

function isTokenizationFailure(error: unknown): error is MemoryError {
  return error instanceof MemoryError && error.code === 'TOKENIZATION_FAILED'
}

function modelRoute(config: ResolvedConfig): { provider: string; model: string; maxTokens: number } {
  return { provider: config.provider, model: config.model, maxTokens: config.maxModelTokens }
}

function normalizeEmbeddingConfig(value: EmbeddingConfig | undefined): EmbeddingConfig {
  if (value === undefined) return { kind: 'hash' }
  if (value === null || typeof value !== 'object') {
    throw new MemoryError('INVALID_INPUT', 'embedding config must be an object')
  }
  const input = value as EmbeddingConfig & { readonly apiKey?: unknown }
  if (input.kind === 'hash') {
    assertAllowedKeys(input, ['kind'], 'embedding')
    return { kind: 'hash' }
  }
  if (input.kind !== 'openai-compatible') {
    throw new MemoryError('INVALID_INPUT', 'embedding kind is invalid')
  }
  if ('apiKey' in input) {
    throw new MemoryError('INVALID_INPUT', 'embedding config must use apiKeyEnv instead of a literal apiKey')
  }
  assertAllowedKeys(input, [
    'kind', 'baseUrl', 'apiKeyEnv', 'model', 'spaceId', 'dimensions', 'batchSize', 'timeoutMs',
    'maxRetries', 'retryBaseDelayMs',
  ], 'embedding')
  const baseUrl = requireHttpUrl(input.baseUrl, 'embedding.baseUrl')
  const apiKeyEnv = requireNonEmpty(input.apiKeyEnv, 'embedding.apiKeyEnv')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
    throw new MemoryError('INVALID_INPUT', 'embedding.apiKeyEnv must be an environment variable name')
  }
  return {
    kind: 'openai-compatible',
    baseUrl,
    apiKeyEnv,
    model: requireNonEmpty(input.model, 'embedding.model'),
    spaceId: requireNonEmpty(input.spaceId, 'embedding.spaceId'),
    dimensions: boundedInteger(input.dimensions, 1, 65_536, 'embedding.dimensions'),
    batchSize: boundedInteger(input.batchSize ?? 128, 1, 2_048, 'embedding.batchSize'),
    timeoutMs: boundedInteger(input.timeoutMs ?? 30_000, 1, 300_000, 'embedding.timeoutMs'),
    maxRetries: boundedInteger(input.maxRetries ?? 2, 0, 10, 'embedding.maxRetries'),
    retryBaseDelayMs: boundedInteger(input.retryBaseDelayMs ?? 100, 1, 60_000, 'embedding.retryBaseDelayMs'),
  }
}

function programmaticEmbeddingConfig(description: EmbeddingDescription): ResolvedEmbeddingConfig {
  return { kind: 'programmatic', ...description }
}

function assertAllowedKeys(value: object, allowed: readonly string[], field: string): void {
  const accepted = new Set(allowed)
  const unexpected = Object.keys(value).find(key => !accepted.has(key))
  if (unexpected !== undefined) throw new MemoryError('INVALID_INPUT', `${field} has invalid property '${unexpected}'`)
}

function providerFromConfig(config: ResolvedEmbeddingConfig): EmbeddingProvider {
  if (config.kind === 'hash') return new HashEmbeddingProvider()
  if (config.kind === 'programmatic') {
    throw new MemoryError('EMBEDDING_FAILED', 'programmatic embedding provider is missing')
  }
  const apiKey = process.env[config.apiKeyEnv]
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new MemoryError('INVALID_INPUT', `embedding API key environment variable '${config.apiKeyEnv}' is missing`)
  }
  return new OpenAICompatibleEmbeddingProvider({
    baseUrl: config.baseUrl,
    apiKey,
    model: config.model,
    spaceId: config.spaceId,
    dimensions: config.dimensions,
    ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
    ...(config.retryBaseDelayMs === undefined ? {} : { retryBaseDelayMs: config.retryBaseDelayMs }),
  })
}

function describeEmbeddingProvider(provider: EmbeddingProvider): EmbeddingDescription {
  try {
    return validateEmbeddingDescription(provider.describe())
  } catch {
    throw new MemoryError('EMBEDDING_FAILED', 'embedding provider descriptor is invalid')
  }
}

function validateEmbeddingDescription(value: EmbeddingDescription): EmbeddingDescription {
  if (value === null || typeof value !== 'object'
    || typeof value.spaceId !== 'string' || value.spaceId.trim().length === 0
    || !Number.isSafeInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 65_536
    || !Number.isSafeInteger(value.maxBatchSize) || value.maxBatchSize < 1
    || value.normalization !== 'l2'
    || (value.quality !== 'portable-hash' && value.quality !== 'trained')) {
    throw new MemoryError('EMBEDDING_FAILED', 'embedding provider descriptor is invalid')
  }
  return {
    spaceId: value.spaceId.trim(),
    dimensions: value.dimensions,
    maxBatchSize: value.maxBatchSize,
    normalization: 'l2',
    quality: value.quality,
  }
}

/** Durable memory service mounted at `ctx.memory`. */
export class MemoryService extends Service implements MemoryCapability {
  static inject = ['agents', 'llm', 'storageDomain']
  static Config = Config

  /** Validated immutable policy used by writes, retrieval, and turn hooks. */
  readonly config: ResolvedConfig

  private readonly embeddingProvider: EmbeddingProvider
  private readonly embeddingDescription: EmbeddingDescription
  private readonly portableHashImplementation: boolean
  private readonly lexicalTokenizer: LexicalTokenizer
  private table?: KvTable<MemoryScopeKey, MemoryScopeState>
  private readonly operationTails = new Map<MemoryScopeKey, Promise<void>>()
  private admissionOpen = true

  /**
   * @param ctx - Harness context carrying agents, LLM, and durable domain storage.
   * @param config - Extraction, scope, recall, and limit policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'memory')
    this.config = resolveConfig(config)
    this.embeddingProvider = config.embeddingProvider ?? providerFromConfig(this.config.embedding)
    this.embeddingDescription = describeEmbeddingProvider(this.embeddingProvider)
    this.portableHashImplementation = this.embeddingProvider instanceof HashEmbeddingProvider
      && this.embeddingDescription.quality === 'portable-hash'
      && this.embeddingDescription.spaceId === HASH_EMBEDDING_SPACE_ID
      && this.embeddingDescription.dimensions === HASH_EMBEDDING_DIMENSIONS
    this.lexicalTokenizer = tokenizerFromConfig(config.lexicalTokenizer, this.config.tokenizer)
  }

  /** Open durable state, recover interrupted jobs, and install optional turn hooks. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(memoryDomainSpec)
    this.table = domain.table('scopes')
    this.validateStoredEmbeddingSpaces()
    await this.recoverAcceptedJobs()
    this.installHooks()
    this.ctx.effect(() => async () => {
      this.admissionOpen = false
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'memory.domainClose')
  }

  /**
   * Derive the tenant/user/agent/session scope used by Harness consumers.
   * The preset is the cross-session agent identity; a missing preset maps to
   * `default`, while the live Session id remains provenance.
   * @param agent - Agent owning the operation.
   * @returns the resolved memory scope.
   */
  scopeFor(agent: Agent): MemoryScope {
    return {
      ...(this.config.tenantId === undefined ? {} : { tenantId: this.config.tenantId }),
      userId: this.config.userId,
      agentId: agent.session.header.agentPreset ?? 'default',
      sessionId: agent.session.id,
    }
  }

  /**
   * Persist L1 before any model call, then atomically commit direct or
   * extracted L0/L2/L3/L4 records. Model failure returns `degraded` with the
   * recallable L1 intact; storage failure rejects.
   * @param input - Content, scope, mode, and provenance.
   * @param signal - Cancellation for model work; committed raw input remains durable.
   * @returns the final durable write receipt.
   */
  add(input: AddMemoryInput, signal?: AbortSignal): Promise<WriteReceipt> {
    const resolved = this.resolveAdd(input)
    const key = scopeKey(resolved.scope)
    return this.enqueue(key, async () => {
      throwIfAborted(signal)
      const current = this.readState(key)
      const prior = current.jobs.find(job => job.idempotencyKey === resolved.idempotencyKey)
      if (prior !== undefined) return receiptOf(prior)

      const now = new Date().toISOString()
      const raw = this.record({
        scope: resolved.scope,
        layer: 'l1_raw',
        content: resolved.content,
        visibility: 'recallable',
        sourceType: 'explicit',
        confidence: 1,
        ...(resolved.occurredAt === undefined ? {} : { occurredAt: resolved.occurredAt }),
        idempotencyKey: resolved.idempotencyKey,
        sourceTurnIndexes: resolved.sourceTurnIndexes,
        now,
      })
      const job: StoredMemoryJob = {
        idempotencyKey: resolved.idempotencyKey,
        requestId: randomUUID(),
        jobId: `memory-job-${randomUUID()}` as MemoryJobId,
        rawMemoryId: raw.id,
        status: 'accepted',
        createdMemoryIds: [],
        warnings: [],
      }
      const accepted: MemoryScopeState = {
        revision: current.revision + 1,
        records: [...current.records, raw],
        jobs: [...current.jobs, job],
      }
      let completionAttempted = false
      try {
        await this.writeState(key, current, accepted)
      } catch (error) {
        throw new MemoryError('RAW_PERSIST_FAILED', 'memory raw record could not be persisted', { cause: error })
      }

      try {
        if (resolved.mode === 'direct') {
          const directContent = resolved.content.slice(0, this.config.maxRecordChars).trim()
          const derived = this.record({
            scope: resolved.scope,
            layer: resolved.layer,
            content: directContent,
            visibility: 'recallable',
            sourceType: 'explicit',
            confidence: 1,
            ...(resolved.occurredAt === undefined ? {} : { occurredAt: resolved.occurredAt }),
            sourceMemoryIds: [raw.id],
            sourceTurnIndexes: resolved.sourceTurnIndexes,
            tags: resolved.tags,
            now,
          })
          const records = accepted.records.map(record => record.id === raw.id
            ? { ...record, visibility: 'source_only' as const, updatedAt: now }
            : record)
          const embedded = await this.embedSelectedRecords([...records, derived], [raw.id, derived.id], signal)
          completionAttempted = true
          return await this.commitSuccess(key, accepted, job, raw.id, embedded)
        }

        throwIfAborted(signal)
        const extraction = await extractMemories(
          this.ctx,
          modelRoute(this.config),
          resolved.content,
          existingTags(accepted.records),
          this.config.profileFields,
          signal,
        )
        const extracted = this.sanitizeExtraction(extraction)
        const candidates = await this.reconcileCandidates(accepted.records, extracted, signal)
        const operations = extracted.length === 0
          ? []
          : await reconcileMemories(this.ctx, modelRoute(this.config), extracted, candidates, signal)
        const records = this.applyExtraction(accepted.records, raw, extraction, extracted, candidates, operations, now)
        const acceptedIds = new Set(accepted.records.map(record => record.id))
        const embeddingIds = [raw.id, ...records.filter(record => !acceptedIds.has(record.id)).map(record => record.id)]
        const embedded = await this.embedSelectedRecords(records, embeddingIds, signal)
        completionAttempted = true
        return await this.commitSuccess(key, accepted, job, raw.id, embedded)
      } catch (error) {
        if (completionAttempted) throw error
        const callerAborted = signal?.aborted === true
        const warning = callerAborted
          ? 'memory enrichment aborted'
          : error instanceof Error ? error.message : String(error)
        const degradedJob: StoredMemoryJob = { ...job, status: 'degraded', warnings: [warning] }
        const degraded: MemoryScopeState = {
          revision: accepted.revision + 1,
          records: accepted.records,
          jobs: replaceJob(accepted.jobs, degradedJob),
        }
        await this.writeState(key, accepted, degraded)
        if (callerAborted) throw signal.reason ?? error
        return receiptOf(degradedJob)
      }
    })
  }

  /**
   * Search one pre-filtered scope with portable hashed vectors, BM25, and RRF.
   * Profile and normal channels have independent quotas.
   * @param input - Query, scope, filters, and result bounds.
   * @param signal - Cancellation checked before CPU work.
   * @returns ranked profile and normal channels.
   */
  async search(input: SearchMemoryInput, signal?: AbortSignal): Promise<SearchResult> {
    throwIfAborted(signal)
    const scope = resolveScope(input.scope)
    const query = requireNonEmpty(input.query, 'query')
    if (query.length > this.config.maxInputChars) {
      throw new MemoryError('INVALID_INPUT', `query exceeds maxInputChars (${this.config.maxInputChars})`)
    }
    const limit = input.limit === undefined ? this.config.recallLimit : positiveInteger(input.limit, 'limit')
    const profileLimit = input.profileLimit === undefined
      ? this.config.profileLimit
      : nonNegativeInteger(input.profileLimit, 'profileLimit')
    const state = this.readState(scopeKey(scope))
    const layers = input.layers === undefined ? undefined : new Set(input.layers)
    const candidates = state.records.filter(record =>
      record.status === 'active'
      && record.visibility === 'recallable'
      && (layers === undefined || layers.has(record.layer))
      && (!input.sessionOnly || record.scope.sessionId === scope.sessionId)
      && validAt(record, new Date().toISOString()))
    const intent = classifyIntent(query)
    let queryVector: readonly number[] | undefined
    let semanticUnavailable = false
    if (candidates.length > 0) {
      try {
        queryVector = this.portableHashImplementation
          ? hashEmbedding(query)
          : requiredArrayValue(await this.embedTexts([query], signal), 0, 'query embedding')
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        semanticUnavailable = true
      }
    }
    const profileCandidates = candidates.filter(record => PROFILE_LAYERS.has(record.layer))
    const normalCandidates = candidates.filter(record => !PROFILE_LAYERS.has(record.layer))
    let profileRanked: MemoryHit[]
    let normalRanked: MemoryHit[]
    let lexicalUnavailable = false
    try {
      profileRanked = this.rank(query, queryVector, intent, profileCandidates, input.includeEvolution ?? false, state.records, true)
      normalRanked = this.rank(query, queryVector, intent, normalCandidates, input.includeEvolution ?? false, state.records, true)
    } catch (error) {
      if (!isTokenizationFailure(error)) throw error
      lexicalUnavailable = true
      profileRanked = this.rank(query, queryVector, intent, profileCandidates, input.includeEvolution ?? false, state.records, false)
      normalRanked = this.rank(query, queryVector, intent, normalCandidates, input.includeEvolution ?? false, state.records, false)
    }
    const profile = profileRanked
      .slice(0, profileLimit)
      .map(hit => ({ ...hit, matchedBy: [...hit.matchedBy, 'profile' as const] }))
    const normal = normalRanked
      .slice(0, limit)
    const scores = [...profile, ...normal].slice(0, 3).map(hit => hit.score)
    const scoreAverage = scores.reduce((sum, score) => sum + score, 0) / scores.length
    const confidence = scores.length === 0 ? 0 : Math.min(1, scoreAverage * this.config.rrfK)
    return {
      requestId: randomUUID(),
      channels: { profile, normal },
      diagnostics: {
        intent,
        confidence,
        degradedChannels: [
          ...(lexicalUnavailable ? ['lexical:tokenizer-unavailable'] : []),
          ...(semanticUnavailable ? ['semantic:provider-unavailable'] : []),
          ...(this.embeddingDescription.quality === 'portable-hash' ? ['semantic:portable-hash'] : []),
          'tag:unavailable',
        ],
      },
    }
  }

  /**
   * Read one record from its owning scope.
   * @param memoryId - Exact record identity.
   * @param scope - Owning tenant/user/agent scope.
   * @returns the record, or `undefined` when absent or outside the scope.
   */
  get(memoryId: MemoryId, scope: MemoryScope): MemoryRecord | undefined {
    return this.readState(scopeKey(resolveScope(scope))).records.find(record => record.id === memoryId)
  }

  /**
   * List records newest first after scope, layer, status, and optional Session filtering.
   * @param input - Filters and result bound.
   * @returns a detached result array.
   */
  list(input: ListMemoryInput): readonly MemoryRecord[] {
    const scope = resolveScope(input.scope)
    const layers = input.layers === undefined ? undefined : new Set(input.layers)
    const statuses = input.statuses === undefined ? undefined : new Set(input.statuses)
    const limit = input.limit === undefined ? this.config.recallLimit : positiveInteger(input.limit, 'limit')
    return this.readState(scopeKey(scope)).records
      .filter(record =>
        (layers === undefined || layers.has(record.layer))
        && (statuses === undefined || statuses.has(record.status))
        && (!input.sessionOnly || record.scope.sessionId === scope.sessionId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
  }

  /**
   * Soft-delete one record and cascade only relations whose evidence becomes empty.
   * @param memoryId - Exact record identity.
   * @param scope - Owning tenant/user/agent scope.
   * @returns deletion outcome and every changed record id.
   */
  forget(memoryId: MemoryId, scope: MemoryScope): Promise<ForgetReceipt> {
    const resolved = resolveScope(scope)
    const key = scopeKey(resolved)
    return this.enqueue(key, async () => {
      const current = this.readState(key)
      const target = current.records.find(record => record.id === memoryId)
      if (target === undefined || target.status === 'deleted') {
        return { forgotten: false, memoryId, affectedMemoryIds: [] }
      }
      const now = new Date().toISOString()
      const affected = new Set<MemoryId>([memoryId])
      const records = current.records.map((record): MemoryRecord => {
        if (record.id === memoryId) return { ...record, status: 'deleted', visibility: 'source_only', updatedAt: now }
        if (!record.sourceMemoryIds.includes(memoryId)) return record
        const sourceMemoryIds = record.sourceMemoryIds.filter(id => id !== memoryId)
        affected.add(record.id)
        return sourceMemoryIds.length === 0
          ? { ...record, sourceMemoryIds, status: 'deleted', visibility: 'source_only', updatedAt: now }
          : { ...record, sourceMemoryIds, updatedAt: now }
      })
      const next = { ...current, revision: current.revision + 1, records }
      validateState(next, this.embeddingDescription)
      await this.writeState(key, current, next)
      return { forgotten: true, memoryId, affectedMemoryIds: [...affected] }
    })
  }

  /**
   * Export one scope without changing durable state. Vectors remain present so
   * imports can verify the embedding space explicitly.
   * @param scope - Owning tenant/user/agent scope.
   * @returns detached portable records.
   */
  export(scope: MemoryScope): readonly MemoryRecord[] {
    return structuredClone(this.readState(scopeKey(resolveScope(scope))).records)
  }

  /**
   * Import validated L0-L4 records into one exact scope. Existing ids are
   * idempotent when byte-equivalent and reject when they conflict.
   * @param scope - Target tenant/user/agent scope.
   * @param records - Portable records using the current embedding space.
   * @returns number of newly inserted records.
   */
  import(scope: MemoryScope, records: readonly MemoryRecord[]): Promise<number> {
    const resolved = resolveScope(scope)
    const key = scopeKey(resolved)
    return this.enqueue(key, async () => {
      const current = this.readState(key)
      const byId = new Map(current.records.map(record => [record.id, record]))
      let inserted = 0
      for (const record of records) {
        assertRecordImport(record, resolved, this.embeddingDescription)
        const existing = byId.get(record.id)
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new MemoryError('INVALID_INPUT', `import conflicts with existing memory '${record.id}'`)
          }
          continue
        }
        byId.set(record.id, structuredClone(record))
        inserted += 1
      }
      if (inserted === 0) return 0
      const next = { ...current, revision: current.revision + 1, records: [...byId.values()] }
      validateState(next, this.embeddingDescription)
      await this.writeState(key, current, next)
      return inserted
    })
  }

  /**
   * Current reference-store readiness, record count, and negotiated capabilities.
   * @returns a synchronous health snapshot for the open reference store.
   */
  health(): MemoryHealthReport {
    const table = this.requireTable()
    let records = 0
    for (const [, state] of table.entries()) records += state.records.length
    return {
      ready: true,
      records,
      scopes: table.size,
      embeddingSpaceId: this.embeddingDescription.spaceId,
      capabilities: {
        transactions: true,
        semanticSearch: true,
        lexicalSearch: true,
        preFilter: true,
        durableJobs: true,
      },
    }
  }

  private installHooks(): void {
    if (this.config.autoRecall) {
      this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const decision = await next()
        if (decision.kind === 'reject' || signal.aborted) return decision
        const direct = decision.messages.filter(message => message.source.kind === 'user')
        const query = direct.map(messageText).filter(Boolean).join('\n')
        if (query.length === 0) return decision
        const result = await this.search({ scope: this.scopeFor(agent), query }, signal)
        const context = recallContext(result, this.config.maxContextChars)
        if (context.length === 0) return decision
        return {
          kind: 'enter',
          messages: [
            createUserMessage({
              source: { kind: 'plugin', plugin: 'dsh-memory', form: 'recall' },
              content: [{ type: 'text', text: context }],
            }),
            ...decision.messages,
          ],
        }
      })
    }
    if (this.config.autoCapture) {
      this.ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
        const messages = messagesForTurn(agent.session.events, turn)
        if (!messages.some(message => message.role === 'user' && message.source.kind === 'user')) return
        const content = JSON.stringify(messages.map((message, index) => ({
          turnIndex: index,
          role: message.role,
          content: messageText(message),
        })))
        try {
          await this.add({
            scope: this.scopeFor(agent),
            content,
            mode: 'extract',
            idempotencyKey: `${agent.session.id}:turn:${turn}`,
            sourceTurnIndexes: [turn],
          }, signal)
        } catch (error) {
          this.ctx.logger.warn(`memory capture failed for session '${agent.session.id}' turn ${turn}: ${String(error)}`)
        }
      })
    }
  }

  private resolveAdd(input: AddMemoryInput): Required<Pick<AddMemoryInput, 'scope' | 'content' | 'mode' | 'layer' | 'tags' | 'idempotencyKey' | 'sourceTurnIndexes'>> & Pick<AddMemoryInput, 'occurredAt'> {
    const scope = resolveScope(input.scope)
    const content = requireNonEmpty(input.content, 'content')
    if (content.length > this.config.maxInputChars) {
      throw new MemoryError('INVALID_INPUT', `content exceeds maxInputChars (${this.config.maxInputChars})`)
    }
    if (input.occurredAt !== undefined) assertIso(input.occurredAt, 'occurredAt')
    const mode = input.mode ?? 'direct'
    const layer = input.layer ?? 'l2_fact'
    return {
      scope,
      content,
      mode,
      layer,
      tags: normalizeTags(input.tags ?? []),
      idempotencyKey: input.idempotencyKey === undefined ? randomUUID() : requireNonEmpty(input.idempotencyKey, 'idempotencyKey'),
      sourceTurnIndexes: [...new Set(input.sourceTurnIndexes ?? [])].map(index => nonNegativeInteger(index, 'sourceTurnIndexes')),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
    }
  }

  private sanitizeExtraction(extraction: ExtractionResult): ExtractedMemory[] {
    const refs = new Set<string>()
    const sanitized: ExtractedMemory[] = []
    for (const item of [...extraction.facts, ...extraction.identities]) {
      if (refs.has(item.clientRef)) throw new MemoryError('EXTRACTION_FAILED', `duplicate extraction clientRef '${item.clientRef}'`)
      refs.add(item.clientRef)
      sanitized.push({
        ...item,
        content: item.content.slice(0, this.config.maxRecordChars).trim(),
        tags: normalizeTags(item.tags),
        evidenceTurnIndexes: [...new Set(item.evidenceTurnIndexes)],
      })
    }
    return sanitized.filter(item => item.content.length > 0)
  }

  private async reconcileCandidates(
    records: readonly MemoryRecord[],
    extracted: readonly ExtractedMemory[],
    signal?: AbortSignal,
  ): Promise<MemoryRecord[]> {
    const query = extracted.map(item => item.content).join('\n')
    if (query.length === 0) return []
    const candidates = records.filter(record => record.status === 'active'
      && record.visibility === 'recallable'
      && (record.layer === 'l2_fact' || record.layer === 'l4_identity'))
    if (candidates.length === 0) return []
    let queryVector: readonly number[] | undefined
    let semanticUnavailable = false
    try {
      queryVector = this.portableHashImplementation
        ? hashEmbedding(query)
        : requiredArrayValue(await this.embedTexts([query], signal), 0, 'reconcile query embedding')
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error
      semanticUnavailable = true
    }
    let ranked: MemoryHit[]
    try {
      ranked = this.rank(
        query,
        queryVector,
        classifyIntent(query),
        candidates,
        false,
        records,
        true,
      )
    } catch (error) {
      if (!isTokenizationFailure(error)) throw error
      const semanticUsable = !semanticUnavailable
        && queryVector !== undefined
        && hasNonZeroVector(queryVector)
        && candidates.some(record => hasNonZeroVector(record.embedding.vector))
      if (!semanticUsable) throw tokenizationFailure()
      ranked = this.rank(
        query,
        queryVector,
        classifyIntent(query),
        candidates,
        false,
        records,
        false,
      )
    }
    return ranked.slice(0, this.config.reconcileCandidateLimit).map(hit => hit.memory)
  }

  private applyExtraction(
    existing: readonly MemoryRecord[],
    raw: MemoryRecord,
    extraction: ExtractionResult,
    extracted: readonly ExtractedMemory[],
    candidates: readonly MemoryRecord[],
    operations: readonly ReconcileOperation[],
    now: string,
  ): MemoryRecord[] {
    validatePlan(extracted, candidates, operations)
    const records = [...existing]
    const created: MemoryRecord[] = []
    const byRef = new Map(extracted.map(item => [item.clientRef, item]))
    for (const operation of operations) {
      if (operation.type === 'NOOP') {
        const source = requiredMapValue(byRef, operation.sourceRef, 'extracted source')
        const index = records.findIndex(record => record.id === operation.duplicateOf)
        const target = requiredArrayValue(records, index, 'duplicate target')
        records[index] = {
          ...target,
          confidence: Math.max(target.confidence, source.confidence),
          sourceMemoryIds: [...new Set([...target.sourceMemoryIds, raw.id])],
          sourceTurnIndexes: [...new Set([...target.sourceTurnIndexes, ...source.evidenceTurnIndexes])],
          tags: normalizeTags([...target.tags, ...source.tags]),
          updatedAt: now,
        }
        continue
      }
      const sources = operation.type === 'CONSOLIDATE'
        ? operation.sourceRefs.map(ref => requiredMapValue(byRef, ref, 'extracted source'))
        : [requiredMapValue(byRef, operation.sourceRef, 'extracted source')]
      const source = requiredArrayValue(sources, 0, 'extracted source')
      const targetIds = operation.type === 'ADD' ? [] : operation.targetIds as MemoryId[]
      const targets = targetIds.map((id) => {
        const target = records.find(record => record.id === id)
        if (target === undefined) throw new MemoryError('RECONCILE_FAILED', `missing reconcile target '${id}'`)
        return target
      })
      const revision = targets.length === 0 ? 1 : Math.max(...targets.map(target => target.revision)) + 1
      const chainId = targets.find(target => target.chainId !== undefined)?.chainId ?? (targets.length === 0 ? undefined : randomUUID())
      const content = operation.type === 'ADD' ? source.content : operation.content.slice(0, this.config.maxRecordChars).trim()
      const createdRecord = this.record({
        scope: raw.scope,
        layer: source.layer,
        content,
        visibility: 'recallable',
        sourceType: operation.type === 'ADD' ? (source.speculate === undefined ? 'explicit' : 'inferred') : 'composite',
        confidence: Math.max(...sources.map(item => item.confidence)),
        ...(source.occurredAt === undefined ? {} : { occurredAt: source.occurredAt }),
        ...(chainId === undefined ? {} : { chainId }),
        revision,
        supersedes: operation.type === 'SUPERSEDE' ? targetIds : [],
        consolidates: operation.type === 'CONSOLIDATE' ? targetIds : [],
        sourceMemoryIds: [...new Set([raw.id, ...targets.flatMap(target => target.sourceMemoryIds)])],
        sourceTurnIndexes: [...new Set(sources.flatMap(item => item.evidenceTurnIndexes))],
        tags: normalizeTags(sources.flatMap(item => item.tags)),
        meta: sources.length === 1
          ? (source.speculate === undefined ? {} : { speculate: source.speculate })
          : { speculations: Object.fromEntries(sources
            .filter(item => item.speculate !== undefined)
            .flatMap(item => item.speculate === undefined ? [] : [[item.clientRef, item.speculate]])) },
        now,
      })
      for (const targetId of targetIds) {
        const index = records.findIndex(record => record.id === targetId)
        const target = requiredArrayValue(records, index, 'reconcile target')
        const updatedChainId = target.chainId ?? chainId
        const updatedTarget: MemoryRecord = {
          ...target,
          status: 'superseded',
          visibility: 'source_only',
          supersededBy: [...new Set([...target.supersededBy, createdRecord.id])],
          updatedAt: now,
        }
        records[index] = updatedChainId === undefined
          ? updatedTarget
          : { ...updatedTarget, chainId: updatedChainId }
      }
      created.push(createdRecord)
    }
    if (extraction.summary !== undefined) {
      const content = extraction.summary.slice(0, this.config.maxRecordChars).trim()
      if (content.length > 0) created.push(this.record({
        scope: raw.scope,
        layer: 'l3_summary',
        content,
        visibility: 'recallable',
        sourceType: 'composite',
        confidence: 0.8,
        sourceMemoryIds: [raw.id],
        sourceTurnIndexes: raw.sourceTurnIndexes,
        now,
      }))
    }
    const profile = this.profileRecord(records, raw, extraction.basicProfilePatch, now)
    if (profile !== undefined) {
      const prior = records.findIndex(record => record.layer === 'l0_basic_info' && record.status === 'active')
      if (prior >= 0) {
        const previous = requiredArrayValue(records, prior, 'active profile')
        records[prior] = {
          ...previous,
          status: 'superseded',
          visibility: 'source_only',
          supersededBy: [profile.id],
          updatedAt: now,
        }
      }
      created.push(profile)
    }
    if (created.length > 0 || operations.some(operation => operation.type === 'NOOP')) {
      const rawIndex = records.findIndex(record => record.id === raw.id)
      const rawRecord = requiredArrayValue(records, rawIndex, 'raw source')
      records[rawIndex] = { ...rawRecord, visibility: 'source_only', updatedAt: now }
    }
    return [...records, ...created]
  }

  private profileRecord(
    records: readonly MemoryRecord[],
    raw: MemoryRecord,
    patch: Readonly<Record<string, JsonValue>>,
    now: string,
  ): MemoryRecord | undefined {
    const allowed = new Set(this.config.profileFields)
    const accepted = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key))) as Record<string, JsonValue>
    if (Object.keys(accepted).length === 0) return undefined
    const prior = records.find(record => record.layer === 'l0_basic_info' && record.status === 'active')
    const previous = prior?.meta['profile']
    const previousFields = previous !== null && typeof previous === 'object' && !Array.isArray(previous)
      ? previous as Record<string, JsonValue>
      : {}
    const profile = { ...previousFields, ...accepted }
    return this.record({
      scope: raw.scope,
      layer: 'l0_basic_info',
      content: Object.entries(profile).map(([key, value]) => `${key}: ${profileValueText(value)}`).join('\n'),
      visibility: 'recallable',
      sourceType: 'composite',
      confidence: 0.9,
      chainId: prior?.chainId ?? randomUUID(),
      revision: (prior?.revision ?? 0) + 1,
      supersedes: prior === undefined ? [] : [prior.id],
      sourceMemoryIds: [...new Set([...(prior?.sourceMemoryIds ?? []), raw.id])],
      sourceTurnIndexes: raw.sourceTurnIndexes,
      meta: { profile },
      now,
    })
  }

  private rank(
    query: string,
    queryVector: readonly number[] | undefined,
    intent: ReturnType<typeof classifyIntent>,
    records: readonly MemoryRecord[],
    includeEvolution: boolean,
    allRecords: readonly MemoryRecord[],
    lexicalEnabled: boolean,
  ): MemoryHit[] {
    if (records.length === 0) return []
    const semantic = queryVector === undefined
      ? []
      : records
        .filter(record => hasNonZeroVector(record.embedding.vector))
        .map(record => ({ record, score: cosine(queryVector, record.embedding.vector) }))
        .filter(entry => entry.score >= this.config.minSemanticScore)
        .sort((left, right) => right.score - left.score)
    const lexical = lexicalEnabled
      ? (() => {
        const lexicalScores = bm25(
          this.lexicalTokenizer.tokenize(query),
          records.map(record => `${record.content}\n${record.tags.map(tag => tag.trim().toLowerCase()).join(' ')}`),
          this.config.bm25K1,
          this.config.bm25B,
          this.lexicalTokenizer,
        )
        return records.map((record, index) => ({ record, score: lexicalScores[index] ?? 0 }))
          .filter(entry => entry.score > 0)
          .sort((left, right) => right.score - left.score)
      })()
      : []
    const weights = intent === 'navigational'
      ? { semantic: 0.4, lexical: 1.4 }
      : intent === 'conceptual'
        ? { semantic: 1.1, lexical: 0.5 }
        : { semantic: 1, lexical: 0.8 }
    return fuse([
      { name: 'semantic', weight: weights.semantic, records: semantic },
      { name: 'lexical', weight: weights.lexical, records: lexical },
    ], this.config.rrfK, includeEvolution, allRecords)
  }

  private record(input: {
    readonly scope: MemoryScope
    readonly layer: MemoryLayer
    readonly content: string
    readonly visibility: MemoryRecord['visibility']
    readonly sourceType: MemoryRecord['sourceType']
    readonly confidence: number
    readonly occurredAt?: string
    readonly chainId?: string
    readonly revision?: number
    readonly supersedes?: readonly MemoryId[]
    readonly consolidates?: readonly MemoryId[]
    readonly sourceMemoryIds?: readonly MemoryId[]
    readonly sourceTurnIndexes?: readonly number[]
    readonly idempotencyKey?: string
    readonly tags?: readonly string[]
    readonly meta?: Readonly<Record<string, JsonValue>>
    readonly now: string
  }): MemoryRecord {
    const content = input.content.trim()
    if (content.length === 0) throw new MemoryError('INVALID_INPUT', 'memory content must not be blank')
    return {
      schemaVersion: 1,
      id: `memory-${randomUUID()}` as MemoryId,
      scope: input.scope,
      layer: input.layer,
      content,
      status: 'active',
      visibility: input.visibility,
      sourceType: input.sourceType,
      confidence: bounded(input.confidence, 0, 1, 'confidence'),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      validFrom: input.now,
      createdAt: input.now,
      updatedAt: input.now,
      ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
      revision: input.revision ?? 1,
      supersedes: [...input.supersedes ?? []],
      supersededBy: [],
      consolidates: [...input.consolidates ?? []],
      sourceMemoryIds: [...input.sourceMemoryIds ?? []],
      ...(input.scope.sessionId === undefined ? {} : { sourceSessionId: input.scope.sessionId }),
      sourceTurnIndexes: [...input.sourceTurnIndexes ?? []],
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      tags: normalizeTags(input.tags ?? []),
      meta: input.meta ?? {},
      embedding: {
        spaceId: this.embeddingDescription.spaceId,
        dimensions: this.embeddingDescription.dimensions,
        vector: this.portableHashImplementation
          ? hashEmbedding(content)
          : Array<number>(this.embeddingDescription.dimensions).fill(0),
      },
    }
  }

  private async embedSelectedRecords(
    records: readonly MemoryRecord[],
    ids: readonly MemoryId[],
    signal?: AbortSignal,
  ): Promise<readonly MemoryRecord[]> {
    if (this.portableHashImplementation || ids.length === 0) return records
    const selected = ids.map(id => {
      const record = records.find(candidate => candidate.id === id)
      if (record === undefined) throw new MemoryError('EMBEDDING_FAILED', 'embedding target record is missing')
      return record
    })
    const vectors = await this.embedTexts(selected.map(record => record.content), signal)
    const byId = new Map(selected.map((record, index) => [record.id, requiredArrayValue(vectors, index, 'record embedding')]))
    return records.map((record): MemoryRecord => {
      const vector = byId.get(record.id)
      return vector === undefined ? record : {
        ...record,
        embedding: {
          spaceId: this.embeddingDescription.spaceId,
          dimensions: this.embeddingDescription.dimensions,
          vector,
        },
      }
    })
  }

  private async embedTexts(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []
    const vectors: number[][] = []
    for (let offset = 0; offset < texts.length; offset += this.embeddingDescription.maxBatchSize) {
      throwIfAborted(signal)
      const batch = texts.slice(offset, offset + this.embeddingDescription.maxBatchSize)
      let result: readonly (readonly number[])[]
      try {
        result = await this.embeddingProvider.embedBatch(batch, signal)
        throwIfAborted(signal)
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        throw new MemoryError('EMBEDDING_FAILED', 'embedding provider failed')
      }
      if (!Array.isArray(result) || result.length !== batch.length) {
        throw new MemoryError('EMBEDDING_FAILED', 'embedding provider returned an invalid result count')
      }
      for (const vector of result) {
        if (!Array.isArray(vector) || vector.length !== this.embeddingDescription.dimensions
          || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new MemoryError('EMBEDDING_FAILED', 'embedding provider returned an invalid vector')
        }
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
        if (!Number.isFinite(norm) || norm === 0) {
          throw new MemoryError('EMBEDDING_FAILED', 'embedding provider returned a zero vector')
        }
        vectors.push(vector.map(value => value / norm))
      }
    }
    return vectors
  }

  private async commitSuccess(
    key: MemoryScopeKey,
    current: MemoryScopeState,
    job: StoredMemoryJob,
    rawId: MemoryId,
    records: readonly MemoryRecord[],
  ): Promise<WriteReceipt> {
    const createdMemoryIds = records.filter(record => !current.records.some(existing => existing.id === record.id)).map(record => record.id)
    const completedJob: StoredMemoryJob = { ...job, status: 'completed', createdMemoryIds }
    const next: MemoryScopeState = {
      revision: current.revision + 1,
      records: [...records],
      jobs: replaceJob(current.jobs, completedJob),
    }
    const raw = next.records.find(record => record.id === rawId)
    if (raw === undefined) throw new MemoryError('CONCURRENT_MODIFICATION', 'raw memory disappeared before enrichment commit')
    validateState(next, this.embeddingDescription)
    await this.writeState(key, current, next)
    return receiptOf(completedJob)
  }

  private readState(key: MemoryScopeKey): MemoryScopeState {
    return this.requireTable().get(key) ?? { revision: 0, records: [], jobs: [] }
  }

  private async writeState(key: MemoryScopeKey, expected: MemoryScopeState, next: MemoryScopeState): Promise<void> {
    const table = this.requireTable()
    const live = table.get(key)
    if ((live?.revision ?? 0) !== expected.revision) {
      throw new MemoryError('CONCURRENT_MODIFICATION', `memory scope revision changed from ${expected.revision}`)
    }
    validateState(next, this.embeddingDescription)
    if (live === undefined) await table.put(key, next)
    else await table.update(key, (current) => {
      if (current.revision !== expected.revision) {
        throw new MemoryError('CONCURRENT_MODIFICATION', `memory scope revision changed from ${expected.revision}`)
      }
      return next
    })
  }

  private enqueue<T>(key: MemoryScopeKey, operation: () => Promise<T>): Promise<T> {
    if (!this.admissionOpen) return Promise.reject(new MemoryError('STORE_UNAVAILABLE', 'memory service is closing'))
    const previous = this.operationTails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => {}, () => {})
    this.operationTails.set(key, tail)
    void tail.finally(() => {
      if (this.operationTails.get(key) === tail) this.operationTails.delete(key)
    })
    return result
  }

  private async recoverAcceptedJobs(): Promise<void> {
    const table = this.requireTable()
    for (const [key, state] of table.entries()) {
      if (!state.jobs.some(job => job.status === 'accepted')) continue
      const jobs = state.jobs.map((job): StoredMemoryJob => job.status === 'accepted'
        ? { ...job, status: 'degraded', warnings: [...job.warnings, 'process restarted before enrichment completed'] }
        : job)
      await table.update(key, current => ({ ...current, revision: current.revision + 1, jobs }))
    }
  }

  private validateStoredEmbeddingSpaces(): void {
    for (const [, state] of this.requireTable().entries()) validateState(state, this.embeddingDescription)
  }

  private requireTable(): KvTable<MemoryScopeKey, MemoryScopeState> {
    if (this.table === undefined) throw new MemoryError('STORE_UNAVAILABLE', 'memory service is not initialized')
    return this.table
  }
}

function validatePlan(
  extracted: readonly ExtractedMemory[],
  candidates: readonly MemoryRecord[],
  operations: readonly ReconcileOperation[],
): void {
  const refs = new Map(extracted.map(item => [item.clientRef, item]))
  const ids = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const covered = new Set<string>()
  for (const operation of operations) {
    const sourceRefs = operation.type === 'CONSOLIDATE' ? operation.sourceRefs : [operation.sourceRef]
    for (const ref of sourceRefs) {
      if (!refs.has(ref) || covered.has(ref)) throw new MemoryError('RECONCILE_FAILED', `invalid or repeated sourceRef '${ref}'`)
      covered.add(ref)
    }
    if (operation.type === 'ADD') continue
    const targetIds = operation.type === 'NOOP' ? [operation.duplicateOf] : operation.targetIds
    for (const targetId of targetIds) {
      const target = ids.get(targetId as MemoryId)
      if (target === undefined) throw new MemoryError('RECONCILE_FAILED', `unknown reconcile target '${targetId}'`)
      if (sourceRefs.some(ref => requiredMapValue(refs, ref, 'extracted source').layer !== target.layer)) {
        throw new MemoryError('RECONCILE_FAILED', `reconcile target '${targetId}' crosses memory layers`)
      }
    }
  }
  if (covered.size !== refs.size) throw new MemoryError('RECONCILE_FAILED', 'reconcile plan did not cover every extracted memory')
}

function validateState(state: MemoryScopeState, description: EmbeddingDescription): void {
  const violation = findMemoryStateViolation(state.records)
  if (violation !== undefined) throw new MemoryError('CONCURRENT_MODIFICATION', violation)

  for (const record of state.records) {
    if (!WRITABLE_LAYERS.has(record.layer)) throw new MemoryError('INVALID_INPUT', `reserved memory layer '${record.layer}' cannot be stored by this provider`)
    if (record.embedding.spaceId !== description.spaceId
      || record.embedding.dimensions !== description.dimensions
      || record.embedding.vector.length !== description.dimensions) {
      throw new MemoryError('EMBEDDING_SPACE_MISMATCH', `memory '${record.id}' uses embedding space '${record.embedding.spaceId}'`)
    }
    if (description.quality === 'trained'
      && !hasNonZeroVector(record.embedding.vector)
      && !state.jobs.some(job => job.rawMemoryId === record.id
        && record.layer === 'l1_raw'
        && (job.status === 'accepted' || job.status === 'degraded'))) {
      throw new MemoryError(
        'EMBEDDING_SPACE_MISMATCH',
        `memory '${record.id}' has no valid trained embedding or durable placeholder job`,
      )
    }
  }
}

function messagesForTurn(events: readonly SessionEvent[], turn: number): Message[] {
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return []
  const messages: Message[] = []
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/end' && event.data.turn === turn) break
    const message = deriveEventMessage(event)
    if (message !== null && message.source.kind !== 'tool'
      && !(message.source.kind === 'plugin' && message.source.plugin === 'dsh-memory')) messages.push(message)
  }
  return messages
}

function recallContext(result: SearchResult, maxChars: number): string {
  const hits = [...result.channels.profile, ...result.channels.normal]
  if (hits.length === 0) return ''
  const lines = ['<memory-recall>', 'Use these records as fallible background. Prefer the current user message when they conflict.']
  for (const hit of hits) {
    const line = `- [${hit.memory.id}] (${hit.memory.layer}, confidence ${hit.memory.confidence.toFixed(2)}) ${hit.memory.content}`
    if ([...lines, line, '</memory-recall>'].join('\n').length > maxChars) break
    lines.push(line)
  }
  lines.push('</memory-recall>')
  return lines.length === 3 ? '' : lines.join('\n')
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function validAt(record: MemoryRecord, now: string): boolean {
  return (record.validFrom === undefined || record.validFrom <= now)
    && (record.validUntil === undefined || record.validUntil > now)
}

function receiptOf(job: StoredMemoryJob): WriteReceipt {
  return {
    requestId: job.requestId,
    jobId: job.jobId,
    rawMemoryId: job.rawMemoryId,
    status: job.status === 'completed' ? 'completed' : 'degraded',
    createdMemoryIds: job.createdMemoryIds,
    warnings: job.warnings,
  }
}

function replaceJob(jobs: readonly StoredMemoryJob[], replacement: StoredMemoryJob): StoredMemoryJob[] {
  return jobs.map(job => job.jobId === replacement.jobId ? replacement : job)
}

function existingTags(records: readonly MemoryRecord[]): string[] {
  return [...new Set(records.flatMap(record => record.tags))].sort()
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 32)
}

function scopeKey(scope: MemoryScope): MemoryScopeKey {
  return JSON.stringify([scope.tenantId ?? '', scope.userId, scope.agentId]) as MemoryScopeKey
}

function resolveScope(value: unknown): MemoryScope {
  if (value === null || typeof value !== 'object') throw new MemoryError('SCOPE_REQUIRED', 'memory scope is required')
  const scope = value as Partial<MemoryScope>
  return {
    ...(scope.tenantId === undefined ? {} : { tenantId: requireNonEmpty(scope.tenantId, 'scope.tenantId') }),
    userId: requireNonEmpty(scope.userId, 'scope.userId'),
    agentId: requireNonEmpty(scope.agentId, 'scope.agentId'),
    ...(scope.sessionId === undefined ? {} : { sessionId: requireNonEmpty(scope.sessionId, 'scope.sessionId') }),
  }
}

function sameOwner(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId && left.agentId === right.agentId
}

function assertRecordImport(
  record: MemoryRecord,
  scope: MemoryScope,
  description: EmbeddingDescription,
): void {
  if (!sameOwner(record.scope, scope)) {
    throw new MemoryError('INVALID_INPUT', `imported memory '${record.id}' does not belong to the target scope`)
  }
  if (!WRITABLE_LAYERS.has(record.layer)) throw new MemoryError('INVALID_INPUT', `reserved memory layer '${record.layer}' cannot be imported`)
  if (record.embedding.spaceId !== description.spaceId
    || record.embedding.dimensions !== description.dimensions
    || record.embedding.vector.length !== description.dimensions) {
    throw new MemoryError('EMBEDDING_SPACE_MISMATCH', `imported memory '${record.id}' requires re-embedding`)
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new MemoryError('INVALID_INPUT', `${field} must be a non-empty string`)
  return value.trim()
}

function requireHttpUrl(value: unknown, field: string): string {
  const text = requireNonEmpty(value, field).replace(/\/+$/u, '')
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
  } catch {
    throw new MemoryError('INVALID_INPUT', `${field} must be an absolute HTTP(S) URL`)
  }
  return text
}

function requiredMapValue<K, V>(map: ReadonlyMap<K, V>, key: K, description: string): V {
  const value = map.get(key)
  if (value === undefined) throw new MemoryError('RECONCILE_FAILED', `missing ${description}`)
  return value
}

function requiredArrayValue<T>(values: readonly T[], index: number, description: string): T {
  const value = values[index]
  if (value === undefined) throw new MemoryError('RECONCILE_FAILED', `missing ${description}`)
  return value
}

function profileValueText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new MemoryError('INVALID_INPUT', `${field} must be a positive safe integer`)
  return value
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new MemoryError('INVALID_INPUT', `${field} must be a non-negative safe integer`)
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new MemoryError('INVALID_INPUT', `${field} must be an integer from ${minimum} through ${maximum}`)
  }
  return value as number
}

function bounded(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new MemoryError('INVALID_INPUT', `${field} must be from ${minimum} through ${maximum}`)
  }
  return value
}

function assertIso(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value)) || !value.endsWith('Z')) throw new MemoryError('INVALID_INPUT', `${field} must be an ISO 8601 UTC timestamp`)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('memory operation aborted')
}

function hasNonZeroVector(vector: readonly number[]): boolean {
  return vector.some(value => value !== 0)
}

// Service packages default-export their service class and no function-plugin namespace.
export default MemoryService
