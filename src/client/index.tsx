/** Harness Settings section; runtime imports are limited to shared React. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useEffect, useState } from 'react'
import type { ManagedMemory, ManagementMutationResult, ManagementState, MemoryDetail, MemoryPage } from '../management-types.ts'
import { styles } from './styles.ts'

type Call = <T>(endpoint: string, payload: object, signal?: AbortSignal) => Promise<T>
export const inject = ['slots', 'connection']
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const call: Call = async <T,>(endpoint: string, payload: object, signal?: AbortSignal): Promise<T> => {
    const response = await connection.rpc.call('/api', `memory-management/${endpoint}`, payload, signal)
    if (!response.ok) throw new Error(response.error.message)
    return response.value as T
  }
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = styles
    document.head.append(style)
    return () => style.remove()
  }, 'memory-management.styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'memory', order: 25, label: () => '记忆', inject: () => ({ call }),
  }, MemoryPanel))
}
const layers: Record<string, string> = { l0_basic_info: '基本信息', l1_raw: '原始证据', l2_fact: '事实', l3_summary: '摘要', l4_identity: '身份与偏好' }
const statuses: Record<string, string> = { active: '有效', superseded: '已更新', archived: '已归档', deleted: '已删除' }
const jobLabels = { accepted: '处理中', completed: '已完成', degraded: '已降级' }
const time = (value?: string) => value ? new Date(value).toLocaleString() : '历史记录：无时间信息'
const safeError = (error: unknown) => error instanceof Error && ['请求参数或目标记忆无效。', '记忆已发生变化，请刷新后重试。', '记忆存储暂不可用，请稍后重试。', '原始证据未能保存，请稍后重试。'].includes(error.message)
  ? error.message : '无法连接记忆服务，请刷新重试。'

/** Owner-scoped memory browser with explicit human review before writes. */
export function MemoryPanel({ call }: { call: Call }) {
  const [agents, setAgents] = useState<string[]>([])
  const [agentId, setAgent] = useState('default')
  const [tab, setTab] = useState<'records' | 'diagnostics'>('records')
  const [state, setState] = useState<ManagementState>()
  const [page, setPage] = useState<MemoryPage>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<MemoryDetail>()
  const [q, setQuery] = useState('')
  const [layer, setLayer] = useState('')
  const [status, setStatus] = useState('active')
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [action, setAction] = useState<'confirm' | 'correct' | 'forget'>()
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [mutationKey, setMutationKey] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void call<{ agents: string[] }>('scopes', {}, controller.signal).then(result => {
      if (!controller.signal.aborted) setAgents(result.agents)
    }).catch(error => { if (!controller.signal.aborted) setError(safeError(error)) })
    return () => controller.abort()
  }, [call, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setPage(undefined); setState(undefined)
    void Promise.all([
      call<ManagementState>('state', { agentId }, controller.signal),
      call<MemoryPage>('list', { agentId, q, offset, limit: 25, ...(layer ? { layer } : {}), ...(status ? { status } : {}) }, controller.signal),
    ]).then(([snapshot, records]) => {
      if (controller.signal.aborted) return
      setState(snapshot); setPage(records)
    }).catch(error => { if (!controller.signal.aborted) setError(safeError(error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [call, agentId, q, layer, status, offset, refresh])
  useEffect(() => {
    const controller = new AbortController()
    setDetail(undefined); setAction(undefined)
    if (selected) void call<MemoryDetail>('detail', { agentId, memoryId: selected }, controller.signal).then(result => {
      if (!controller.signal.aborted) setDetail(result)
    }).catch(error => { if (!controller.signal.aborted) setError(safeError(error)) })
    return () => controller.abort()
  }, [call, agentId, selected, refresh])

  const select = (id: string) => { setSelected(id); setNotice(''); setAction(undefined) }
  const begin = (next: 'confirm' | 'correct' | 'forget') => {
    setContent(detail?.record.content ?? ''); setAction(next); setMutationKey(crypto.randomUUID()); setError('')
  }
  const mutate = async () => {
    if (!detail || !action) return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await call<ManagementMutationResult>('mutate', {
        agentId, memoryId: detail.record.id, expectedRevision: detail.revision, action,
        ...(action === 'forget' ? {} : { idempotencyKey: mutationKey }),
        ...(action === 'correct' ? { content } : {}),
      })
      if ('status' in result) {
        setNotice(result.status === 'degraded' ? '证据已保存，但新版本处理失败；旧记忆保持有效。请查看诊断。' : '已保存新版本，旧版本和证据已保留。')
        if (result.createdMemoryIds[0]) setSelected(result.createdMemoryIds[0])
      } else setNotice('记忆已软删除，不再参与召回；历史记录仍保留。')
      setAction(undefined); setRefresh(value => value + 1)
    } catch (error) { setError(safeError(error)) }
    finally { setBusy(false) }
  }
  return <section className="dsh-memory" aria-label="记忆管理">
    <header className="dm-heading"><div><span className="dm-eyebrow">DSH MEMORY</span><h2>让记忆清晰可见</h2><p>查看记住了什么、来自哪里，以及最近的处理状态。</p></div>
      <button disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>刷新</button></header>
    <div className="dm-toolbar"><label>智能体预设 <select aria-label="智能体预设" value={agentId} disabled={busy} onChange={event => { setAgent(event.target.value); setOffset(0); setSelected(undefined); setNotice('') }}>
      {(agents.length ? agents : ['default']).map(agent => <option key={agent} value={agent}>{agent === 'default' ? '默认智能体' : agent}</option>)}</select></label><span className="dm-muted">当前本机所有者 · 跨会话记忆</span></div>
    {error && <div role="alert" className="dm-alert">{error} <button disabled={busy} onClick={() => setRefresh(value => value + 1)}>重新加载</button></div>}
    {notice && <div role="status" className="dm-notice">{notice}</div>}
    <div className="dm-stats" aria-label="记忆状态">
      {[['可召回', state?.counts.recallable], ['全部记录', state?.counts.records], ['写入完成', state?.counts.jobs.completed], ['写入降级', state?.counts.jobs.degraded]].map(([label, value]) => <div key={label} className="dm-stat"><span>{label}</span><strong>{value ?? '—'}</strong></div>)}
    </div>
    <div className="dm-tabs" role="tablist" aria-label="记忆视图">
      <button role="tab" aria-selected={tab === 'records'} onClick={() => setTab('records')}>记忆管理</button>
      <button role="tab" aria-selected={tab === 'diagnostics'} onClick={() => setTab('diagnostics')}>状态与诊断</button>
    </div>
    {loading && <p role="status">正在读取记忆…</p>}
    {tab === 'records' ? <div role="tabpanel">
      <div className="dm-filters"><input aria-label="搜索记忆" placeholder="搜索内容或标签…" maxLength={200} value={q} disabled={busy} onChange={event => { setQuery(event.target.value); setOffset(0) }} />
        <select aria-label="记忆类型" value={layer} disabled={busy} onChange={event => { setLayer(event.target.value); setOffset(0) }}><option value="">所有类型</option>{Object.entries(layers).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <select aria-label="记忆状态筛选" value={status} disabled={busy} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="">所有状态</option>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      <div className="dm-browser"><div className="dm-list">
        {page?.records.length === 0 && <div className="dm-empty">没有符合条件的记忆。<small>可调整筛选，或在对话中让助手记住一条信息。</small></div>}
        {page?.records.map(record => <button className={`dm-row ${record.id === selected ? 'dm-selected' : ''}`} key={record.id} disabled={busy} onClick={() => select(record.id)}><div><span className="dm-badge">{layers[record.layer]}</span><span className="dm-muted">{statuses[record.status]} · v{record.revision}</span></div><p>{record.content}</p><small>{time(record.updatedAt)}</small></button>)}
        {page && <div className="dm-pagination"><button disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>上一页</button><span>{page.total} 条 · 第 {Math.floor(offset / 25) + 1} 页</span><button disabled={busy || offset + 25 >= page.total} onClick={() => setOffset(offset + 25)}>下一页</button></div>}
      </div><aside className="dm-detail" aria-label="记忆详情">
        {!detail ? <div className="dm-empty">{selected ? '正在读取详情…' : '选择一条记忆，查看来源与历史。'}</div> : <>
          <div className="dm-detail-heading"><h3>{layers[detail.record.layer]} <small>v{detail.record.revision}</small></h3><span className="dm-badge">{statuses[detail.record.status]}</span></div>
          <p className="dm-content">{detail.record.content}</p>
          <dl><dt>可信度</dt><dd>{Math.round(detail.record.confidence * 100)}%</dd><dt>来源</dt><dd>{detail.record.sourceType === 'explicit' ? '明确记录' : '模型推断 / 综合'}</dd><dt>召回权限</dt><dd>{detail.record.visibility === 'recallable' ? '可召回（还须有效且未过期）' : '仅作为证据'}</dd><dt>更新时间</dt><dd>{time(detail.record.updatedAt)}</dd>{detail.record.tags.length > 0 && <><dt>标签</dt><dd>{detail.record.tags.join(' · ')}</dd></>}</dl>
          <div className="dm-actions">
            <button disabled={busy || !editable(detail.record)} onClick={() => begin('confirm')}>确认记忆</button>
            <button disabled={busy || !editable(detail.record)} onClick={() => begin('correct')}>更正</button>
            <button className="dm-danger" disabled={busy || detail.record.status === 'deleted'} onClick={() => begin('forget')}>软删除</button>
          </div>
          {!editable(detail.record) && <small className="dm-muted">只有当前有效的事实、身份与偏好可确认或更正。</small>}
          {action && <form className="dm-confirm" aria-label="确认操作" onSubmit={event => { event.preventDefault(); void mutate() }}>
            <strong>{action === 'forget' ? '确认软删除这条记忆？' : action === 'confirm' ? '确认这条记忆准确？' : '更正记忆内容'}</strong>
            <p>{action === 'forget' ? '不再参与召回。删除原始证据也会删除失去全部来源的派生记忆。此操作不擦除历史数据。' : '将保存新证据与新版本，原有版本保持可追溯。'}</p>
            {action === 'correct' && <textarea autoFocus aria-label="更正内容" rows={5} value={content} maxLength={state?.policy.maxRecordChars ?? 4000} disabled={busy} onChange={event => { setContent(event.target.value); setMutationKey(crypto.randomUUID()) }} />}
            <div className="dm-actions"><button type="submit" className="dm-primary" disabled={busy || (action === 'correct' && !content.trim())}>{busy ? '保存中…' : '确认执行'}</button><button type="button" disabled={busy} onClick={() => setAction(undefined)}>取消</button></div>
          </form>}
          <Related title="来源证据" records={detail.evidence} select={select} disabled={busy} />
          <Related title="版本历史" records={detail.history} select={select} disabled={busy} />
        </>}
      </aside></div>
    </div> : <div role="tabpanel" className="dm-diagnostics">
      {state && <><div className="dm-policy"><span>自动捕获：{state.policy.autoCapture ? '已开启' : '已关闭'}</span><span>自动召回：{state.policy.autoRecall ? '已开启' : '已关闭'}</span><span>检索：{state.policy.embeddingQuality === 'portable-hash' ? '本地哈希 + BM25' : '语义向量 + BM25'}</span></div>
        <h3>最近写入 <small>持久化 · 最近 30 条</small></h3><p className="dm-muted">降级表示原始证据已保存，但抽取、调和或嵌入未完成。调用次数为逻辑模型调用，不含底层重试。</p>
        {state.jobs.length === 0 && <p className="dm-empty">暂无写入记录。</p>}
        <div className="dm-table-wrap"><table><thead><tr><th>状态</th><th>时间</th><th>耗时 / 调用</th><th>诊断</th><th>证据</th></tr></thead><tbody>{state.jobs.map(job => <tr key={job.jobId}><td><span className={`dm-badge ${job.status === 'degraded' ? 'dm-warning' : ''}`}>{jobLabels[job.status]}</span></td><td>{time(job.startedAt)}</td><td>{job.durationMs === undefined ? '—' : `${job.durationMs} ms`} / {job.modelCalls ?? '—'}</td><td>{job.code ?? '—'}</td><td><button disabled={busy} onClick={() => { select(job.rawMemoryId); setTab('records') }}>查看</button></td></tr>)}</tbody></table></div>
        <h3>最近召回 <small>本次运行 · 最近 20 次</small></h3><p className="dm-muted">仅列出实际注入模型上下文的记忆。进程重启后清空；诊断不保存查询原文。</p>
        {state.recalls.length === 0 && <p className="dm-empty">本次运行暂无自动召回记录。</p>}
        {state.recalls.map((recall, index) => <div className="dm-recall" key={`${recall.at}-${index}`}><div><strong>{recall.outcome === 'injected' ? `已注入 ${recall.memoryIds.length} 条` : recall.outcome === 'empty' ? '未注入记忆' : '召回失败'}</strong><small>{time(recall.at)} · {recall.durationMs} ms</small></div><div className="dm-actions">{recall.memoryIds.map((id, index) => <button key={id} disabled={busy} onClick={() => { select(id); setTab('records') }}>记忆 {index + 1}</button>)}</div><small>{recall.code ?? recall.degradedChannels.join(' · ')}</small></div>)}
      </>}
    </div>}
  </section>
}
function editable(record: ManagedMemory): boolean {
  return record.status === 'active' && record.visibility === 'recallable' && ['l2_fact', 'l4_identity'].includes(record.layer)
}
function Related({ title, records, select, disabled }: { title: string; records: readonly ManagedMemory[]; select: (id: string) => void; disabled: boolean }) {
  return <div className="dm-related"><h4>{title} <small>{records.length}</small></h4>{records.length === 0 ? <p className="dm-muted">暂无记录</p> : records.map(record => <button disabled={disabled} key={record.id} onClick={() => select(record.id)}><span>{statuses[record.status]} · v{record.revision}</span><p>{record.content}</p></button>)}</div>
}
