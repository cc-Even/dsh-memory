/** Synthetic fixtures only, copied into an isolated Harness profile by the smoke runner. */
import { writeFile } from 'node:fs/promises'
export const inject = ['memory', 'connection', 'webRuntime']
export async function apply(ctx) {
  const scope = ctx.memory.managementScopes().find(scope => scope.agentId === 'default')
  const receipt = await ctx.memory.add({ scope, content: '我的偏好是 TypeScript。<img src=x onerror=alert(1)>', idempotencyKey: 'management-browser-fixture' })
  const foreign = await ctx.memory.add({ scope: { ...scope, userId: 'foreign-browser-owner' }, content: 'FOREIGN_OWNER_SECRET', idempotencyKey: 'foreign-fixture' })
  await ctx.memory.add({ scope, content: '模拟缺少模型的降级写入', mode: 'extract', idempotencyKey: 'degraded-fixture' })
  await writeFile(process.env.DSH_MANAGEMENT_READY, JSON.stringify({
    url: ctx.connection.authenticatedUrl(process.env.DSH_MANAGEMENT_BASE),
    recordId: receipt.createdMemoryIds[0], foreignId: foreign.createdMemoryIds[0],
  }), { mode: 0o600 })
}
