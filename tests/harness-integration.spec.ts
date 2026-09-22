import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SettingsFile from '@deepseek-ai/dsh-settings-file'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import MemoryService, { resolveConfig, type Config } from '../src/index.ts'
import * as MemoryTools from '../src/tool.ts'

const contexts: Context[] = []
const roots: string[] = []
const FACT = 'The deployment codename is Jade Lantern.'
const owner = { userId: 'integration-user', agentId: 'default', sessionId: 'route-tests' }
const emptyExtraction = JSON.stringify({ basicProfilePatch: {}, facts: [], identities: [] })
const extraction = JSON.stringify({
  basicProfilePatch: {},
  facts: [{ clientRef: 'fact', content: FACT, layer: 'l2_fact', tags: ['deployment'], confidence: 1, evidenceTurnIndexes: [0] }],
  identities: [],
})

/** Fake only the model boundary; all runtime services and Agents are real. */
class IntegrationAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  respond: (options: GenerateOptions) => Promise<string | StreamChunk[]> = async () => emptyExtraction

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const response = await this.respond(options)
    if (typeof response !== 'string') {
      yield* response
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: response }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: response } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function rootDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'memory-harness-test-'))
  roots.push(root)
  return root
}

async function setup(options: { root?: string; config?: Partial<Config>; defaultModel?: boolean; automatic?: boolean } = {}) {
  const root = options.root ?? await rootDirectory()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: join(root, 'storage') })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(SettingsFile, { path: join(root, 'settings.yaml'), watch: false })
  const defaultFiber = options.defaultModel === false ? undefined : await ctx.plugin(AgentDefaultModel, {
    provider: 'route-a', model: 'model-a',
  })
  const adapter = new IntegrationAdapter()
  ctx.llm.registerAdapter(['route-a', 'route-b', 'fixed', 'chat'], adapter)
  await ctx.plugin(MemoryService, {
    userId: owner.userId,
    autoCapture: options.automatic ?? false,
    autoRecall: options.automatic ?? false,
    ...options.config,
  })
  await ctx.plugin(MemoryTools)
  return { ctx, root, adapter, defaultFiber }
}

function textOf(options: GenerateOptions): string {
  return options.messages.flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
}

async function send(ctx: Context, agent: Agent, text: string) {
  const idle = new Promise<void>(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await idle
  expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
}

describe('Harness model selection integration', () => {
  it('follows live default settings after startup and preserves raw-first/idempotency', async () => {
    const { ctx, adapter } = await setup()
    adapter.respond = async () => {
      expect(ctx.memory.export(owner).some(record => record.layer === 'l1_raw' && record.visibility === 'recallable')).toBe(true)
      return emptyExtraction
    }
    const first = await ctx.memory.add({ scope: owner, content: 'First turn', mode: 'extract', idempotencyKey: 'first' })
    expect(first.status).toBe('completed')
    await ctx.agentDefaultModel.saveSelection({ provider: 'route-b', model: 'model-b' })
    const second = await ctx.memory.add({ scope: owner, content: 'Second turn', mode: 'extract', idempotencyKey: 'second' })
    expect(second.status).toBe('completed')
    expect(adapter.calls.map(call => [call.provider, call.model])).toEqual([['route-a', 'model-a'], ['route-b', 'model-b']])
    expect(await ctx.memory.add({ scope: owner, content: 'Second turn', mode: 'extract', idempotencyKey: 'second' })).toEqual(second)
    expect(adapter.calls).toHaveLength(2)
  })

  it('keeps an explicit route fixed when the Harness default changes', async () => {
    const { ctx, adapter } = await setup({ config: { provider: 'fixed', model: 'fixed-model' } })
    await ctx.agentDefaultModel.saveSelection({ provider: 'route-b', model: 'model-b' })
    expect((await ctx.memory.add({ scope: owner, content: 'Explicit routing', mode: 'extract' })).status).toBe('completed')
    expect(adapter.calls.map(call => [call.provider, call.model])).toEqual([['fixed', 'fixed-model']])
  })

  it('snapshots one route for extraction and reconciliation even if settings change during extraction', async () => {
    const { ctx, adapter } = await setup()
    const prior = await ctx.memory.add({ scope: owner, content: FACT })
    adapter.respond = async options => {
      if (options.system?.startsWith('You extract')) {
        await ctx.agentDefaultModel.saveSelection({ provider: 'route-b', model: 'model-b' })
        return extraction
      }
      return JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'fact', duplicateOf: prior.createdMemoryIds[0] }] })
    }
    expect((await ctx.memory.add({ scope: owner, content: FACT, mode: 'extract' })).status).toBe('completed')
    expect(adapter.calls.map(call => [call.provider, call.model])).toEqual([['route-a', 'model-a'], ['route-a', 'model-a']])
    adapter.respond = async () => emptyExtraction
    await ctx.memory.add({ scope: owner, content: 'Later turn', mode: 'extract' })
    expect(adapter.calls.at(-1)).toMatchObject({ provider: 'route-b', model: 'model-b' })
  })

  it('keeps direct writes usable without a default, degrades extraction, and recovers when a provider arrives', async () => {
    const { ctx, adapter } = await setup({ defaultModel: false })
    expect((await ctx.memory.add({ scope: owner, content: FACT })).status).toBe('completed')
    const receipt = await ctx.memory.add({ scope: owner, content: 'A model-independent raw record.', mode: 'extract' })
    expect(receipt.status).toBe('degraded')
    expect(receipt.warnings.join(' ')).toContain('agentDefaultModel')
    expect(ctx.memory.get(receipt.rawMemoryId, owner)).toMatchObject({ layer: 'l1_raw', visibility: 'recallable' })
    expect(adapter.calls).toEqual([])
    await ctx.plugin(AgentDefaultModel, { provider: 'route-b', model: 'model-b' })
    expect((await ctx.memory.add({ scope: owner, content: 'After provider recovery', mode: 'extract' })).status).toBe('completed')
    expect(adapter.calls[0]).toMatchObject({ provider: 'route-b', model: 'model-b' })
  })

  it('does not retain a vanished default service', async () => {
    const { ctx, defaultFiber } = await setup()
    await defaultFiber?.dispose()
    const receipt = await ctx.memory.add({ scope: owner, content: 'After default unload', mode: 'extract' })
    expect(receipt.status).toBe('degraded')
    expect(receipt.warnings.join(' ')).toContain('agentDefaultModel')
    expect(ctx.memory.health().ready).toBe(true)
  })

  it.each([{ provider: 'fixed' }, { model: 'fixed-model' }, { provider: '', model: 'm' }, { provider: 'p', model: ' ' }])(
    'rejects an incomplete or blank explicit route: %j', route => {
      expect(() => resolveConfig({ userId: owner.userId, ...route })).toThrow()
    },
  )
})

describe('model-visible structured output contract', () => {
  function outputSchema(call: GenerateOptions) {
    const line = textOf(call).split('\n').find(line => line.startsWith('OUTPUT_JSON_SCHEMA='))
    expect(line, 'the model must receive the complete output schema').toBeDefined()
    return JSON.parse(line!.slice('OUTPUT_JSON_SCHEMA='.length))
  }

  it('describes optional extraction fields with their actual types and omission rules', async () => {
    const { ctx, adapter } = await setup()
    adapter.respond = async () => extraction
    expect((await ctx.memory.add({ scope: owner, content: FACT, mode: 'extract' })).status).toBe('completed')
    const schema = outputSchema(adapter.calls[0]!)
    const item = schema.properties.facts.items
    expect(item.properties.occurredAt).toMatchObject({ type: 'string', format: 'date-time' })
    expect(item.properties.speculate).toMatchObject({ type: 'string', minLength: 1 })
    expect(item.properties.evidenceTurnIndexes.items).toMatchObject({ type: 'integer', minimum: 0 })
    expect(item.required).not.toContain('occurredAt')
    expect(item.required).not.toContain('speculate')
    expect(schema.properties.summary).toMatchObject({ type: 'string', minLength: 1 })
    expect(schema.required).not.toContain('summary')
  })

  it('describes every reconciliation operation and its required fields', async () => {
    const { ctx, adapter } = await setup()
    const prior = await ctx.memory.add({ scope: owner, content: FACT })
    adapter.respond = async options => options.system?.startsWith('You extract') ? extraction
      : JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'fact', duplicateOf: prior.createdMemoryIds[0] }] })
    expect((await ctx.memory.add({ scope: owner, content: FACT, mode: 'extract' })).status).toBe('completed')
    const schema = outputSchema(adapter.calls[1]!)
    const operations = schema.properties.operations.items.oneOf
    expect(Object.fromEntries(operations.map((operation: { properties: { type: { const: string } }; required: string[] }) =>
      [operation.properties.type.const, operation.required]))).toEqual({
      ADD: ['type', 'sourceRef'],
      NOOP: ['type', 'sourceRef', 'duplicateOf'],
      CONSOLIDATE: ['type', 'sourceRefs', 'targetIds', 'content'],
      SUPERSEDE: ['type', 'sourceRef', 'targetIds', 'content', 'reason'],
    })
  })

  it('still degrades invalid null/boolean fields while preserving raw evidence', async () => {
    const { ctx, adapter } = await setup()
    const invalid = JSON.parse(extraction)
    invalid.facts[0].occurredAt = null
    invalid.facts[0].speculate = false
    adapter.respond = async () => JSON.stringify(invalid)
    const receipt = await ctx.memory.add({ scope: owner, content: FACT, mode: 'extract', idempotencyKey: 'invalid-fields' })
    expect(receipt.status).toBe('degraded')
    expect(ctx.memory.get(receipt.rawMemoryId, owner)).toMatchObject({ content: FACT, visibility: 'recallable' })
    expect(ctx.memory.list({ scope: owner, layers: ['l2_fact'] })).toEqual([])
    expect(await ctx.memory.add({ scope: owner, content: FACT, mode: 'extract', idempotencyKey: 'invalid-fields' })).toEqual(receipt)
    expect(adapter.calls).toHaveLength(1)
  })
})

describe('real Agent turns and cold restart', () => {
  it('executes a memory tool, captures the turn, recalls in another session, and survives restart without self-capture', async () => {
    const first = await setup({ automatic: true, config: { provider: 'route-a', model: 'model-a' } })
    let invoked = false
    first.adapter.respond = async options => {
      if (options.system?.startsWith('You extract')) return extraction
      if (options.system?.startsWith('You reconcile')) {
        const candidate = first.ctx.memory.list({ scope: owner }).find(record => record.layer === 'l2_fact')
        return JSON.stringify({ operations: [{ type: 'NOOP', sourceRef: 'fact', duplicateOf: candidate?.id }] })
      }
      if (!invoked) {
        invoked = true
        return [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('store-fact'), name: 'memory_add', arguments: JSON.stringify({ content: FACT, idempotency_key: 'explicit-fact' }) } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ]
      }
      return 'Recorded.'
    }
    const handle = await first.ctx.agents.create({
      sessionId: SessionId('capture-session'), agentOptions: { provider: 'chat', model: 'chat-model' },
    })
    await send(first.ctx, handle.agent, `Remember: ${FACT}`)
    const scope = first.ctx.memory.scopeFor(handle.agent)
    expect(handle.agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true)
    const saved = first.ctx.memory.export(scope)
    const fact = saved.find(record => record.layer === 'l2_fact')
    expect(fact).toMatchObject({ content: FACT, sourceMemoryIds: expect.any(Array) })
    expect(fact?.sourceMemoryIds).toHaveLength(2)
    const captured = saved.find(record => record.idempotencyKey === 'capture-session:turn:1')
    expect(captured?.content).toContain('Remember:')
    expect(captured?.content).not.toContain('Stored memory')
    await handle.dispose()
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await setup({ root: first.root, automatic: true, config: { provider: 'route-a', model: 'model-a' } })
    second.adapter.respond = async options => options.system?.startsWith('You extract') ? emptyExtraction : 'Jade Lantern.'
    const next = await second.ctx.agents.create({
      sessionId: SessionId('recall-session'), agentOptions: { provider: 'chat', model: 'chat-model' },
    })
    await send(second.ctx, next.agent, 'What is the deployment codename?')
    const chatRequest = second.adapter.calls.find(call => call.provider === 'chat')
    expect(chatRequest).toBeDefined()
    expect(textOf(chatRequest!)).toContain('<memory-recall>')
    expect(textOf(chatRequest!)).toContain(FACT)
    expect(JSON.stringify(next.agent.session.snapshotEvents())).toContain('<memory-recall>')
    const raw = second.ctx.memory.export(second.ctx.memory.scopeFor(next.agent))
      .find(record => record.idempotencyKey === 'recall-session:turn:1')
    expect(raw?.content).toContain('What is the deployment codename?')
    expect(raw?.content).not.toContain('<memory-recall>')
    expect((await second.ctx.memory.search({ scope: { ...scope, agentId: 'another-preset' }, query: 'Jade Lantern' })).channels.normal).toEqual([])

    for (const name of ['memory_search', 'memory_list', 'memory_forget']) {
      const result = await second.ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(name), name, agent: next.agent,
        arguments: name === 'memory_search' ? { query: 'Jade Lantern' } : name === 'memory_forget' ? { memory_id: fact?.id } : {},
      })
      expect(result.isError).toBe(false)
      if (!result.isError && name === 'memory_search') expect(JSON.stringify(result.value)).toContain(FACT)
      if (!result.isError && name === 'memory_forget') expect(result.value).toMatchObject({ forgotten: true })
    }
    expect((await second.ctx.memory.search({ scope, query: 'Jade Lantern' })).channels.normal
      .some(hit => hit.memory.id === fact?.id)).toBe(false)
    await next.dispose()
  })
})
