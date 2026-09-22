/** Browser DTOs deliberately exclude arbitrary metadata, owner identities and vectors. */
import type { MemoryDiagnostics } from './diagnostics.ts'
import type { ForgetReceipt, MemoryRecord } from './types.ts'
export type ManagedMemory = Pick<MemoryRecord,
  'id' | 'content' | 'layer' | 'status' | 'visibility' | 'sourceType' | 'confidence' |
  'createdAt' | 'updatedAt' | 'revision' | 'supersedes' | 'supersededBy' | 'consolidates' |
  'sourceMemoryIds' | 'sourceSessionId' | 'tags' | 'validFrom' | 'validUntil'>
export interface MemoryPage {
  readonly revision: number
  readonly total: number
  readonly records: readonly ManagedMemory[]
}
export interface MemoryDetail {
  readonly revision: number
  readonly record: ManagedMemory
  readonly evidence: readonly ManagedMemory[]
  readonly history: readonly ManagedMemory[]
}
export type ManagementState = MemoryDiagnostics
export type ManagementMutationResult = ForgetReceipt | {
  readonly status: 'completed' | 'degraded'
  readonly rawMemoryId: string
  readonly createdMemoryIds: readonly string[]
}
