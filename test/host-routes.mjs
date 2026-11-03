/**
 * 回归测试：把插件真实的宿主半边挂到一个假 ctx 上，
 * 用本地 HTTP 请求逐条验证四个路由的行为与副作用。
 *
 * 运行：node test/host-routes.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply, ROUTE, __test } from '../lib/index.mjs'

// Node 18 以下没有全局 Request/Response；DSH 运行时是 Node 22，
// 但为了让本测试也能在旧 Node 上跑，这里提供最小替身。
if (typeof globalThis.Request !== 'function') {
  globalThis.Request = class FakeRequest {
    constructor(url, init = {}) {
      this.url = url
      this.method = init.method ?? 'GET'
      this.headers = new Map(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
      this._body = init.body
    }
    async json() {
      return JSON.parse(this._body)
    }
    async text() {
      return this._body ?? ''
    }
  }
}
if (typeof globalThis.Response !== 'function') {
  globalThis.Response = class FakeResponse {
    constructor(body, init = {}) {
      this.status = init.status ?? 200
      this._body = body
      this.headers = new Map(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
    }
    async text() {
      return this._body ?? ''
    }
  }
}
void Readable

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

// ── 假宿主 ────────────────────────────────────────────────────────────────
/** 记录所有调用；unarchive/archive 改的是同一个数组，等价于注册表的持久集合。 */
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

/** 建一个只实现了本插件所需最小面的 ctx。 */
function createCtx(registry) {
  const routes = []
  return {
    routes,
    workspaceRegistry: registry,
    logger: { info() {}, warn() {} },
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    loader: { entries: () => [] },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {}
      }
    }
  }
}

/** 直接调用注册的 handler，模拟一次请求。 */
async function call(ctx, action, init = {}) {
  const route = ctx.routes[0]
  assert.ok(route, '没有注册路由')
  const request = new Request(`http://127.0.0.1${ROUTE}/${action}${init.query ?? ''}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const response = await route.handler(request)
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

// ── 造一个投影缓存目录 ────────────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), 'dsh-archived-routes-'))
const sessionDir = join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(sessionDir, { recursive: true })
function seedSession(id, title, turns, lastPromptAt) {
  writeFileSync(join(sessionDir, `${id}.json`), JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1793000000000 },
      rows: {
        title: { ver: 1, seq: 5, val: title },
        sessionStats: { ver: 1, seq: 5, val: { turns, steps: turns * 5 } },
        sessionListMetadata: { ver: 1, seq: 5, val: { lastPromptAt } }
      }
    }
  }), 'utf8')
}
const OLD = 'session-aaaa1111-0000-0000-0000-000000000001'
const NEW = 'session-bbbb2222-0000-0000-0000-000000000002'
seedSession(OLD, '旧任务：搭建中转站', 3, 1793000001000)
seedSession(NEW, '新任务：部署博客 & 反向代理', 8, 1793000900000)
process.env.DSH_HOME = home

// ── 用例 ──────────────────────────────────────────────────────────────────
await check('路由注册在前缀 /api/archived-sessions 上', async () => {
  const ctx = createCtx(createRegistry([]))
  apply(ctx)
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].kind, 'prefix')
  assert.equal(ctx.routes[0].path, ROUTE)
})

await check('list 返回归档会话，按最后活动时间倒序', async () => {
  const registry = createRegistry([OLD, NEW])
  const ctx = createCtx(registry)
  apply(ctx)
  const { status, body } = await call(ctx, 'list')
  assert.equal(status, 200)
  assert.equal(body.available, true)
  assert.equal(body.count, 2)
  assert.deepEqual(body.sessions.map((item) => item.id), [NEW, OLD])
  assert.equal(body.sessions[0].title, '新任务：部署博客 & 反向代理')
  assert.equal(body.sessions[0].turns, 8)
  assert.equal(body.sessions[0].lastPromptAt, 1793000900000)
})

await check('list 在 registry 不可用时降级而不是 500', async () => {
  const ctx = createCtx(undefined)
  apply(ctx)
  const { status, body } = await call(ctx, 'list')
  assert.equal(status, 200)
  assert.equal(body.available, false)
  assert.equal(body.reason, 'workspaceRegistry-unavailable')
  assert.deepEqual(body.sessions, [])
})

await check('unarchive 调用注册表并返回新的归档集合', async () => {
  const registry = createRegistry([OLD, NEW])
  const ctx = createCtx(registry)
  apply(ctx)
  const { status, body } = await call(ctx, 'unarchive', { method: 'POST', body: { id: OLD } })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.archived, [NEW])
  assert.deepEqual(registry.calls, [['unarchive', OLD]])
})

await check('unarchive 拒绝非 POST 与缺少 id', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  apply(ctx)
  assert.equal((await call(ctx, 'unarchive')).status, 405)
  assert.equal((await call(ctx, 'unarchive', { method: 'POST', body: {} })).status, 400)
  assert.deepEqual(registry.calls, [])
})

await check('open 只接受已归档 id，并发放一次性令牌', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  apply(ctx)
  assert.equal((await call(ctx, 'open', { method: 'POST', body: { id: 'session-unknown' } })).status, 404)
  const { status, body } = await call(ctx, 'open', { method: 'POST', body: { id: OLD } })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.id, OLD)
  assert.match(body.token, /^[0-9a-z]+-[0-9a-z]+$/)
  assert.ok(body.expiresAt > Date.now())
  // 交接期间会话已临时解除归档
  assert.deepEqual(registry.archivedSessionIds, [])
})

await check('claim 认领后把会话重新归档，令牌作废', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  apply(ctx)
  const opened = await call(ctx, 'open', { method: 'POST', body: { id: OLD } })
  const token = opened.body.token

  const first = await call(ctx, 'claim', { query: `?token=${encodeURIComponent(token)}` })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.deepEqual(registry.archivedSessionIds, [OLD])
  assert.deepEqual(registry.calls[registry.calls.length - 1], ['archive', OLD, true])

  const second = await call(ctx, 'claim', { query: `?token=${encodeURIComponent(token)}` })
  assert.equal(second.status, 410)
  assert.equal(second.body.ok, false)
})

await check('未知动作返回 404', async () => {
  const ctx = createCtx(createRegistry([]))
  apply(ctx)
  assert.equal((await call(ctx, 'nope')).status, 404)
})

await check('交接令牌带 TTL 且过期后不可认领', async () => {
  const handoff = __test.createHandoff()
  const lease = handoff.arm(OLD)
  assert.equal(typeof lease.token, 'string')
  assert.ok(lease.expiresAt > Date.now())
  handoff.dispose()
  assert.equal(handoff.claim(lease.token), undefined)
})

console.log(`\n全部通过：${passed} 项`)
