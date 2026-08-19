/** Shared semantic invariants for one durable memory scope document. */

import type { MemoryId, MemoryRecord, MemoryScope } from './types.ts'

const DERIVED_LAYERS = new Set<MemoryRecord['layer']>([
  'l2_fact',
  'l3_summary',
  'l4_identity',
])
const PREDECESSOR_STATUSES = new Set<MemoryRecord['status']>([
  'superseded',
  'archived',
  'deleted',
])

/**
 * Return the first deterministic semantic violation in a scope document.
 * Storage-provider constraints such as writable layers and embedding spaces
 * deliberately remain outside this portable checker.
 */
export function findMemoryStateViolation(records: readonly MemoryRecord[]): string | undefined {
  const byId = new Map<MemoryId, MemoryRecord>()
  for (const record of records) {
    if (byId.has(record.id)) return `duplicate memory id '${record.id}'`
    byId.set(record.id, record)
  }

  for (const record of records) {
    for (const targetId of relationsOf(record)) {
      if (!byId.has(targetId)) return `memory '${record.id}' references missing '${targetId}'`
    }
  }
  for (const record of records) {
    for (const targetId of relationsOf(record)) {
      const target = byId.get(targetId)
      if (target === undefined) continue
      if (!sameOwner(record.scope, target.scope)) return 'memory relation crosses scope'
    }
  }

  for (const successor of records) {
    for (const predecessorId of forwardTargetsOf(successor)) {
      const predecessor = byId.get(predecessorId)
      if (predecessor === undefined) continue
      if (hasAmbiguousType(successor, predecessorId)) {
        return `memory relation '${successor.id}' -> '${predecessorId}' has an ambiguous evolution type`
      }
      if (!predecessor.supersededBy.includes(successor.id)) {
        return `memory relation '${successor.id}' -> '${predecessorId}' is missing its reverse edge`
      }
    }
  }
  for (const predecessor of records) {
    for (const successorId of predecessor.supersededBy) {
      const successor = byId.get(successorId)
      if (successor === undefined) continue
      const typedEdges = Number(successor.supersedes.includes(predecessor.id))
        + Number(successor.consolidates.includes(predecessor.id))
      if (typedEdges > 1) {
        return `memory relation '${successor.id}' -> '${predecessor.id}' has an ambiguous evolution type`
      }
      if (typedEdges === 0) {
        return `memory relation '${predecessor.id}' -> '${successor.id}' is missing its reverse edge`
      }
    }
  }

  const cycle = findEvolutionCycle(records, byId)
  if (cycle !== undefined) return `memory evolution graph contains a cycle at '${cycle}'`

  for (const successor of records) {
    for (const predecessorId of forwardTargetsOf(successor)) {
      const predecessor = byId.get(predecessorId)
      if (predecessor !== undefined && successor.revision <= predecessor.revision) {
        return `memory successor '${successor.id}' revision must be greater than predecessor '${predecessor.id}' revision`
      }
    }
  }

  for (const successor of records) {
    for (const predecessorId of forwardTargetsOf(successor)) {
      const predecessor = byId.get(predecessorId)
      if (predecessor === undefined) continue
      if (!PREDECESSOR_STATUSES.has(predecessor.status)) {
        return `memory predecessor '${predecessor.id}' has invalid status '${predecessor.status}'`
      }
      if (predecessor.visibility !== 'source_only') {
        return `memory predecessor '${predecessor.id}' has invalid visibility '${predecessor.visibility}'`
      }
    }
  }

  const heads = new Set<string>()
  for (const record of records) {
    if (record.chainId !== undefined && record.status === 'active' && record.visibility === 'recallable') {
      if (heads.has(record.chainId)) return `memory chain '${record.chainId}' has multiple active heads`
      heads.add(record.chainId)
    }
    if (record.status === 'deleted' && record.visibility === 'recallable') {
      return `deleted memory '${record.id}' remains recallable`
    }
    if (record.status !== 'deleted'
      && DERIVED_LAYERS.has(record.layer)
      && record.sourceType !== 'explicit'
      && record.sourceMemoryIds.length === 0) {
      return `derived memory '${record.id}' has no raw source`
    }
  }
  return undefined
}

function findEvolutionCycle(
  records: readonly MemoryRecord[],
  byId: ReadonlyMap<MemoryId, MemoryRecord>,
): MemoryId | undefined {
  const visiting = new Set<MemoryId>()
  const visited = new Set<MemoryId>()

  const visit = (predecessorId: MemoryId): MemoryId | undefined => {
    if (visiting.has(predecessorId)) return predecessorId
    if (visited.has(predecessorId)) return undefined
    visiting.add(predecessorId)
    const predecessor = byId.get(predecessorId)
    if (predecessor !== undefined) {
      for (const successorId of predecessor.supersededBy) {
        const cycle = visit(successorId)
        if (cycle !== undefined) return cycle
      }
    }
    visiting.delete(predecessorId)
    visited.add(predecessorId)
    return undefined
  }

  for (const record of records) {
    const cycle = visit(record.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

function relationsOf(record: MemoryRecord): readonly MemoryId[] {
  return [...record.supersedes, ...record.consolidates, ...record.supersededBy]
}

function forwardTargetsOf(record: MemoryRecord): readonly MemoryId[] {
  return [...new Set([...record.supersedes, ...record.consolidates])]
}

function hasAmbiguousType(successor: MemoryRecord, predecessorId: MemoryId): boolean {
  return successor.supersedes.includes(predecessorId) && successor.consolidates.includes(predecessorId)
}

function sameOwner(left: MemoryScope, right: MemoryScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId && left.agentId === right.agentId
}
