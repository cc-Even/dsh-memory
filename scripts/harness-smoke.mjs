/** Build/install the real bundle, run two Host processes, then remove the isolated home. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { harness: { type: 'string' }, live: { type: 'boolean', default: false } } })
const harness = resolve(values.harness ?? process.env.DSH_HARNESS_DIR ?? join(repo, '../deepseek-harness'))
const cli = join(harness, 'apps/cli/lib/bin.js')
const version = JSON.parse(await readFile(join(harness, 'package.json'), 'utf8')).version
assert.equal(version, '0.1.5-rc.2', 'this integration fixture targets Harness 0.1.5-rc.2')
if (values.live) {
  for (const key of ['DASHSCOPE_API_KEY', 'DASHSCOPE_API_URL']) assert.ok(process.env[key], `${key} is required for --live`)
}
const root = await mkdtemp(join(tmpdir(), 'dsh-memory-smoke-'))
const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1' }
// The test's cwd is empty so project instructions and .env files cannot reach the model.
const secrets = [process.env.DASHSCOPE_API_KEY, process.env.DASHSCOPE_API_URL].filter(Boolean)
function safe(text) {
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
  return text.slice(-4000)
}

async function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32000) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180000)
  let code
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  } finally { clearTimeout(timeout) }
  if (code !== 0) throw new Error(`${command} exited ${code}: ${safe(output)}`)
  return output
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function phase(name, patch) {
  const reportPath = join(root, `${name}.json`)
  const port = await freePort()
  const args = [cli, '--profile', 'web', '--patch', patch, '--port', String(port)]
  const child = spawn(process.execPath, args, {
    cwd: root, env: { ...env, DSH_MEMORY_SMOKE_PHASE: name, DSH_MEMORY_SMOKE_LIVE: values.live ? '1' : '0', DSH_MEMORY_SMOKE_REPORT: reportPath, DSH_MEMORY_SMOKE_BASE_URL: `http://127.0.0.1:${port}/` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let exited = false
  let spawnError
  child.once('error', error => { spawnError = error; exited = true })
  const closed = new Promise(resolve => child.once('close', code => { exited = true; resolve(code) }))
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-32000) })
  try {
    const deadline = Date.now() + (values.live ? 180000 : 45000)
    while (Date.now() < deadline) {
      let report
      try { report = JSON.parse(await readFile(reportPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
      if (report) {
        assert.ok(!report.failed, `${report.reason}\n${safe(output)}`)
        assert.equal(report.webHttp, 200, 'authenticated Web frontend was not available')
        console.log(JSON.stringify(report))
        return
      }
      if (exited) throw new Error(`Host exited before ${name} completed: ${spawnError?.message ?? safe(output)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out waiting for ${name}: ${safe(output)}`)
  } finally {
    if (!exited) child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 10000)
    try { await closed } finally { clearTimeout(kill) }
  }
}

try {
  console.log(`Harness ${version}; ${values.live ? 'live qwen3.7-flash' : 'offline'} bundle integration`)
  await run('pnpm', ['run', 'build'], repo)
  const tarball = join(root, 'memory.tgz')
  await run('pnpm', ['pack', '--out', tarball], repo)
  // Use the Host's installed peers through its normal package fallback, not a second runtime.
  await run(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', '--config.auto-install-peers=false', tarball])
  const profile = join(env.DSH_HOME, 'profiles/web')
  const probe = join(profile, 'memory-smoke.mjs')
  await copyFile(join(repo, 'scripts/harness-smoke-plugin.mjs'), probe)
  const providerPatch = values.live ? await readFile(join(repo, 'examples/dashscope.patch.yml'), 'utf8') : `
- id: agent-default-model
  config:
    provider: memory-smoke-initial
    model: smoke
`
  const patch = join(root, 'smoke.patch.yml')
  await writeFile(patch, `${providerPatch}
- id: session-title-llm
  disabled: true
- id: llm-retry
  disabled: true
- id: system-prompt
  config:
    persona: 'You are a test assistant. Answer the user briefly using recalled memory. Do not use tools unless asked.'
- insert:
    - id: memory-integration-probe
      name: ${JSON.stringify(probe)}
`, { mode: 0o600 })
  const composed = await run(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--dump-config'])
  assert.ok(composed.includes('@evyn/dsh-memory/tool'), 'installed bundle layer is missing')
  await phase('capture', patch)
  await phase('recall', patch)
  console.log('PASS: packaged bundle, live default routing, automatic capture, tool search, cold restart, cross-session recall, Web HTTP 200')
} catch (error) {
  console.error(safe(error.message))
  process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
