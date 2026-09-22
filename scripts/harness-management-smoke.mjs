/** Real packaged plugin + native authenticated Web UI + two cold Host processes. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { harness: { type: 'string' }, screenshot: { type: 'string' } } })
const harness = resolve(values.harness ?? process.env.DSH_HARNESS_DIR ?? join(repo, '../deepseek-harness'))
const cli = join(harness, 'apps/cli/lib/bin.js')
const { chromium } = await import(pathToFileURL(join(harness, 'apps/web/node_modules/playwright/index.mjs')).href)
const root = await mkdtemp(join(tmpdir(), 'memory-management-browser-'))
const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1' }
let browser
const secrets = [process.env.DASHSCOPE_API_KEY, process.env.DASHSCOPE_API_URL].filter(Boolean)
function safe(value) { for (const secret of secrets) value = value.replaceAll(secret, '[redacted]'); return value.replace(/([?&]token=)[^\s"&]+/g, '$1[redacted]').slice(-6000) }
async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-20000) })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180000)
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    assert.equal(code, 0, safe(output))
  } finally { clearTimeout(timer) }
}
async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const number = server.address().port
  await new Promise(resolve => server.close(resolve))
  return number
}
async function phase(patch, restart) {
  const base = `http://127.0.0.1:${await port()}/`
  const ready = join(root, 'ready.json')
  await rm(ready, { force: true })
  const child = spawn(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--port', new URL(base).port], {
    cwd: root, env: { ...env, DSH_MANAGEMENT_READY: ready, DSH_MANAGEMENT_BASE: base }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', exited = false
  let page
  const closed = new Promise(resolve => child.once('close', code => { exited = true; resolve(code) }))
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-20000) })
  try {
    let fixture
    for (let index = 0; index < 450; index++) {
      try { fixture = JSON.parse(await readFile(ready, 'utf8')); break } catch {}
      if (exited) throw new Error(safe(output))
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(fixture, `Host fixture did not activate: ${safe(output)}`)
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await fetch(base); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    const envelope = payload => JSON.stringify({ type: 'client-request', rpcId: 'memory-test', method: 'memory-management/state', payload })
    assert.equal((await fetch(`${base}api/memory-management/state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: envelope({ agentId: 'default' }) })).status, 401)
    assert.equal((await fetch(`${base}api/memory-management/state`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://untrusted.invalid' }, body: envelope({ agentId: 'default' }) })).status, 403)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    page = await context.newPage()
    page.setDefaultTimeout(15000)
    const browserErrors = []
    page.on('pageerror', error => browserErrors.push(error.message))
    page.on('dialog', dialog => { browserErrors.push(`unexpected dialog: ${dialog.type()}`); void dialog.dismiss() })
    await page.goto(fixture.url)
    for (const name of [/^(Continue|继续)$/, /^(Configure later|稍后配置)$/]) {
      const button = page.getByRole('button', { name })
      if (await button.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await button.click()
    }
    // Native settings shell uses the locale selected by the browser profile.
    await page.getByRole('button', { name: /^(Settings|设置)$/ }).click({ timeout: 30000 })
    await page.getByRole('button', { name: '记忆', exact: true }).click()
    const panel = page.getByRole('region', { name: '记忆管理' })
    await panel.getByText('让记忆清晰可见').waitFor()
    await panel.locator('.dm-row').first().waitFor()
    const rpc = async (endpoint, payload) => await page.evaluate(async ({ endpoint, payload }) => {
      const response = await fetch(`/api/memory-management/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'browser-test', method: `memory-management/${endpoint}`, payload }) })
      return (await response.json()).result
    }, { endpoint, payload })
    for (const endpoint of ['state', 'list', 'detail', 'mutate']) {
      const payload = endpoint === 'state' || endpoint === 'list' ? { agentId: 'default', userId: 'foreign-browser-owner' } : { agentId: 'default', memoryId: fixture.foreignId, ...(endpoint === 'mutate' ? { action: 'forget', expectedRevision: 0 } : {}) }
      assert.equal((await rpc(endpoint, payload)).ok, false, `${endpoint} leaked another owner`)
    }
    assert.ok(!(await panel.innerText()).includes('FOREIGN_OWNER_SECRET'))
    await panel.getByRole('tab', { name: '状态与诊断' }).click()
    await panel.getByText('EXTRACTION_FAILED', { exact: true }).waitFor()
    await panel.getByRole('tab', { name: '记忆管理', exact: true }).click()
    await panel.getByLabel('记忆类型', { exact: true }).selectOption('l2_fact')
    if (!restart) {
      await panel.locator('.dm-row').filter({ hasText: '事实' }).filter({ hasText: 'TypeScript' }).click()
      await panel.getByRole('button', { name: '确认记忆', exact: true }).click()
      await panel.getByRole('button', { name: '确认执行', exact: true }).click()
      await panel.getByText('已保存新版本，旧版本和证据已保留。', { exact: true }).waitFor()
      await panel.getByRole('button', { name: '更正', exact: true }).click()
      await panel.getByLabel('更正内容', { exact: true }).fill('我的偏好是 Rust，原来的 TypeScript 偏好已更新。')
      await panel.getByRole('button', { name: '确认执行', exact: true }).click()
      await panel.locator('.dm-detail .dm-content').filter({ hasText: 'Rust' }).waitFor()
      assert.ok((await panel.getByRole('complementary', { name: '记忆详情' }).innerText()).includes('v3'))
      assert.equal(await panel.locator('img').count(), 0, 'memory content was interpreted as HTML')
      if (values.screenshot) {
        const path = resolve(values.screenshot)
        await mkdir(dirname(path), { recursive: true })
        await page.screenshot({ path, fullPage: true })
      }
      await page.setViewportSize({ width: 700, height: 950 })
      assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 2), true, 'memory panel overflows at narrow width')
      await page.setViewportSize({ width: 1440, height: 1000 })
    } else {
      await panel.locator('.dm-row').filter({ hasText: '事实' }).filter({ hasText: 'Rust' }).click()
      await panel.getByRole('button', { name: '软删除', exact: true }).click()
      await panel.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal((await rpc('list', { agentId: 'default', layer: 'l2_fact', status: 'active' })).value.total, 1)
      await panel.getByRole('button', { name: '软删除', exact: true }).click()
      await panel.getByRole('button', { name: '确认执行', exact: true }).click()
      await panel.getByText('记忆已软删除，不再参与召回；历史记录仍保留。').waitFor()
      await panel.getByLabel('记忆状态筛选', { exact: true }).selectOption('deleted')
      await panel.locator('.dm-row').filter({ hasText: 'Rust' }).waitFor()
      assert.equal((await rpc('list', { agentId: 'default', layer: 'l2_fact', status: 'active' })).value.total, 0)
    }
    assert.deepEqual(browserErrors, [], `Browser errors: ${safe(JSON.stringify(browserErrors))}`)
    await context.close()
    console.log(`PASS: ${restart ? 'cold restart, persisted revisions, cancel and soft deletion' : 'native Settings section, safe content, confirm, correction, diagnostics, responsive layout'}; HTTP 401/403 and owner isolation`)
  } catch (error) {
    if (page) {
      if (values.screenshot) await page.screenshot({ path: `${resolve(values.screenshot)}.failed.png`, fullPage: true }).catch(() => {})
      output += `\nPage buttons: ${JSON.stringify(await page.getByRole('button').allTextContents().catch(() => []))}`
    }
    throw new Error(`${safe(error.stack ?? String(error))} cause=${safe(String(error.cause))}\nHost: ${safe(output)}`)
  } finally {
    if (!exited) child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 10000)
    try { await closed } finally { clearTimeout(kill) }
  }
}
try {
  await run('pnpm', ['run', 'build'], repo)
  const tarball = join(root, 'memory.tgz')
  await run('pnpm', ['pack', '--out', tarball], repo)
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '--config.auto-install-peers=false', tarball])
  const probe = join(env.DSH_HOME, 'profiles/web/management-probe.mjs')
  await copyFile(join(repo, 'scripts/harness-management-probe.mjs'), probe)
  const patch = join(root, 'management.patch.yml')
  await writeFile(patch, `- id: agent-default-model\n  config:\n    provider: missing-fixture\n    model: fixture\n- insert:\n    - id: management-probe\n      name: ${JSON.stringify(probe)}\n`)
  browser = await chromium.launch({ headless: true })
  await phase(patch, false)
  await phase(patch, true)
} catch (error) {
  console.error(safe(error.stack ?? String(error)))
  process.exitCode = 1
} finally {
  await browser?.close()
  await rm(root, { recursive: true, force: true })
}
