import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import MemoryService from '../src/index.ts'
import { memoryDomainSpec, type MemoryScopeKey, type MemoryScopeState } from '../src/schema.ts'
import type { Config } from '../src/index.ts'

const contexts: Context[] = []
const roots: string[] = []
const scope = { userId: 'owner', agentId: 'default' }
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(config: Config = {}, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'memory-management-'))
  if (!existingRoot) roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(MemoryService, { userId: 'owner', autoCapture: false, autoRecall: false, ...config })
  return { ctx, root }
}

describe('memory diagnostics and management contract', () => {
  it('reports scoped safe durable outcomes, and keeps them across a cold restart', async () => {
    const { ctx, root } = await setup()
    const good = await ctx.memory.add({ scope, content: 'Use TypeScript', idempotencyKey: 'direct' })
    await ctx.memory.add({ scope, content: 'remember this', mode: 'extract' })
    await ctx.memory.add({ scope: { ...scope, userId: 'private-user' }, content: 'PRIVATE OTHER OWNER' })
    const snapshot = ctx.memory.inspect(scope)
    expect(snapshot.counts.records).toBe(3)
    expect(snapshot.counts.jobs).toEqual({ accepted: 0, completed: 1, degraded: 1 })
    expect(snapshot.jobs.find(job => job.jobId === good.jobId)).toMatchObject({ modelCalls: 0, status: 'completed' })
    expect(snapshot.jobs.find(job => job.status === 'degraded')?.code).toBe('EXTRACTION_FAILED')
    expect(snapshot.jobs.every(job => (job.durationMs ?? -1) >= 0)).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('warnings')
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE OTHER OWNER')
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const restarted = await setup({}, root)
    expect(restarted.ctx.memory.inspect(scope).jobs).toEqual(snapshot.jobs)
  })

  it('derives management presets only from the configured tenant and user', async () => {
    const { ctx } = await setup({ tenantId: 'home' })
    for (const owner of [
      { tenantId: 'home', userId: 'owner', agentId: 'writer' },
      { tenantId: 'other', userId: 'owner', agentId: 'hidden-tenant' },
      { tenantId: 'home', userId: 'other', agentId: 'hidden-user' },
    ]) await ctx.memory.add({ scope: owner, content: 'private' })
    expect(ctx.memory.managementScopes().map(item => item.agentId).sort()).toEqual(['default', 'writer'])
  })

  it('corrects and confirms without overwriting history and rejects stale concurrent actions', async () => {
    const { ctx } = await setup()
    const first = await ctx.memory.add({ scope, content: 'I live in Shanghai' })
    const memoryId = first.createdMemoryIds[0]!
    const expectedRevision = ctx.memory.inspect(scope).revision
    const input = { scope, memoryId, expectedRevision, action: 'correct' as const, content: 'I live in Hangzhou', idempotencyKey: 'correct-once' }
    const [corrected, stale] = await Promise.allSettled([
      ctx.memory.revise(input), ctx.memory.forget(memoryId, scope, expectedRevision),
    ])
    expect(corrected.status).toBe('fulfilled')
    expect(stale).toMatchObject({ status: 'rejected', reason: { code: 'CONCURRENT_MODIFICATION' } })
    if (corrected.status !== 'fulfilled') throw corrected.reason
    expect(await ctx.memory.revise(input)).toEqual(corrected.value)
    const newId = corrected.value.createdMemoryIds[0]!
    expect(ctx.memory.get(memoryId, scope)).toMatchObject({ content: 'I live in Shanghai', status: 'superseded', supersededBy: [newId] })
    expect(ctx.memory.get(newId, scope)).toMatchObject({ content: 'I live in Hangzhou', supersedes: [memoryId], revision: 2, sourceType: 'explicit', sourceMemoryIds: [corrected.value.rawMemoryId] })
    const confirmed = await ctx.memory.revise({ scope, memoryId: newId, expectedRevision: ctx.memory.inspect(scope).revision, action: 'confirm', idempotencyKey: 'confirm-once' })
    expect(ctx.memory.get(confirmed.createdMemoryIds[0]!, scope)).toMatchObject({ content: 'I live in Hangzhou', revision: 3, meta: { managementAction: 'confirm' } })
    expect(await ctx.memory.forget(confirmed.rawMemoryId, scope, ctx.memory.inspect(scope).revision)).toMatchObject({ forgotten: true, affectedMemoryIds: expect.arrayContaining([confirmed.createdMemoryIds[0]]) })
  })

  it('rejects editing raw records and foreign records before persisting new evidence', async () => {
    const { ctx } = await setup()
    const first = await ctx.memory.add({ scope, content: 'hello' })
    const revision = ctx.memory.inspect(scope).revision
    await expect(ctx.memory.revise({ scope, memoryId: first.rawMemoryId, expectedRevision: revision, action: 'confirm', idempotencyKey: 'bad-raw' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(ctx.memory.revise({ scope: { ...scope, userId: 'other' }, memoryId: first.createdMemoryIds[0]!, expectedRevision: 0, action: 'confirm', idempotencyKey: 'bad-owner' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(ctx.memory.inspect(scope).revision).toBe(revision)
  })

  it('reports only IDs actually injected under the recall context budget', async () => {
    const { ctx } = await setup({ autoRecall: true, maxContextChars: 300 })
    const id = SessionId('diagnostic-recall')
    const agent = { id, session: Session.create(id) } as unknown as Agent
    for (let index = 0; index < 5; index++) await ctx.memory.add({ scope, content: `TypeScript ${index} is preferred for application services.` })
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'TypeScript' }] })
    const result = await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [user], turn: 1, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [user] }))
    if (result.kind !== 'enter') throw new Error('expected enter')
    const content = JSON.stringify(result.messages[0])
    const recalls = ctx.memory.inspect(scope).recalls
    expect(recalls).toHaveLength(1)
    expect(recalls[0]!.memoryIds.length).toBeGreaterThan(0)
    expect(recalls[0]!.memoryIds.length).toBeLessThan(5)
    const injected = [...content.matchAll(/\[(memory-[^\]]+)\]/g)].map(match => match[1])
    expect([...recalls[0]!.memoryIds].sort()).toEqual(injected.sort())
    expect(ctx.memory.inspect({ ...scope, userId: 'other' }).recalls).toEqual([])
    for (let index = 0; index < 205; index++) await agentEvents(ctx, agent).waterfall('agent/pre-step', { messages: [user], turn: index + 2, step: 1, signal: new AbortController().signal }, () => Promise.resolve({ kind: 'enter' as const, messages: [user] }))
    expect(ctx.memory.inspect(scope).recalls).toHaveLength(20)
    expect(JSON.stringify(recalls)).not.toContain('query')
  })

  it('strictly rejects owner overrides at the management RPC boundary', async () => {
    const { ctx } = await setup()
    const { managementRequest } = await import('../src/management.ts')
    for (const extra of [{ userId: 'other' }, { tenantId: 'other' }, { scope }, { sessionId: 'other' }]) {
      expect(await managementRequest(ctx, 'state', { agentId: 'default', ...extra })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    }
    expect(await managementRequest(ctx, 'state', { agentId: 'unknown' })).toMatchObject({ ok: false })
    expect(await managementRequest(ctx, 'state', { agentId: 'default' })).toMatchObject({ ok: true, value: { counts: { records: 0 } } })
  })
})


it('persists correction evidence before embedding and degrades safely across restart', async () => {
  let inspectDuringEmbedding: (() => void) | undefined
  const embeddingProvider = {
    describe: () => ({ spaceId: 'management/test/2', dimensions: 2, maxBatchSize: 10, normalization: 'l2' as const, quality: 'trained' as const }),
    embedBatch: async (texts: readonly string[]) => {
      if (inspectDuringEmbedding) { inspectDuringEmbedding(); throw new Error('PRIVATE_KEY_AND_URL') }
      return texts.map(() => [1, 0])
    },
  }
  const { ctx, root } = await setup({ embeddingProvider })
  const original = await ctx.memory.add({ scope, content: 'old fact' })
  const before = ctx.memory.inspect(scope)
  const snapshots: MemoryScopeState[] = []
  ctx.on('domain/changed', change => { if (change.domain === 'memory' && change.table === 'scopes') snapshots.push(structuredClone(change.value) as MemoryScopeState) })
  let observed = false
  inspectDuringEmbedding = () => {
    const persisted = snapshots.at(-1)!
    expect(persisted.jobs.at(-1)?.status).toBe('accepted')
    expect(ctx.memory.inspect(scope).jobs[0]?.modelCalls).toBeUndefined()
    expect(persisted.records.find(record => record.id === persisted.jobs.at(-1)?.rawMemoryId)).toMatchObject({ content: 'new fact', visibility: 'recallable' })
    observed = true
  }
  const failed = await ctx.memory.revise({ scope, memoryId: original.createdMemoryIds[0]!, expectedRevision: before.revision, action: 'correct', content: 'new fact', idempotencyKey: 'failed-correction' })
  expect(observed).toBe(true)
  expect(failed.status).toBe('degraded')
  expect(ctx.memory.get(original.createdMemoryIds[0]!, scope)?.status).toBe('active')
  expect(ctx.memory.get(failed.rawMemoryId, scope)?.visibility).toBe('recallable')
  expect(ctx.memory.inspect(scope).jobs[0]).toMatchObject({ status: 'degraded', code: 'EMBEDDING_FAILED' })
  expect(JSON.stringify(ctx.memory.inspect(scope))).not.toContain('PRIVATE_KEY_AND_URL')
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
  inspectDuringEmbedding = undefined
  const restarted = await setup({ embeddingProvider }, root)
  expect(restarted.ctx.memory.inspect(scope).jobs[0]).toMatchObject({ status: 'degraded', code: 'EMBEDDING_FAILED' })
  expect(restarted.ctx.memory.get(original.createdMemoryIds[0]!, scope)?.status).toBe('active')
})

it('loads legacy jobs without timing and classifies interrupted accepted jobs', async () => {
  const { ctx, root } = await setup()
  await ctx.memory.add({ scope, content: 'legacy evidence' })
  await ctx.memory.add({ scope, content: 'interrupted evidence', mode: 'extract' })
  const timed = await ctx.memory.add({ scope, content: 'interrupted with diagnostics', mode: 'extract' })
  const startedAt = new Date(Date.now() - 86400000).toISOString()
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
  const fixture = new Context()
  contexts.push(fixture)
  await fixture.plugin(Storage)
  await fixture.plugin(StorageJson, { root })
  await fixture.plugin(StorageDomain, { backend: 'json' })
  const domain = await fixture.storageDomain.open(memoryDomainSpec)
  const table = domain.table('scopes')
  const key = JSON.stringify(['', 'owner', 'default']) as MemoryScopeKey
  await table.update(key, state => ({ ...state, jobs: state.jobs.map((job, index) => ({
    idempotencyKey: job.idempotencyKey, requestId: job.requestId, jobId: job.jobId, rawMemoryId: job.rawMemoryId,
    status: index === 0 ? 'completed' : 'accepted', createdMemoryIds: job.createdMemoryIds, warnings: [],
    ...(index === 2 ? { startedAt, modelCalls: 0, durationMs: 99 } : {}),
  })) }))
  await domain.close()
  await fixture.fiber.dispose()
  contexts.splice(contexts.indexOf(fixture), 1)
  const restarted = await setup({}, root)
  const jobs = restarted.ctx.memory.inspect(scope).jobs
  expect(jobs.find(job => job.status === 'completed')?.durationMs).toBeUndefined()
  expect(jobs.find(job => job.status === 'degraded')?.code).toBe('INTERRUPTED')
  const recovered = jobs.find(job => job.jobId === timed.jobId)!
  expect(recovered).toMatchObject({ status: 'degraded', code: 'INTERRUPTED', startedAt, finishedAt: expect.any(String) })
  expect(recovered.durationMs).toBeUndefined()
  expect(recovered.modelCalls).toBeUndefined()
})

it('counts logical extraction and reconciliation calls without calls on diagnostic reads', async () => {
  const { ctx } = await setup({ provider: 'test', model: 'test' })
  const extraction = JSON.stringify({ basicProfilePatch: {}, facts: [{ clientRef: 'f', content: 'TypeScript preference', layer: 'l2_fact', tags: [], confidence: 1, evidenceTurnIndexes: [] }], identities: [] })
  const responses = [extraction]
  let calls = 0
  class Adapter extends LlmAdapter {
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls++
      const text = responses.shift()!
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const first = await ctx.memory.add({ scope, content: 'TypeScript preference', mode: 'extract' })
  expect(ctx.memory.inspect(scope).jobs[0]?.modelCalls).toBe(1)
  responses.push(extraction, JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'f', duplicateOf: first.createdMemoryIds[0] }] }))
  await ctx.memory.add({ scope, content: 'TypeScript preference again', mode: 'extract' })
  expect(ctx.memory.inspect(scope).jobs[0]?.modelCalls).toBe(2)
  expect(calls).toBe(3)
})

it('bounds and filters RPC pages, returns evidence/history, and rejects foreign mutations', async () => {
  const { ctx } = await setup()
  const { managementRequest: rpc } = await import('../src/management.ts')
  const first = await ctx.memory.add({ scope, content: 'before revision' })
  const second = await ctx.memory.revise({ scope, memoryId: first.createdMemoryIds[0]!, expectedRevision: ctx.memory.inspect(scope).revision, action: 'correct', content: 'after revision', idempotencyKey: 'rpc-revision' })
  const foreign = await ctx.memory.add({ scope: { ...scope, userId: 'foreign' }, content: 'SECRET_FOREIGN' })
  expect(await rpc(ctx, 'list', { agentId: 'default', status: 'active', layer: 'l2_fact', q: 'after', limit: 1 })).toMatchObject({ ok: true, value: { total: 1, records: [{ content: 'after revision' }] } })
  expect(await rpc(ctx, 'list', { agentId: 'default', status: 'active', layer: 'l2_fact', offset: 1 })).toMatchObject({ ok: true, value: { total: 1, records: [] } })
  for (const bounds of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.1 }, { q: 'a'.repeat(201) }]) expect(await rpc(ctx, 'list', { agentId: 'default', ...bounds })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  const detail = await rpc(ctx, 'detail', { agentId: 'default', memoryId: second.createdMemoryIds[0] })
  expect(detail).toMatchObject({ ok: true, value: { record: { content: 'after revision' }, evidence: [{ id: second.rawMemoryId }], history: expect.arrayContaining([expect.objectContaining({ id: first.createdMemoryIds[0] })]) } })
  for (const secretField of ['embedding', 'meta', 'warnings', 'SECRET_FOREIGN']) expect(JSON.stringify(detail)).not.toContain(secretField)
  for (const endpoint of ['detail', 'mutate']) {
    const payload = { agentId: 'default', memoryId: foreign.createdMemoryIds[0], ...(endpoint === 'mutate' ? { expectedRevision: ctx.memory.inspect(scope).revision, action: 'forget' } : {}) }
    expect(await rpc(ctx, endpoint, payload)).toMatchObject({ ok: false })
    expect(await rpc(ctx, endpoint, { ...payload, userId: 'foreign' })).toMatchObject({ ok: false })
  }
  expect(ctx.memory.get(foreign.createdMemoryIds[0]!, { ...scope, userId: 'foreign' })?.status).toBe('active')
  await ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(ctx), 1)
  const failed = await rpc(ctx, 'mutate', { agentId: 'default', memoryId: second.createdMemoryIds[0], expectedRevision: 4, action: 'forget' })
  expect(failed).toMatchObject({ ok: false })
})

it('rejects invalid corrections before writing and rejects superseded/deleted targets', async () => {
  const { ctx } = await setup({ maxRecordChars: 20 })
  const first = await ctx.memory.add({ scope, content: 'before' })
  for (const content of [' ', 'x'.repeat(21)]) {
    const before = ctx.memory.inspect(scope).revision
    await expect(ctx.memory.revise({ scope, memoryId: first.createdMemoryIds[0]!, expectedRevision: before, action: 'correct', content, idempotencyKey: `invalid-${content.length}` })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(ctx.memory.inspect(scope).revision).toBe(before)
  }
  const next = await ctx.memory.revise({ scope, memoryId: first.createdMemoryIds[0]!, expectedRevision: ctx.memory.inspect(scope).revision, action: 'confirm', idempotencyKey: 'confirm' })
  await expect(ctx.memory.revise({ scope, memoryId: first.createdMemoryIds[0]!, expectedRevision: ctx.memory.inspect(scope).revision, action: 'confirm', idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  await ctx.memory.forget(next.createdMemoryIds[0]!, scope)
  await expect(ctx.memory.revise({ scope, memoryId: next.createdMemoryIds[0]!, expectedRevision: ctx.memory.inspect(scope).revision, action: 'confirm', idempotencyKey: 'deleted' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
})

it('never includes provider exception secrets or arbitrary record metadata in management DTOs', async () => {
  const { ctx } = await setup({ provider: 'broken', model: 'fixture' })
  class BrokenAdapter extends LlmAdapter {
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      throw new Error('SECRET_PROVIDER_RESPONSE https://secret.invalid sk-private-key')
    }
  }
  ctx.llm.registerAdapter(['broken'], new BrokenAdapter())
  const receipt = await ctx.memory.add({ scope, content: 'safe user evidence', mode: 'extract' })
  expect(receipt.status).toBe('degraded')
  const source = ctx.memory.get(receipt.rawMemoryId, scope)!
  await ctx.memory.import(scope, [{ ...source, id: 'private-meta-test' as typeof source.id,
    meta: { private: 'SECRET_METADATA' } }])
  const { managementRequest: rpc } = await import('../src/management.ts')
  for (const [endpoint, payload] of [
    ['state', { agentId: 'default' }],
    ['list', { agentId: 'default' }],
    ['detail', { agentId: 'default', memoryId: 'private-meta-test' }],
  ] as const) {
    const result = await rpc(ctx, endpoint, payload)
    expect(result.ok).toBe(true)
    for (const secret of ['SECRET_PROVIDER_RESPONSE', 'secret.invalid', 'sk-private-key', 'SECRET_METADATA', '"embedding":', 'warnings']) expect(JSON.stringify(result)).not.toContain(secret)
  }
  const failed = await rpc(ctx, 'mutate', { agentId: 'default', memoryId: receipt.rawMemoryId, expectedRevision: 0, action: 'forget' })
  expect(failed).toEqual({ ok: false, error: { code: 'CONCURRENT_MODIFICATION', message: '记忆已发生变化，请刷新后重试。', details: {} } })
})

it('validates the shared API envelope and never reflects malformed input', async () => {
  const { ctx } = await setup()
  const { managementFetch } = await import('../src/management.ts')
  const envelope = { type: 'client-request', rpcId: 'test-correlation', method: 'memory-management/state', payload: { agentId: 'default' } }
  const request = (body: string, media = 'application/json') => new Request('http://localhost/api/memory-management/state', { method: 'POST', headers: { 'content-type': media }, body })
  const good = await managementFetch(ctx, 'state', request(JSON.stringify(envelope)))
  expect(good.status).toBe(200)
  expect(await good.json()).toMatchObject({ type: 'server-response', rpcId: 'test-correlation', result: { ok: true } })
  for (const body of ['SECRET_INVALID_JSON', JSON.stringify({ ...envelope, rpcId: 1 }), JSON.stringify({ ...envelope, method: 'memory-management/mutate' }), JSON.stringify({ ...envelope, tenantId: 'secret' })]) {
    const response = await managementFetch(ctx, 'state', request(body))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('SECRET_INVALID_JSON')
  }
  expect((await managementFetch(ctx, 'state', request(JSON.stringify(envelope), 'text/plain'))).status).toBe(415)
  expect((await managementFetch(ctx, 'state', request('x'.repeat(256 * 1024 + 1)))).status).toBe(413)
  expect((await managementFetch(ctx, 'state', request('中'.repeat(100_000)))).status).toBe(413)
})

it('uses real Harness HTTP authentication and removes routes with its consumer fiber', async () => {
  const { ctx, root } = await setup()
  const [{ default: Credentials }, { default: WebServer }, Connection, Management] = await Promise.all([
    import('@deepseek-ai/dsh-credentials-local'), import('@deepseek-ai/dsh-host-webserver'),
    import('@deepseek-ai/dsh-client-connection'), import('../src/management.ts'),
  ])
  await ctx.plugin(Credentials, { dshHome: root, watch: false })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection, {})
  const consumer = ctx.plugin(Management)
  await consumer
  ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('ready') }
  } })
  const base = `http://127.0.0.1:${ctx.webServer.port}/`
  const body = JSON.stringify({ type: 'client-request', rpcId: 'http-fixture', method: 'memory-management/state', payload: { agentId: 'default' } })
  const request = (headers: Record<string, string> = {}) => fetch(`${base}api/memory-management/state`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
  })
  expect((await request()).status).toBe(401)
  expect((await request({ origin: 'https://foreign.invalid' })).status).toBe(403)
  const login = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  await login.arrayBuffer()
  const allowed = await request({ cookie })
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toMatchObject({ rpcId: 'http-fixture', result: { ok: true, value: { counts: { records: 0 } } } })
  await consumer.dispose()
  expect((await request({ cookie })).status).toBe(404)
})

it('keeps memory usable when the optional management consumer has no Web services', async () => {
  const { ctx } = await setup()
  const Management = await import('../src/management.ts')
  const consumer = ctx.plugin(Management)
  const receipt = await ctx.memory.add({ scope, content: 'Headless memory remains available' })
  expect(receipt.status).toBe('completed')
  expect(ctx.memory.inspect(scope).counts.recallable).toBe(1)
  await consumer.dispose()
  expect((await ctx.memory.search({ scope, query: 'Headless' })).channels.normal).toHaveLength(1)
})
