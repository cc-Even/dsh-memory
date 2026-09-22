/** Safe, content-free diagnostic and trusted management contracts. */
import type { MemoryErrorCode } from './error.ts'
import type { MemoryId, MemoryJobId, MemoryRecord, MemoryScope } from './types.ts'

export type DiagnosticCode = MemoryErrorCode | 'INTERRUPTED' | 'ABORTED' | 'UNKNOWN'
export interface MemoryJobDiagnostic {
  readonly jobId: MemoryJobId
  readonly rawMemoryId: MemoryId
  readonly status: 'accepted' | 'completed' | 'degraded'
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly modelCalls?: number
  readonly code?: DiagnosticCode
}
export interface MemoryRecallDiagnostic {
  readonly at: string
  readonly outcome: 'injected' | 'empty' | 'error'
  readonly durationMs: number
  readonly memoryIds: readonly MemoryId[]
  readonly degradedChannels: readonly string[]
  readonly code?: DiagnosticCode
}
export interface MemoryDiagnostics {
  readonly revision: number
  readonly counts: {
    readonly records: number
    readonly recallable: number
    readonly statuses: Record<MemoryRecord['status'], number>
    readonly layers: Record<string, number>
    readonly jobs: Record<MemoryJobDiagnostic['status'], number>
  }
  readonly policy: {
    readonly autoCapture: boolean
    readonly autoRecall: boolean
    readonly embeddingQuality: 'portable-hash' | 'trained'
    readonly maxRecordChars: number
  }
  readonly jobs: readonly MemoryJobDiagnostic[]
  readonly recalls: readonly MemoryRecallDiagnostic[]
}
export interface ReviseMemoryInput {
  readonly scope: MemoryScope
  readonly memoryId: MemoryId
  /** Whole scope revision returned by inspect/detail; checked inside the owner queue. */
  readonly expectedRevision: number
  readonly action: 'confirm' | 'correct'
  readonly content?: string
  readonly idempotencyKey: string
}
