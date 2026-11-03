/**
 * 本地自检：不依赖 DSH 运行时，只验证插件的对外契约与宿主半边的纯逻辑。
 *
 * 运行：node test/self-check.mjs
 *
 * 覆盖：
 *   1. package.json 的 dsh.bundle.patch / dsh.client 声明齐全，exports 指向真实文件
 *   2. cordis.patch.yml 能把本插件插入 profile 树
 *   3. client.js 是合法的 __ModuleLoader__ 工厂模块，注入假 require 后能导出 apply
 *   4. apply 向 main 与 sidebar.panellist 两个 slot 注册
 *   5. 宿主能从会话投影缓存里解析标题 / 轮次 / token / 时间
 */

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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

/** 在假 window 里执行 client bundle，返回它的注册信息。 */
function loadClientBundle() {
  let registration
  const source = read('lib/client.js')
  const run = new Function('window', 'fetch', source)
  run({ __ModuleLoader__: { load: (next) => { registration = next } } }, () => Promise.reject(new Error('fetch 不可用')))
  const reactStub = {
    // 返回结构化的假元素，便于断言渲染结果（真实渲染由宿主 React 负责）。
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

// ── 1. 清单 ────────────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'))

await check('package.json 声明 dsh.bundle.patch 且文件存在', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.match(read(pkg.dsh.bundle.patch), /insert:/)
})

await check('package.json 声明 dsh.client.platform = web', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
})

await check('exports 指向的入口文件都存在', () => {
  for (const key of ['.', './client']) {
    const target = pkg.exports[key]
    const rel = typeof target === 'string' ? target : target?.default
    assert.ok(rel, `exports["${key}"] 缺失`)
    assert.ok(read(rel).length > 0, `exports["${key}"] -> ${rel} 为空`)
  }
})

// ── 2. client bundle ───────────────────────────────────────────────────────
await check('client.js 是 __ModuleLoader__.load 工厂模块', () => {
  let registration
  const run = new Function('window', 'fetch', read('lib/client.js'))
  run({ __ModuleLoader__: { load: (next) => { registration = next } } }, () => Promise.reject(new Error('fetch 不可用')))
  assert.ok(registration, '没有调用 __ModuleLoader__.load')
  assert.equal(registration.id, 'dsh-archived-sessions')
  assert.equal(typeof registration.factory, 'function')
})

await check('client 导出 apply / inject / 面板组件', () => {
  const client = loadClientBundle()
  assert.equal(typeof client.apply, 'function')
  assert.ok(Array.isArray(client.inject))
  assert.ok(client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.equal(typeof client.ArchivedSessionsPage, 'function')
  assert.equal(typeof client.ArchivedPanelIcon, 'function')
  assert.equal(client.PANEL_ID, 'archived-sessions')
})

await check('apply 注册 main 与 sidebar.panellist 两个 slot', () => {
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

  const main = ctx.slots.register
  assert.equal(typeof main, 'function')
})

await check('面板组件可渲染为空态且不抛错', () => {
  const client = loadClientBundle()
  const element = client.ArchivedSessionsPage({ t: (key) => key })
  assert.ok(element && typeof element === 'object')
  assert.equal(element.props['data-dsh-archived-sessions'], '')
  // t() 在自检里返回 key 本身，所以标题区渲染出的就是 "title"。
  const flat = JSON.stringify(element)
  for (const key of ['title', 'subtitle', 'search', 'refresh']) {
    assert.ok(flat.includes(key), `面板应渲染 ${key}`)
  }
  const icon = client.ArchivedPanelIcon({ size: 16 })
  assert.ok(icon && typeof icon === 'object')
})

// ── 3. 宿主：投影缓存解析 ──────────────────────────────────────────────────
await check('宿主能从投影缓存解析标题 / 轮次 / token / 时间', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-archived-self-check-'))
  const sessions = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(sessions, { recursive: true })
  const id = 'session-11111111-2222-3333-4444-555555555555'
  writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1793000000000 },
      rows: {
        title: { ver: 1, seq: 10, val: '把站点部署到阿里云' },
        titleInput: { ver: 3, seq: 10, val: { first: { seq: 1, text: '把站点部署到阿里云' }, count: 2 } },
        tokenUsage: {
          ver: 2,
          seq: 10,
          val: { totals: { uncachedInputTokens: 1234, outputTokens: 567 }, last: {} }
        },
        sessionStats: { ver: 1, seq: 10, val: { turns: 4, steps: 20 } },
        sessionListMetadata: { ver: 1, seq: 10, val: { blank: false, lastPromptAt: 1793000123456 } }
      }
    }
  }), 'utf8')

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const host = await import('../lib/index.mjs')
    assert.equal(typeof host.apply, 'function')
    assert.ok(Array.isArray(host.inject))
    const info = await host.__test.readProjection(id)
    assert.equal(info.title, '把站点部署到阿里云')
    assert.equal(info.turns, 4)
    assert.equal(info.inputTokens, 1234)
    assert.equal(info.outputTokens, 567)
    assert.equal(info.lastPromptAt, 1793000123456)
    assert.equal(info.createdAt, 1793000000000)

    const missing = await host.__test.readProjection('session-does-not-exist')
    assert.equal(missing, undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

await check('宿主路由常量与 client 侧保持一致', async () => {
  const host = await import('../lib/index.mjs')
  assert.equal(host.ROUTE, '/api/archived-sessions')
  const clientSource = read('lib/client.js')
  for (const action of ['list', 'unarchive', 'open', 'claim']) {
    assert.ok(clientSource.includes(`api/archived-sessions/${action}`), `client 未使用 ${action} 路由`)
  }
})

console.log(`\n全部通过：${passed} 项`)
