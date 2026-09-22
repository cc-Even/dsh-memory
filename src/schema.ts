/** Durable storage schema for one atomically committed memory scope. */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { MemoryId, MemoryJobId, MemoryRecord } from './types.ts'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const memoryId = z.string().min(1).transform(value => value as MemoryId)
const memoryLayer = z.union([
  z.literal('l0_basic_info'),
  z.literal('l1_raw'),
  z.literal('l2_fact'),
  z.literal('l3_summary'),
  z.literal('l4_identity'),
  z.literal('l5_knowledge'),
  z.literal('l6_schema'),
  z.literal('l7_intention'),
])
const scope = z.object({
  tenantId: z.string().min(1).optional(),
  userId: z.string().min(1),
  agentId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
})
const embedding = z.object({
  spaceId: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number()),
}).refine(value => value.vector.length === value.dimensions, {
  message: 'embedding vector length must equal dimensions',
})

/** Runtime validator for one portable memory record. */
export const memoryRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: memoryId,
  scope,
  layer: memoryLayer,
  content: z.string().min(1),
  status: z.union([
    z.literal('active'),
    z.literal('superseded'),
    z.literal('archived'),
    z.literal('deleted'),
  ]),
  visibility: z.union([z.literal('recallable'), z.literal('source_only')]),
  sourceType: z.union([z.literal('explicit'), z.literal('inferred'), z.literal('composite')]),
  confidence: z.number().min(0).max(1),
  occurredAt: z.iso.datetime().optional(),
  validFrom: z.iso.datetime().optional(),
  validUntil: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  chainId: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  supersedes: z.array(memoryId),
  supersededBy: z.array(memoryId),
  consolidates: z.array(memoryId),
  sourceMemoryIds: z.array(memoryId),
  sourceSessionId: z.string().min(1).optional(),
  sourceTurnIndexes: z.array(safeInteger),
  idempotencyKey: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)),
  meta: z.record(z.string(), z.json()),
  embedding,
}) as unknown as z.ZodType<MemoryRecord>

/** Persisted write job, including accepted work that can degrade after restart. */
export const storedJobSchema = z.object({
  idempotencyKey: z.string().min(1),
  requestId: z.string().min(1),
  jobId: z.string().min(1).transform(value => value as MemoryJobId),
  rawMemoryId: memoryId,
  status: z.union([z.literal('accepted'), z.literal('completed'), z.literal('degraded')]),
  createdMemoryIds: z.array(memoryId),
  warnings: z.array(z.string()),
  // Optional additive metadata keeps legacy scope documents readable.
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  durationMs: safeInteger.optional(),
  modelCalls: safeInteger.optional(),
  code: z.enum(['INVALID_INPUT', 'SCOPE_REQUIRED', 'RAW_PERSIST_FAILED', 'EXTRACTION_FAILED',
    'RECONCILE_FAILED', 'CONCURRENT_MODIFICATION', 'TOKENIZATION_FAILED', 'EMBEDDING_FAILED',
    'EMBEDDING_SPACE_MISMATCH', 'STORE_UNAVAILABLE', 'INTERRUPTED', 'ABORTED', 'UNKNOWN']).optional(),
})

/** One durable write job. */
export type StoredMemoryJob = z.infer<typeof storedJobSchema>

/** Whole-scope document committed by one storage-domain write. */
export const memoryScopeStateSchema = z.object({
  revision: safeInteger,
  records: z.array(memoryRecordSchema),
  jobs: z.array(storedJobSchema),
})

/** Durable whole-scope document type. */
export type MemoryScopeState = z.infer<typeof memoryScopeStateSchema>

/** Durable row key; an encoded tenant/user/agent tuple. */
export type MemoryScopeKey = string & { readonly __memoryScopeKey: unique symbol }

/** Memory domain: one atomic document per tenant/user/agent scope. */
export const memoryDomainSpec = defineDomain({
  name: 'memory',
  version: 0,
  tables: {
    scopes: domainTable<MemoryScopeKey, MemoryScopeState>(memoryScopeStateSchema),
  },
})
