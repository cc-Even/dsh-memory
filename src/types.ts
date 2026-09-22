/**
 * Public data types for the durable memory capability.
 *
 * @module @evyn/dsh-memory/types
 */

import type { MemoryDiagnostics, ReviseMemoryInput } from './diagnostics.ts'
export type * from './diagnostics.ts'

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Stable identity of one memory record. */
export type MemoryId = Branded<'MemoryId'>

/** Stable identity of one accepted memory write. */
export type MemoryJobId = Branded<'MemoryJobId'>

/** Memory layers; L5-L7 remain reserved for portable imports and future providers. */
export type MemoryLayer =
  | 'l0_basic_info'
  | 'l1_raw'
  | 'l2_fact'
  | 'l3_summary'
  | 'l4_identity'
  | 'l5_knowledge'
  | 'l6_schema'
  | 'l7_intention'

/** Scope that owns a memory. Session is provenance unless a read requests session-only filtering. */
export interface MemoryScope {
  readonly tenantId?: string
  readonly userId: string
  readonly agentId: string
  readonly sessionId?: string
}

/** Versioned local embedding carried by the portable reference store. */
export interface MemoryEmbedding {
  readonly spaceId: string
  readonly dimensions: number
  readonly vector: readonly number[]
}

/** One durable memory record. */
export interface MemoryRecord {
  readonly schemaVersion: 1
  readonly id: MemoryId
  readonly scope: MemoryScope
  readonly layer: MemoryLayer
  readonly content: string
  readonly status: 'active' | 'superseded' | 'archived' | 'deleted'
  readonly visibility: 'recallable' | 'source_only'
  readonly sourceType: 'explicit' | 'inferred' | 'composite'
  readonly confidence: number
  readonly occurredAt?: string
  readonly validFrom?: string
  readonly validUntil?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly chainId?: string
  readonly revision: number
  readonly supersedes: readonly MemoryId[]
  readonly supersededBy: readonly MemoryId[]
  readonly consolidates: readonly MemoryId[]
  readonly sourceMemoryIds: readonly MemoryId[]
  readonly sourceSessionId?: string
  readonly sourceTurnIndexes: readonly number[]
  readonly idempotencyKey?: string
  readonly tags: readonly string[]
  readonly meta: Readonly<Record<string, JsonValue>>
  readonly embedding: MemoryEmbedding
}

/** Caller-selected direct derived layer. */
export type DirectMemoryLayer = 'l2_fact' | 'l4_identity'

/** One explicit or model-extracted write. */
export interface AddMemoryInput {
  readonly scope: MemoryScope
  readonly content: string
  readonly mode?: 'direct' | 'extract'
  readonly layer?: DirectMemoryLayer
  readonly tags?: readonly string[]
  readonly idempotencyKey?: string
  readonly occurredAt?: string
  readonly sourceTurnIndexes?: readonly number[]
}

/** Durable outcome of one accepted write. */
export interface WriteReceipt {
  readonly requestId: string
  readonly jobId: MemoryJobId
  readonly rawMemoryId: MemoryId
  readonly status: 'completed' | 'degraded'
  readonly createdMemoryIds: readonly MemoryId[]
  readonly warnings: readonly string[]
}

/** Search filters and result bounds. */
export interface SearchMemoryInput {
  readonly scope: MemoryScope
  readonly query: string
  readonly limit?: number
  readonly profileLimit?: number
  readonly layers?: readonly MemoryLayer[]
  readonly sessionOnly?: boolean
  readonly includeEvolution?: boolean
}

/** One ranked memory with retrieval provenance. */
export interface MemoryHit {
  readonly memory: MemoryRecord
  readonly score: number
  readonly matchedBy: readonly ('semantic' | 'lexical' | 'profile')[]
  readonly evolution?: readonly Pick<MemoryRecord, 'id' | 'content' | 'occurredAt' | 'revision'>[]
}

/** Profile and normal recall channels remain independently budgeted. */
export interface SearchResult {
  readonly requestId: string
  readonly channels: {
    readonly profile: readonly MemoryHit[]
    readonly normal: readonly MemoryHit[]
  }
  readonly diagnostics: {
    readonly intent: 'navigational' | 'factual' | 'conceptual'
    readonly confidence: number
    readonly degradedChannels: readonly string[]
  }
}

/** Filters for deterministic memory listing. */
export interface ListMemoryInput {
  readonly scope: MemoryScope
  readonly layers?: readonly MemoryLayer[]
  readonly statuses?: readonly MemoryRecord['status'][]
  readonly sessionOnly?: boolean
  readonly limit?: number
}

/** Result of one explicit soft deletion. */
export interface ForgetReceipt {
  readonly forgotten: boolean
  readonly memoryId: MemoryId
  readonly affectedMemoryIds: readonly MemoryId[]
}

/** Reference-store health facts. */
export interface MemoryHealthReport {
  readonly ready: boolean
  readonly records: number
  readonly scopes: number
  readonly embeddingSpaceId: string
  readonly capabilities: {
    readonly transactions: true
    readonly semanticSearch: true
    readonly lexicalSearch: true
    readonly preFilter: true
    readonly durableJobs: true
  }
}

/** Public memory capability mounted at `ctx.memory`. */
export interface MemoryCapability {
  scopeFor(agent: Agent): MemoryScope
  add(input: AddMemoryInput, signal?: AbortSignal): Promise<WriteReceipt>
  search(input: SearchMemoryInput, signal?: AbortSignal): Promise<SearchResult>
  get(memoryId: MemoryId, scope: MemoryScope): MemoryRecord | undefined
  list(input: ListMemoryInput): readonly MemoryRecord[]
  forget(memoryId: MemoryId, scope: MemoryScope, expectedRevision?: number): Promise<ForgetReceipt>
  managementScopes(): readonly MemoryScope[]
  inspect(scope: MemoryScope): MemoryDiagnostics
  revise(input: ReviseMemoryInput, signal?: AbortSignal): Promise<WriteReceipt>
  export(scope: MemoryScope): readonly MemoryRecord[]
  import(scope: MemoryScope, records: readonly MemoryRecord[]): Promise<number>
  health(): MemoryHealthReport
}
