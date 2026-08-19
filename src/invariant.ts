/** Package-owned runtime invariant for durable memory relations. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { memoryScopeStateSchema } from './schema.ts'
import { findMemoryStateViolation } from './state-invariant.ts'

const PACKAGE_NAME = '@evyn/dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Cross-check each committed scope document with the service's semantic state rules. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'memory' || change.table !== 'scopes' || change.operation !== 'put') return
    const parsed = memoryScopeStateSchema.safeParse(change.value)
    if (!parsed.success) return fail(`scope '${change.key}' committed an invalid durable document`)
    const violation = findMemoryStateViolation(parsed.data.records)
    if (violation !== undefined) return fail(violation)
  })
}, { inject: ['storageDomain'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
