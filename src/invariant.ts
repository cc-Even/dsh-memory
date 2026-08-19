/** Package-owned runtime invariant for durable memory relations. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { memoryScopeStateSchema } from './schema.ts'

const PACKAGE_NAME = '@evyn/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Cross-check each committed scope document's relation symmetry and active chain heads. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'memory' || change.table !== 'scopes' || change.operation !== 'put') return
    const parsed = memoryScopeStateSchema.safeParse(change.value)
    if (!parsed.success) return fail(`scope '${change.key}' committed an invalid durable document`)
    const records = new Map(parsed.data.records.map(record => [record.id, record]))
    const heads = new Set<string>()
    for (const record of parsed.data.records) {
      if (record.status === 'deleted' && record.visibility === 'recallable') {
        return fail(`deleted memory '${record.id}' remains recallable`)
      }
      if (record.chainId !== undefined && record.status === 'active' && record.visibility === 'recallable') {
        if (heads.has(record.chainId)) return fail(`memory chain '${record.chainId}' has multiple active heads`)
        heads.add(record.chainId)
      }
      for (const oldId of [...record.supersedes, ...record.consolidates]) {
        const old = records.get(oldId)
        if (old === undefined || !old.supersededBy.includes(record.id)) {
          return fail(`memory relation '${record.id}' -> '${oldId}' is missing its reverse edge`)
        }
      }
    }
  })
}, { inject: ['storageDomain'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
