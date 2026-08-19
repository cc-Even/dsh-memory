/** Model-facing CRUD and hybrid-recall tools over `ctx.memory`. */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryId, MemoryLayer, MemoryRecord } from './types.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin name. */
export const name = 'tool-memory'
/** Required capability services. */
export const inject = ['memory', 'tools']

const LAYERS = ['l0_basic_info', 'l1_raw', 'l2_fact', 'l3_summary', 'l4_identity'] as const

const memorySummarySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    layer: { type: 'string', required: true, enum: [...LAYERS] },
    content: { type: 'string', required: true },
    confidence: { type: 'number', required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    createdAt: { type: 'string', required: true },
    updatedAt: { type: 'string', required: true },
  },
} as const

/** Register explicit memory write, search, list, and forget tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory_add',
    description: 'Store one explicit durable user fact or stable identity. Use only for information the user stated or explicitly asked you to remember; do not store secrets, guesses, task scratch state, or assistant-generated claims.',
    parameters: {
      content: { type: 'string', required: true, description: 'Self-contained fact or identity statement.' },
      layer: {
        type: 'string',
        enum: ['l2_fact', 'l4_identity'],
        description: 'l2_fact for events/changing facts; l4_identity for stable preferences, traits, or identity.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short topic tags.' },
      idempotency_key: { type: 'string', description: 'Stable retry key when repeating the same intended write.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['completed', 'degraded'] },
          rawMemoryId: { type: 'string', required: true },
          createdMemoryIds: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'completed'
          ? `Stored memory ${value.createdMemoryIds.join(', ')}.`
          : `Stored raw memory ${value.rawMemoryId} with degradation: ${value.warnings.join('; ')}`,
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_add requires an owning agent session')
      const receipt = await ctx.memory.add({
        scope: ctx.memory.scopeFor(exec.agent),
        content: args.content,
        mode: 'direct',
        layer: args.layer ?? 'l2_fact',
        tags: args.tags ?? [],
        ...(args.idempotency_key === undefined ? {} : { idempotencyKey: args.idempotency_key }),
      }, exec.signal)
      return {
        status: receipt.status,
        rawMemoryId: receipt.rawMemoryId,
        createdMemoryIds: [...receipt.createdMemoryIds],
        warnings: [...receipt.warnings],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search durable cross-session user memory. Use when prior preferences, facts, identity, or history may materially improve the answer. Treat results as fallible background and prefer the current user message on conflict.',
    parameters: {
      query: { type: 'string', required: true, description: 'Focused semantic or exact-match query.' },
      limit: { type: 'integer', description: 'Maximum normal-memory results.' },
      profile_limit: { type: 'integer', description: 'Maximum independently recalled profile results.' },
      session_only: { type: 'boolean', description: 'Restrict to the current Session instead of cross-session recall.' },
      include_evolution: { type: 'boolean', description: 'Include superseded history for matched chains.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          profile: { type: 'array', required: true, items: memorySummarySchema },
          normal: { type: 'array', required: true, items: memorySummarySchema },
          intent: { type: 'string', required: true, enum: ['navigational', 'factual', 'conceptual'] },
          confidence: { type: 'number', required: true },
          degradedChannels: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_search requires an owning agent session')
      const result = await ctx.memory.search({
        scope: ctx.memory.scopeFor(exec.agent),
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        ...(args.profile_limit === undefined ? {} : { profileLimit: args.profile_limit }),
        sessionOnly: args.session_only ?? false,
        includeEvolution: args.include_evolution ?? false,
      }, exec.signal)
      return {
        profile: result.channels.profile.map(hit => summarize(hit.memory)),
        normal: result.channels.normal.map(hit => summarize(hit.memory)),
        intent: result.diagnostics.intent,
        confidence: result.diagnostics.confidence,
        degradedChannels: [...result.diagnostics.degradedChannels],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'List recent durable memories for inspection. Prefer memory_search when looking for relevant information.',
    parameters: {
      layer: { type: 'string', enum: [...LAYERS] },
      limit: { type: 'integer' },
      session_only: { type: 'boolean' },
    },
    output: {
      schema: { type: 'array', items: memorySummarySchema },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('memory_list requires an owning agent session')
      const records = ctx.memory.list({
        scope: ctx.memory.scopeFor(exec.agent),
        statuses: ['active'],
        ...(args.layer === undefined ? {} : { layers: [args.layer as MemoryLayer] }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        sessionOnly: args.session_only ?? false,
      })
      return Promise.resolve(records.map(summarize))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Forget one exact durable memory after the user explicitly asks to remove it. Obtain the id from memory_search or memory_list; never infer an id.',
    parameters: {
      memory_id: { type: 'string', required: true, description: 'Exact memory id to delete.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'boolean', required: true },
          memoryId: { type: 'string', required: true },
          affectedMemoryIds: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.forgotten ? `Forgot memory ${value.memoryId}.` : `Memory ${value.memoryId} was not found.`,
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('memory_forget requires an owning agent session')
      const result = await ctx.memory.forget(args.memory_id as MemoryId, ctx.memory.scopeFor(exec.agent))
      return {
        forgotten: result.forgotten,
        memoryId: result.memoryId,
        affectedMemoryIds: [...result.affectedMemoryIds],
      }
    },
  }))
}

function summarize(record: MemoryRecord) {
  return {
    id: record.id,
    layer: record.layer as typeof LAYERS[number],
    content: record.content,
    confidence: record.confidence,
    tags: [...record.tags],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
