/**
 * 本地自检：不依赖 DSH 运行时。
 *
 * 运行：node test.mjs
 *
 * 覆盖：
 *   1. package.json 的 dsh.client 声明与 exports["./client"] 必须成对出现
 *      （缺一个 DSH 启动即崩：declares dsh.client but exports no "./client" bundle）
 *   2. 路由前缀、降级、倒序、恢复调用、交接令牌
 *   3. client bundle 是 __ModuleLoader__ 工厂模块，apply 注册两个 slot
 *   4. 宿主能从投影缓存解析标题 / 轮次 / token
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
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

const read = (rel) => readFileSync(join(root, rel), 'utf8')

// Node 18 以下没有全局 Request/Response；DSH 运行时是 Node 22，
// 但让本测试也能在旧 Node 上跑，这里提供最小替身。
if (typeof globalThis.Request !== 'function') {
  globalThis.Request = class FakeRequest {
    constructor(url, init = {}) {
      this.url = url
      this.method = init.method ?? 'GET'
      this.headers = init.headers ?? {}
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

// ── 1. 清单契约 ────────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'))

await check('dsh.bundle.patch 指向存在的文件', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.match(read(pkg.dsh.bundle.patch), /insert:/)
})

await check('dsh.client 与 exports["./client"] 成对出现', () => {
  const decl = pkg.dsh?.client
  assert.ok(decl, '没有 dsh.client 声明就不会有侧栏 UI')
  assert.equal(decl.platform, 'web')
  const rel = pkg.exports?.['./client']
  assert.ok(rel, '声明了 dsh.client 却没导出 ./client，DSH 启动会直接崩溃')
  const full = resolve(root, typeof rel === 'string' ? rel : rel.default)
  assert.ok(readFileSync(full, 'utf8').length > 0, `client bundle 为空：${full}`)
})

await check('宿主入口存在且可导入', async () => {
  const rel = pkg.exports['.']
  const full = resolve(root, typeof rel === 'string' ? rel : rel.default)
  const mod = await import(`file://${full.replace(/\\/g, '/')}`)
  assert.equal(mod.name, 'archived-sessions')
  assert.deepEqual(mod.inject, ['connection', 'loader'])
  assert.equal(typeof mod.apply, 'function')
})

// ── 2. 宿主路由 ────────────────────────────────────────────────────────────
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
    effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
    loader: { entries: () => [] },
    connection: {
      fetch: {
        register: (route) => {
          ctx.routes.push(route)
          return () => {}
        }
      }
    }
  }
  return ctx
}

async function call(ctx, action, init = {}) {
  const route = ctx.routes[0]
  assert.ok(route, '没有注册路由')
  const url = `dsh-app://app${route.path}/${action}${init.query ?? ''}`
  const request = new Request(url, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  const response = await route.fetch(request)
  const text = await response.text()
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
}

const home = mkdtempSync(join(tmpdir(), 'dsh-archived-check-'))
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

const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)

await check('parseRequest 兼容 dsh-app:// 自定义 scheme', () => {
  const cases = [
    ['dsh-app://app/api/archived-sessions/list', 'list'],
    ['http://127.0.0.1:50057/api/archived-sessions/list', 'list'],
    ['/api/archived-sessions/list', 'list'],
    ['dsh-app://app/api/archived-sessions/unarchive', 'unarchive'],
    ['dsh-app://app/api/archived-sessions/list/', 'list'],
    ['dsh-app://app/api/archived-sessions/list#frag', 'list']
  ]
  for (const [url, expected] of cases) {
    const { action } = host.__test.parseRequest({ url })
    assert.equal(action, expected, `${url} 解析成 ${JSON.stringify(action)}`)
  }
  const { searchParams } = host.__test.parseRequest({ url: 'dsh-app://app/api/archived-sessions/claim?token=a-b' })
  assert.equal(searchParams.get('token'), 'a-b')
})

await check('路由注册在 connection.fetch 通道的 /api/archived-sessions 前缀上', () => {
  const ctx = createCtx(createRegistry([]))
  host.apply(ctx)
  assert.equal(ctx.routes.length, 1)
  assert.equal(ctx.routes[0].path, '/api/archived-sessions')
  assert.ok(Array.isArray(ctx.routes[0].methods) && ctx.routes[0].methods.includes('GET'))
  assert.equal(typeof ctx.routes[0].fetch, 'function')
  // 确认没有再碰 webServer（那条路渲染进程到不了）
  assert.equal(ctx.webServer, undefined)
})

await check('list 按最后活动倒序并带展示信息', async () => {
  const ctx = createCtx(createRegistry([OLD, NEW]))
  host.apply(ctx)
  const { status, body } = await call(ctx, 'list')
  assert.equal(status, 200)
  assert.equal(body.available, true)
  assert.equal(body.count, 2)
  assert.deepEqual(body.sessions.map((item) => item.id), [NEW, OLD])
  assert.equal(body.sessions[0].title, '新任务：部署博客 & 反向代理')
  assert.equal(body.sessions[0].turns, 8)
  assert.equal(body.sessions[0].inputTokens, 9000)
})

await check('list 在 registry 不可用时降级', async () => {
  const ctx = createCtx(undefined)
  host.apply(ctx)
  const { status, body } = await call(ctx, 'list')
  assert.equal(status, 200)
  assert.equal(body.available, false)
  assert.equal(body.reason, 'workspaceRegistry-unavailable')
})

await check('unarchive 调用注册表并返回新集合', async () => {
  const registry = createRegistry([OLD, NEW])
  const ctx = createCtx(registry)
  host.apply(ctx)
  const { status, body } = await call(ctx, 'unarchive', { method: 'POST', body: { id: OLD } })
  assert.equal(status, 200)
  assert.deepEqual(body.archived, [NEW])
  assert.deepEqual(registry.calls, [['unarchive', OLD]])
})

await check('unarchive 拒绝非 POST 与缺 id', async () => {
  const ctx = createCtx(createRegistry([OLD]))
  host.apply(ctx)
  assert.equal((await call(ctx, 'unarchive')).status, 405)
  assert.equal((await call(ctx, 'unarchive', { method: 'POST', body: {} })).status, 400)
})

await check('open 只接受已归档 id 并发放一次性令牌', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  host.apply(ctx)
  assert.equal((await call(ctx, 'open', { method: 'POST', body: { id: 'session-unknown' } })).status, 404)
  const { status, body } = await call(ctx, 'open', { method: 'POST', body: { id: OLD } })
  assert.equal(status, 200)
  assert.match(body.token, /^[0-9a-z]+-[0-9a-z]+$/)
  assert.deepEqual(registry.archivedSessionIds, [])
})

await check('claim 认领后重新归档并作废令牌', async () => {
  const registry = createRegistry([OLD])
  const ctx = createCtx(registry)
  host.apply(ctx)
  const opened = await call(ctx, 'open', { method: 'POST', body: { id: OLD } })
  const token = encodeURIComponent(opened.body.token)
  assert.equal((await call(ctx, 'claim', { query: `?token=${token}` })).status, 200)
  assert.deepEqual(registry.archivedSessionIds, [OLD])
  assert.equal((await call(ctx, 'claim', { query: `?token=${token}` })).status, 410)
})

// ── 3. client bundle ───────────────────────────────────────────────────────
function loadClientBundle() {
  let registration
  const run = new Function('window', 'fetch', read('lib/client.js'))
  run({ __ModuleLoader__: { load: (next) => { registration = next } } }, () => Promise.reject(new Error('no fetch')))
  const reactStub = {
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value })
  }
  return registration.factory((specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected require: ${specifier}`)
  })
}

await check('client bundle 是 __ModuleLoader__ 工厂模块', () => {
  const client = loadClientBundle()
  assert.equal(typeof client.apply, 'function')
  assert.ok(Array.isArray(client.inject) && client.inject.length > 0, 'client.inject 不能为空')
  assert.equal(typeof client.ArchivedSessionsPage, 'function')
  assert.equal(typeof client.ArchivedPanelIcon, 'function')
  assert.equal(client.PANEL_ID, 'archived-sessions')
})

await check('client.apply 注册 main 与 sidebar.panellist', () => {
  const client = loadClientBundle()
  const injected = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: (namespace) => (key) => `${namespace}.${key}` },
    slots: {
      inject: (name, factory) => {
        injected.push(name)
        factory()
      },
      register: (options, component) => ({ options, component })
    }
  }
  client.apply(ctx)
  assert.deepEqual(injected.sort(), ['main', 'sidebar.panellist'])
})

// 客户端插件有两份依赖清单，命名空间不同、绝不能混写：
//   - package.json > dsh.client.inject：写**包名**，供 client-modules 排加载顺序
//   - lib/client.js > exports.inject：写**服务名**（短名），供 cordis 做服务注入
// 把包名写进 exports.inject，cordis 永远等不到同名服务，插件恒 pending，
// web boot 报 "entry did not activate"，整个前端起不来。官方参照：
// dsh-client-ui-plugin-manager 的 exports.inject 是 ["slots","locale",...] 短名。
await check('exports.inject 是服务名（短名），包名混进去会让 web boot 卡死', () => {
  const client = loadClientBundle()
  for (const name of client.inject) {
    assert.ok(!name.startsWith('@') && !name.includes('/'),
      `"${name}" 是包名不是服务名；exports.inject 必须写短名（如 locale、slots）`)
  }
})

await check('dsh.client.inject 是包名，与 exports.inject 分工不混写', () => {
  const list = pkg.dsh?.client?.inject ?? []
  assert.ok(list.length > 0, '声明了 dsh.client 就必须列出依赖包')
  for (const name of list) {
    assert.ok(name.includes('/'), `"${name}" 是服务名不是包名；dsh.client.inject 必须写包名`)
  }
})

await check('client.inject 覆盖 apply 里用到的全部服务', () => {
  const client = loadClientBundle()
  const source = read('lib/client.js')
  const used = new Set()
  for (const match of source.matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)) {
    const service = match[1]
    // effect 是生命周期钩子、get 是取值，都不算服务。
    if (service === 'effect' || service === 'get') continue
    used.add(service)
  }
  assert.ok(used.size > 0, '没从源码里识别出任何服务调用，正则可能失效')
  for (const service of used) {
    assert.ok(client.inject.includes(service),
      `apply() 用到 ctx.${service} 但 exports.inject 缺少 "${service}"，会一直 pending`)
  }
})

await check('面板组件可渲染且不抛错', () => {
  const client = loadClientBundle()
  const element = client.ArchivedSessionsPage({ t: (key) => key })
  assert.ok(element && typeof element === 'object')
  const flat = JSON.stringify(element)
  for (const key of ['title', 'subtitle', 'search', 'refresh']) {
    assert.ok(flat.includes(key), `缺少 ${key}`)
  }
  assert.ok(client.ArchivedPanelIcon({ size: 16 }))
})

console.log(`\n全部通过：${passed} 项`)
