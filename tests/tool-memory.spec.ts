import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MemoryCapability, MemoryId, MemoryScope } from '../src/types.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolMemory from '../src/tool.ts'

const contexts: Context[] = []
let call = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function agent(): Agent {
  const id = SessionId('memory-tool-agent')
  return { id, session: Session.create(id) } as unknown as Agent
}

async function setup(): Promise<{
  ctx: Context
  memory: MemoryCapability
  add: ReturnType<typeof vi.fn>
  disposeTool: () => Promise<void>
}> {
  const scope: MemoryScope = { userId: 'u', agentId: 'a', sessionId: 'memory-tool-agent' }
  const record = {
    id: 'memory-derived' as MemoryId,
    layer: 'l2_fact' as const,
    content: 'Project Northstar launches in October.',
    confidence: 1,
    tags: ['project'],
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }
  const add = vi.fn(async () => ({
    requestId: 'request',
    jobId: 'job',
    rawMemoryId: 'memory-raw',
    status: 'completed' as const,
    createdMemoryIds: ['memory-derived'],
    warnings: [],
  }))
  const memory = {
    scopeFor: vi.fn(() => scope),
    add,
    search: vi.fn(async () => ({
      requestId: 'search',
      channels: {
        profile: [],
        normal: [{ memory: record, score: 1, matchedBy: ['lexical'] }],
      },
      diagnostics: { intent: 'factual' as const, confidence: 1, degradedChannels: ['semantic:portable-hash'] },
    })),
    get: vi.fn(),
    list: vi.fn(() => [record]),
    forget: vi.fn(async (memoryId: MemoryId) => ({ forgotten: true, memoryId, affectedMemoryIds: [memoryId] })),
    export: vi.fn(() => []),
    import: vi.fn(async () => 0),
    health: vi.fn(() => ({
      ready: true,
      records: 1,
      scopes: 1,
      embeddingSpaceId: 'test',
      capabilities: {
        transactions: true as const,
        semanticSearch: true as const,
        lexicalSearch: true as const,
        preFilter: true as const,
        durableJobs: true as const,
      },
    })),
  } as unknown as MemoryCapability
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('memory', memory as never)
  const fiber = await ctx.plugin(ToolMemory)
  return { ctx, memory, add, disposeTool: fiber.dispose }
}

function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`memory-call-${++call}`),
    name,
    arguments: args,
    agent: agent(),
  })
}

describe('dsh-tool-memory', () => {
  it('registers the four explicit memory tools', async () => {
    const { ctx, disposeTool } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'memory_add',
      'memory_forget',
      'memory_list',
      'memory_search',
    ])
    await disposeTool()
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('maps add and search calls to canonical compact results', async () => {
    const { ctx, add } = await setup()
    const added = await execute(ctx, 'memory_add', {
      content: 'Project Northstar launches in October.',
      layer: 'l2_fact',
      tags: ['project'],
      idempotency_key: 'northstar',
    })
    expect(added.isError).toBe(false)
    if (added.isError) throw new Error('expected memory_add success')
    expect(added.value).toMatchObject({ status: 'completed', rawMemoryId: 'memory-raw' })
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'direct',
      idempotencyKey: 'northstar',
    }), expect.any(AbortSignal))

    const searched = await execute(ctx, 'memory_search', { query: 'Northstar' })
    expect(searched.isError).toBe(false)
    if (searched.isError) throw new Error('expected memory_search success')
    expect(searched.value).toMatchObject({
      normal: [{ id: 'memory-derived', content: 'Project Northstar launches in October.' }],
      intent: 'factual',
    })
  })
})
