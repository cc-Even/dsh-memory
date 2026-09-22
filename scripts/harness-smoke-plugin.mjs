/** Test-only probe copied into an isolated profile, resolving the Host's own packages. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'memory-integration-probe'
export const inject = ['memory', 'tools', 'agents', 'agentLoop', 'llm', 'agentDefaultModel', 'settings', 'webRuntime', 'connection']

const CODE = '琥珀灯塔-7319'
const FACT = `我的联调项目叫星桥，部署代号是${CODE}。`
const TOOL_NAMES = ['memory_add', 'memory_forget', 'memory_list', 'memory_search']

class OfflineAdapter extends LlmAdapter {
  calls = []
  async *stream(options) {
    this.calls.push(options)
    let text = CODE
    if (options.system?.startsWith('You extract')) {
      text = JSON.stringify({ basicProfilePatch: {}, facts: [{
        clientRef: 'smoke-fact', content: FACT, layer: 'l2_fact', tags: ['星桥'], confidence: 1, evidenceTurnIndexes: [0],
      }], identities: [] })
    } else if (options.system?.startsWith('You reconcile')) {
      const prompt = options.messages.flatMap(message => message.content).find(block => block.type === 'text').text
      const sources = JSON.parse(prompt.split('\n').find(line => line.startsWith('SOURCES=')).slice(8))
      text = JSON.stringify({ operations: sources.map(input => ({
        type: 'NOOP', sourceRef: input.source.clientRef, duplicateOf: input.candidateIds[0],
      })) })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export async function apply(ctx) {
  let disposed = false
  ctx.effect(() => () => { disposed = true })
  const phase = process.env.DSH_MEMORY_SMOKE_PHASE
  const live = process.env.DSH_MEMORY_SMOKE_LIVE === '1'
  const reportPath = process.env.DSH_MEMORY_SMOKE_REPORT
  assert.ok(['capture', 'recall'].includes(phase), 'invalid smoke phase')
  assert.ok(reportPath, 'missing smoke report path')
  let handle
  let stage = 'activate'
  try {
    assert.equal(ctx.memory.health().ready, true, 'memory did not activate')
    assert.equal(ctx.memory.config.provider, undefined, 'bundle must follow the live default instead of freezing its route')
    const adapter = live ? undefined : new OfflineAdapter()
    if (adapter) {
      ctx.llm.registerAdapter(['memory-smoke-initial', 'memory-smoke-selected'], adapter)
      await ctx.agentDefaultModel.saveSelection({ provider: 'memory-smoke-selected', model: 'smoke' })
      assert.equal(ctx.agentDefaultModel.currentSelection().provider, 'memory-smoke-selected', 'default settings did not update')
    }
    const selection = ctx.agentDefaultModel.currentSelection()
    // Adapter registration may still be finishing in a sibling plugin.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (disposed) return
      if (ctx.llm.listProviders().some(provider => provider.id === selection.provider)) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (disposed) return
    assert.ok(ctx.llm.listProviders().some(provider => provider.id === selection.provider), `provider did not activate: ${selection.provider}`)
    stage = 'create-agent'
    handle = await ctx.agents.create({
      sessionId: SessionId(`memory-smoke-${phase}`),
      agentOptions: { ...selection, maxTokens: 1024 },
      setup(agentCtx) { agentCtx.tools.restrict({ allow: TOOL_NAMES }) },
    })
    const agent = handle.agent
    const scope = ctx.memory.scopeFor(agent)
    assert.deepEqual(ctx.tools.schemas(agent).map(tool => tool.name).sort(), TOOL_NAMES)
    if (phase === 'recall') {
      assert.ok(ctx.memory.export(scope).some(record => record.content.includes(CODE) && record.layer === 'l2_fact'), 'cold restart lost the captured fact')
    }
    stage = 'agent-turn'
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{
      type: 'text',
      text: phase === 'capture'
        ? `请记住这个明确的项目事实：${FACT}请只答“已记住”，本轮不要调用工具。`
        : '星桥项目的部署代号是什么？请只回复代号。',
    }] }))
    await agent.whenIdle()
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    assert.equal(end?.data.reason.kind, 'completed', `agent turn did not complete (${end?.data.reason.error?.code ?? 'no error code'})`)
    const records = ctx.memory.export(scope)
    const raw = records.find(record => record.idempotencyKey === `${agent.session.id}:turn:1`)
    assert.ok(raw, 'turn hook did not persist raw evidence')
    assert.ok(!raw.content.includes('<memory-recall>'), 'capture fed recall back into raw memory')
    stage = 'extraction-receipt'
    const receipt = await ctx.memory.add({ scope, content: raw.content, mode: 'extract', idempotencyKey: raw.idempotencyKey })
    assert.equal(receipt.status, 'completed', 'automatic extraction degraded')
    assert.ok(records.some(record => record.layer === 'l2_fact' && record.content.includes(CODE)), 'no extracted fact')
    if (adapter) {
      assert.ok(adapter.calls.filter(call => call.system?.startsWith('You extract'))
        .every(call => call.provider === 'memory-smoke-selected'), `extraction retained the startup model: ${JSON.stringify(adapter.calls.map(call => ({ provider: call.provider, model: call.model, extraction: call.system?.startsWith('You extract') })))}`)
    }
    if (phase === 'recall') {
      assert.ok(JSON.stringify(agent.session.snapshotEvents()).includes('<memory-recall>'), 'recall was absent from the Session surface')
      const answer = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
      assert.ok(answer?.data.message.content.some(block => block.type === 'text' && block.text.includes(CODE)), 'new session did not answer with the remembered code')
    }
    stage = 'tool-search'
    const search = await ctx.tools.execute({
      agent, signal: new AbortController().signal, callId: ToolCallId('smoke-search'),
      name: 'memory_search', arguments: { query: '星桥 部署代号' },
    })
    assert.equal(search.isError, false, 'memory_search failed')
    assert.ok(JSON.stringify(search.value).includes(CODE), 'memory_search missed the fact')
    stage = 'authenticated-web'
    const baseUrl = process.env.DSH_MEMORY_SMOKE_BASE_URL
    const login = await fetch(ctx.connection.authenticatedUrl(baseUrl), { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, 'Web token exchange did not establish a browser session')
    await login.arrayBuffer()
    const page = await fetch(baseUrl, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
    assert.equal(page.status, 200, 'authenticated Web frontend was not available')
    await page.arrayBuffer()
    const report = { phase, mode: live ? 'live' : 'offline', model: selection.model, tools: TOOL_NAMES, rawPersisted: true, extracted: true, recalled: phase === 'recall', webHttp: page.status }
    stage = 'dispose-agent'
    await handle.dispose()
    handle = undefined
    await writeFile(reportPath, JSON.stringify(report), { mode: 0o600 })
  } catch (error) {
    if (disposed) return
    // Report only assertion labels; provider responses and credentials never enter reports.
    await writeFile(reportPath, JSON.stringify({ phase, failed: true, reason: error.code === 'ERR_ASSERTION' ? error.message : `integration probe failed at ${stage} (${error.name}, ${error.code ?? 'no code'})` }), { mode: 0o600 })
    throw error
  } finally {
    await handle?.dispose()
  }
}
