/**
 * 自检：单文件插件 lib/index.mjs 的可运行部分（纯 Node，不依赖 DSH 运行时）。
 *
 * 运行：node test.mjs
 * 覆盖：模块契约、四个路由的行为与副作用、HTML 面板页的完整性、交接令牌生命周期。
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
async function check(name, fn) {
  try {
    await fn()
  } catch (error) {
    console.error(`✗ ${name}`)
    throw error
  }
  passed += 1
  console.log(`✓ ${name}`)
}

// Node 18+ 自带 Request/Response；更旧的 Node 给出最小替身，保证测试可跑。
if (typeof globalThis.Request !== 'function') {
  globalThis.Request = class FakeRequest {
    constructor(url, init = {}) {
      this.url = url
      this.method = init.method ?? 'GET'
      this._body = init.body
    }
    async json() {
      return JSON.parse(this._body)
    }
  }
}
if (typeof globalThis.Response !== 'function') {
  globalThis.Response = class FakeResponse {
    constructor(body, init = {}) {
      this.status = init.status ?? 200
      this._body = body
      this.headers = init.headers ?? {}
    }
    async text() {
      return this._body ?? ''
    }
  }
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
function createRegistry(archived) {
  const calls = []
  const state = { archived: [...archived] }
  return {
    calls,
    get archivedSessionIds() {
      return state.archived
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
      state.archived = state.archived.filter((item) => item !== id)
    },
    async archiveSession(id, options) {
      calls.push(['archive', id, options?.stopActivity === true])
      if (!state.archived.includes(id)) state.archived = [...state.archived, id]
    }
  }
}

function createCtx(registry) {
  const ctx = {
    routes: [],
    workspaceRegistry: registry,
    logger: { info() {}, warn() {} },
    effect: (fn) => {
      const dispose = typeof fn === 'function' ? fn() : undefined
      return typeof dispose === 'function' ? dispose : () => {}
    },
    loader: { entries: () => [] },
    webServer: {
      register: (route) => {
        ctx.routes.push(route)
        return () => {}
      }
    },
    inject(_names, fn) {
      fn(ctx)
    }
  }
  return ctx
}

async function call(ctx, action, init = {}) {
  const route = ctx.routes[0]
  assert.ok(route, '没有注册路由')
  const request = new Request(`http://127.0.0.1${route.path}/${action}${init.query ?? ''}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const response = await route.handler(request)
  const text = await response.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  // Node 18+ 的 Response.headers 是 Headers 实例，只支持 .get()；
  // 早期替身实现给的是普通对象，这里统一摊平成普通对象，断言可以直接取键。
  const headers = typeof response.headers?.get === 'function'
    ? Object.fromEntries(response.headers)
    : response.headers
  return { status: response.status, body, headers }
}

// ── 夹具：投影缓存 ────────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-archived-selfcheck-'))
const sessionDir = join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(sessionDir, { recursive: true })
function seed(id, title, turns, lastPromptAt, inputTokens, outputTokens) {
  writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1793000000000 },
      rows: {
        title: { ver: 1, seq: 5, val: title },
        tokenUsage: { ver: 2, seq: 5, val: { totals: { uncachedInputTokens: inputTokens, outputTokens } } },
        sessionStats: { ver: 1, seq: 5, val: { turns, steps: turns * 4 } },
        sessionListMetadata: { ver: 1, seq: 5, val: { lastPromptAt } }
      }
    }
  }), 'utf8')
}
const OLD = 'session-aaaa1111-0000-0000-0000-000000000001'
const NEW = 'session-bbbb2222-0000-0000-0000-000000000002'
seed(OLD, '旧任务：搭建中转站', 3, 1793000001000, 800, 300)
seed(NEW, '新任务：部署博客 & 反向代理', 8, 1793000900000, 9000, 4200)
process.env.DSH_HOME = home

const mod = await import('./lib/index.mjs')

// ── 用例 ──────────────────────────────────────────────────────────────────
await check('模块契约：name / inject / apply / 路由前缀', () => {
  assert.equal(mod.name, 'archived-sessions')
  assert.deepEqual(mod.inject, ['webServer', 'loader'])
  assert.equal(typeof mod.apply, 'function')
  const ctx = createCtx(createRegistry([]))
  mod.apply(ctx)
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].kind, 'prefix')
  assert.equal(ctx.routes[0].path, '/api/archived-sessions')
})

await check('单文件结构：同一份源码既是宿主模块，也是浏览器脚本', () => {
  const source = readFileSync(new URL('./lib/index.mjs', import.meta.url), 'utf8')
  assert.match(source, /^export const name = 'archived-sessions'/m, '宿主入口必须可被 ES 模块导入')
  assert.ok(source.indexOf('/* dsh.client') > 0, '缺少 dsh.client 分段标记')
  assert.ok(!source.includes('window.__ModuleLoader__'), '浏览器段不应依赖 DSH 独有的模块加载器')
})

// 宿主 dsh-client-modules 的硬约束：只要 packages.json 声明了 dsh.client
// （platform: 'web'），就必须同时导出 ./client，否则它在 ClientModuleRegistry
// 构造期抛错，modules 是 required 插件，整个宿主 startup failed——应用直接打不开。
await check('清单契约：dsh.client 必须与 exports["./client"] 成对出现', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  const declared = pkg.dsh?.client?.platform === 'web'
  const exported = pkg.exports?.['./client'] !== undefined
  assert.equal(
    declared,
    exported,
    declared
      ? '声明了 dsh.client 却没有 exports["./client"]，会让宿主启动失败'
      : '导出了 ./client 却没声明 dsh.client'
  )
})

await check('list：按最后活动时间倒序，带标题/轮次/token', async () => {
  const ctx = createCtx(createRegistry([OLD, NEW]))
  mod.apply(ctx)
  const { status, body } = await call(ctx, 'list')
  assert.equal(status, 200)
  assert.equal(body.available, true)
  assert.equal(body.count, 2)
  assert.deepEqual(body.sessions.map((item) => item.id), [NEW, OLD])
  assert.equal(body.sessions[0].title, '新任务：部署博客 & 反向代理')
  assert.equal(body.sessions[0].turns, 8)
  assert.equal(body.sessions[0].inputTokens, 9000)
  assert.equal(body.sessions[0].lastPromptAt, 1793000900000)
})

await check('list：registry 不可用时降级而不是 500', async () => {
  const ctx = createCtx(undefined)
  mod.apply(ctx)
  const { status, body } = await call(ctx, 'list')
  assert.equal(status, 200)
  assert.equal(body.available, false)
  assert.equal(body.reason, 'workspaceRegistry-unavailable')
  assert.deepEqual(body.sessions, [])
})

await check('unarchive：调用注册表并返回新的归档集合', async () => {
  const registry = createRegistry([OLD, NEW])
  const ctx = createCtx(registry)
  mod.apply(ctx)
  const { status, body } = await call(ctx, 'unarchive', { method: 'POST', body: { id: OLD } })
  assert.equal(status, 200)
  assert.deepEqual(body.archived, [NEW])
  assert.deepEqual(registry.calls, [['unarchive', OLD]])
})

await check('unarchive：拒绝非 POST 与缺少 id', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  mod.apply(ctx)
  assert.equal((await call(ctx, 'unarchive')).status, 405)
  assert.equal((await call(ctx, 'unarchive', { method: 'POST', body: {} })).status, 400)
  assert.deepEqual(registry.calls, [])
})

await check('open：只接受已归档 id，发放一次性令牌并临时解除归档', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  mod.apply(ctx)
  assert.equal((await call(ctx, 'open', { method: 'POST', body: { id: 'session-unknown' } })).status, 404)
  const { status, body } = await call(ctx, 'open', { method: 'POST', body: { id: OLD } })
  assert.equal(status, 200)
  assert.equal(body.id, OLD)
  assert.match(body.token, /^[0-9a-z]+-[0-9a-z]+$/)
  assert.ok(body.expiresAt > Date.now())
  assert.deepEqual(registry.archivedSessionIds, [])
})

await check('claim：认领后重新归档，令牌随即作废', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  mod.apply(ctx)
  const opened = await call(ctx, 'open', { method: 'POST', body: { id: OLD } })
  const token = encodeURIComponent(opened.body.token)

  const first = await call(ctx, 'claim', { query: `?token=${token}` })
  assert.equal(first.status, 200)
  assert.deepEqual(registry.archivedSessionIds, [OLD])
  assert.deepEqual(registry.calls[registry.calls.length - 1], ['archive', OLD, true])

  const second = await call(ctx, 'claim', { query: `?token=${token}` })
  assert.equal(second.status, 410)
})

await check('未知动作返回 404 JSON', async () => {
  const ctx = createCtx(createRegistry([]))
  mod.apply(ctx)
  const { status, body } = await call(ctx, 'nope')
  assert.equal(status, 404)
  assert.equal(body.reason, 'not-found')
})

await check('panel：返回可独立运行的中文 HTML 面板页', async () => {
  const ctx = createCtx(createRegistry([]))
  mod.apply(ctx)
  const { status, body, headers } = await call(ctx, 'panel')
  assert.equal(status, 200)
  assert.match(String(headers['content-type']), /text\/html/)
  assert.ok(body.startsWith('<!doctype html>'))
  for (const text of ['已归档会话', '搜索标题', '恢复', '打开', '共 ']) {
    assert.ok(body.includes(text), `面板缺少文案：${text}`)
  }
  assert.ok(body.includes("fetch(API + action"), '面板应通过宿主路由取数')
})

await check('首次加载时把面板页写到 ~/.dsh/storages/archived-sessions.html', async () => {
  const ctx = createCtx(createRegistry([]))
  mod.apply(ctx)
  await call(ctx, 'list')
  const file = join(home, 'storages', 'archived-sessions.html')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(existsSync(file), '面板页没有落盘')
  assert.ok(readFileSync(file, 'utf8').includes('已归档会话'))
})

console.log(`\n全部通过：${passed} 项`)
