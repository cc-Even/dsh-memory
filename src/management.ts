/** Authenticated local-owner management channel. Never mounted as a model tool. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './index.ts'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import type { ManagedMemory, MemoryDetail, MemoryPage } from './management-types.ts'
import type { MemoryId, MemoryRecord } from './types.ts'

export const name = 'memory-management'
export const inject = ['memory', 'connection', 'webServer']
const id = z.string().min(1).max(256)
const base = z.object({ agentId: id }).strict()
const detailSchema = base.extend({ memoryId: id })
const listSchema = base.extend({
  q: z.string().max(200).optional(),
  layer: z.enum(['l0_basic_info', 'l1_raw', 'l2_fact', 'l3_summary', 'l4_identity']).optional(),
  status: z.enum(['active', 'superseded', 'archived', 'deleted']).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(100).default(25),
})
const mutationBase = detailSchema.extend({ expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
const mutateSchema = z.discriminatedUnion('action', [
  mutationBase.extend({ action: z.literal('forget') }),
  mutationBase.extend({ action: z.literal('confirm'), idempotencyKey: id }),
  mutationBase.extend({ action: z.literal('correct'), idempotencyKey: id, content: z.string().trim().min(1).max(50000) }),
])
const errorMessages: Record<string, string> = {
  INVALID_INPUT: '请求参数或目标记忆无效。',
  CONCURRENT_MODIFICATION: '记忆已发生变化，请刷新后重试。',
  STORE_UNAVAILABLE: '记忆存储暂不可用，请稍后重试。',
  RAW_PERSIST_FAILED: '原始证据未能保存，请稍后重试。',
  EMBEDDING_FAILED: '嵌入处理失败。',
}
function failure(code: string): ConnectionRpcResult<never> {
  const safeCode = Object.hasOwn(errorMessages, code) ? code : 'STORE_UNAVAILABLE'
  return { ok: false, error: { code: safeCode, message: errorMessages[safeCode]!, details: {} } }
}
/** Explicit projection protects the wire when persisted records gain new private fields. */
function recordDto(record: MemoryRecord): ManagedMemory {
  return {
    id: record.id, content: record.content, layer: record.layer, status: record.status,
    visibility: record.visibility, sourceType: record.sourceType, confidence: record.confidence,
    createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
    supersedes: [...record.supersedes], supersededBy: [...record.supersededBy], consolidates: [...record.consolidates],
    sourceMemoryIds: [...record.sourceMemoryIds], tags: [...record.tags],
    ...(record.sourceSessionId === undefined ? {} : { sourceSessionId: record.sourceSessionId }),
    ...(record.validFrom === undefined ? {} : { validFrom: record.validFrom }),
    ...(record.validUntil === undefined ? {} : { validUntil: record.validUntil }),
  }
}

/** Dispatch only after Connection has authenticated the local deployment owner. */
export async function managementRequest(ctx: Context, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
  try {
    if (endpoint === 'scopes') {
      if (!z.object({}).strict().safeParse(payload).success) return failure('INVALID_INPUT')
      return { ok: true, value: { agents: ctx.memory.managementScopes().map(scope => scope.agentId) } }
    }
    const schema = endpoint === 'state' ? base : endpoint === 'list' ? listSchema : endpoint === 'detail' ? detailSchema : endpoint === 'mutate' ? mutateSchema : undefined
    if (!schema) return failure('INVALID_INPUT')
    const parsed = schema.safeParse(payload)
    if (!parsed.success) return failure('INVALID_INPUT')
    const scope = ctx.memory.managementScopes().find(scope => scope.agentId === parsed.data.agentId)
    if (scope === undefined) return failure('INVALID_INPUT')
    if (endpoint === 'state') return { ok: true, value: ctx.memory.inspect(scope) }
    if (endpoint === 'list') {
      const input = listSchema.parse(payload)
      const query = input.q?.trim().toLocaleLowerCase()
      const records = ctx.memory.export(scope).filter(record =>
        (input.status === undefined || record.status === input.status)
        && (input.layer === undefined || record.layer === input.layer)
        && (!query || `${record.content}\n${record.tags.join(' ')}`.toLocaleLowerCase().includes(query)))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      const value: MemoryPage = { revision: ctx.memory.inspect(scope).revision, total: records.length,
        records: records.slice(input.offset, input.offset + input.limit).map(recordDto) }
      return { ok: true, value }
    }
    if (endpoint === 'detail') {
      const { memoryId } = detailSchema.parse(payload)
      const records = ctx.memory.export(scope)
      const record = records.find(record => record.id === memoryId)
      if (!record) return failure('INVALID_INPUT')
      const evidence = records.filter(candidate => record.sourceMemoryIds.includes(candidate.id))
      const related = new Set([...record.supersedes, ...record.supersededBy, ...record.consolidates])
      const history = records.filter(candidate => candidate.id !== record.id && (
        (record.chainId !== undefined && candidate.chainId === record.chainId) || related.has(candidate.id)))
        .sort((a, b) => b.revision - a.revision || b.updatedAt.localeCompare(a.updatedAt))
      const value: MemoryDetail = { revision: ctx.memory.inspect(scope).revision, record: recordDto(record), evidence: evidence.map(recordDto), history: history.map(recordDto) }
      return { ok: true, value }
    }
    const input = mutateSchema.parse(payload)
    const memoryId = input.memoryId as MemoryId
    if (!ctx.memory.get(memoryId, scope)) return failure('INVALID_INPUT')
    if (input.action === 'forget') return { ok: true, value: await ctx.memory.forget(memoryId, scope, input.expectedRevision) }
    const receipt = await ctx.memory.revise({ scope, memoryId, action: input.action, expectedRevision: input.expectedRevision,
      idempotencyKey: `management:${input.idempotencyKey}`, ...(input.action === 'correct' ? { content: input.content } : {}) }, signal)
    return { ok: true, value: { status: receipt.status, rawMemoryId: receipt.rawMemoryId, createdMemoryIds: receipt.createdMemoryIds } }
  } catch (error) {
    // The host and client bundles may contain distinct Error constructors. Only a
    // known code is projected; arbitrary exception text and details never leave.
    return failure(error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'STORE_UNAVAILABLE')
  }
}

const envelopeSchema = z.object({
  type: z.literal('client-request'), rpcId: id, method: id, payload: z.unknown(),
}).strict()
const MAX_REQUEST_BYTES = 256 * 1024

/** Bounded JSON adapter for Connection's authenticated, exact Fetch routes. */
export async function managementFetch(ctx: Context, endpoint: string, request: Request): Promise<Response> {
  const reject = (status: number) => Response.json({ error: 'INVALID_REQUEST' }, { status })
  if (request.method !== 'POST') return reject(405)
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return reject(415)
  const reader = request.body?.getReader()
  if (!reader) return reject(400)
  let body = ''
  let bytes = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_REQUEST_BYTES) { await reader.cancel(); return reject(413) }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    const envelope = envelopeSchema.safeParse(JSON.parse(body))
    if (!envelope.success || envelope.data.method !== `memory-management/${endpoint}`) return reject(400)
    const result = await managementRequest(ctx, endpoint, envelope.data.payload, request.signal)
    return Response.json({ type: 'server-response', rpcId: envelope.data.rpcId, result }, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch { return reject(400) }
  finally { reader.releaseLock() }
}

/** Shared /api carrier owns authentication; the consumer also owns route cleanup. */
export function apply(ctx: Context): void {
  for (const endpoint of ['scopes', 'state', 'list', 'detail', 'mutate']) {
    // rc.2's dedicated rpc.handle getter shadows a provider context lacking
    // webServer injection. Exact shared routes avoid that upstream activation bug.
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/memory-management/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: request => managementFetch(ctx, endpoint, request),
    }), `memory-management.${endpoint}`)
  }
}
