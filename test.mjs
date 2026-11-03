/**
 * 本地自检：不依赖 DSH 运行时。
 *
 * 运行：node test.mjs
 *
 * 架构（0.4.0 RPC 版）：
 *   - 数据来源：渲染进程官方 Remote（ctx.remote.workspace），无任何自建路由
 *   - 宿主半边只做一件事：触发 workspace 插件体确保 registry 激活
 *   - 客户端订阅 workspace increment 帧保持归档清单同步
 *
 * 覆盖：清单契约、client bundle 模块形态、slot 注册、inject 完整性、宿主触发逻辑
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
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

// ── 1. 清单契约 ────────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'))

await check('dsh.bundle.patch 指向存在的文件', () => {
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.match(read(pkg.dsh.bundle.patch), /insert:/)
})

await check('dsh.client 与 exports["./client"] 成对出现（缺一启动即崩）', () => {
  const decl = pkg.dsh?.client
  assert.ok(decl, '缺少 dsh.client 声明 → 没有侧栏 UI')
  assert.equal(decl.platform, 'web')
  const rel = pkg.exports?.['./client']
  assert.ok(rel, '声明了 dsh.client 却没导出 ./client，DSH 启动直接崩溃')
  const full = resolve(root, typeof rel === 'string' ? rel : rel.default)
  assert.ok(readFileSync(full, 'utf8').length > 0, `client bundle 为空：${full}`)
})

await check('client.inject 含 api-remotes（RPC 数据源必需）', () => {
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(inject.includes('@deepseek-ai/dsh-api-remotes'), '缺 api-remotes → ctx.remote.workspace 不存在')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-locale'), '缺 locale → apply 里 ctx.locale 调用会 pending')
  assert.ok(inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), '缺 sidebar → 没有侧栏入口')
})

// ── 2. client bundle ───────────────────────────────────────────────────────
function loadClientBundle() {
  let registration
  const run = new Function('window', 'fetch', read('lib/client.js'))
  run({ __ModuleLoader__: { load: (next) => { registration = next } } }, () => Promise.reject(new Error('no fetch')))
  const reactStub = {
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
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
  assert.ok(Array.isArray(client.inject))
  assert.equal(typeof client.ArchivedSessionsPage, 'function')
  assert.equal(typeof client.ArchivedPanelIcon, 'function')
  assert.equal(client.PANEL_ID, 'archived-sessions')
})

await check('client 不含任何 fetch 路由调用（0.4.0 起数据走 Remote）', () => {
  const source = read('lib/client.js')
  assert.ok(!source.includes('webServer.register'), '不应再使用 webServer.register')
  assert.ok(!source.includes('connection.fetch.register'), '不应再使用 connection.fetch.register')
})

await check('client.apply 注册 main 与 sidebar.panellist', () => {
  const client = loadClientBundle()
  const injected = []
  const ctx = {
    effect: (fn) => fn(),
    remote: { $on: () => () => {} },
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
// web boot 报 "entry did not activate"，整个前端起不来（0.3.1 / 0.4.0 各踩一次）。
// 官方参照 dsh-client-ui-plugin-manager：exports.inject 是
// ["slots","locale","remote","remote.pluginManager",...] 这类短名。
await check('exports.inject 是服务名（短名），包名混进去会让 web boot 卡死', () => {
  const client = loadClientBundle()
  for (const name of client.inject) {
    assert.ok(!name.startsWith('@') && !name.includes('/'),
      `"${name}" 是包名不是服务名；exports.inject 必须写短名（如 locale、slots、remote）`)
  }
})

await check('exports.inject 覆盖 apply 里用到的全部服务', () => {
  const client = loadClientBundle()
  const source = read('lib/client.js')
  const used = new Set()
  for (const match of source.matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)) {
    const service = match[1]
    // effect 是生命周期钩子，不算服务；ctx.remote?.workspace 这类子路径
    // 由 "remote" 与 "remote.workspace" 共同覆盖。
    if (service === 'effect') continue
    used.add(service)
  }
  assert.ok(used.size > 0, '没从源码里识别出任何服务调用，正则可能失效')
  for (const service of used) {
    assert.ok(client.inject.includes(service),
      `apply() 用到 ctx.${service} 但 exports.inject 缺少 "${service}"，会一直 pending`)
  }
  assert.ok(client.inject.includes('remote.workspace'),
    '数据走 ctx.remote.workspace，需按官方写法声明子服务 "remote.workspace"')
})

await check('dsh.client.inject 是包名且覆盖 RPC 与侧栏依赖', () => {
  const list = pkg.dsh?.client?.inject ?? []
  assert.ok(list.length > 0, '声明了 dsh.client 就必须列出依赖包')
  for (const name of list) {
    assert.ok(name.includes('/'), `"${name}" 是服务名不是包名；dsh.client.inject 必须写包名`)
  }
  assert.ok(list.includes('@deepseek-ai/dsh-api-remotes'), '缺 api-remotes → ctx.remote.workspace 不存在')
  assert.ok(list.includes('@deepseek-ai/dsh-client-locale'), '缺 locale → ctx.locale 调用会 pending')
  assert.ok(list.includes('@deepseek-ai/dsh-client-ui-sidebar'), '缺 sidebar → 没有侧栏入口')
})

await check('数据源订阅 workspace 帧且恢复走官方 RPC', () => {
  const source = read('lib/client.js')
  assert.ok(source.includes('archivedSessionIds'), '应读取 archivedSessionIds')
  assert.ok(source.includes('unarchiveSession'), '恢复操作应调 ctx.remote.workspace.unarchiveSession')
  assert.ok(source.includes('ctx.remote'), '应通过 ctx.remote 访问官方 RPC')
})

// ── 3. 宿主半边 ────────────────────────────────────────────────────────────
await check('宿主半边触发 workspace 插件体且不挂起', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  assert.equal(host.name, 'archived-sessions')
  assert.deepEqual(host.inject, ['loader'])

  // 场景 A：ctx 上已有 workspaceRegistry → 直接用，不重复触发
  let applied = 0
  const readyCtx = {
    workspaceRegistry: { marker: true },
    logger: { info() {}, warn() {} },
    loader: {
      entries: () => [{
        options: { name: '@deepseek-ai/dsh-workspace' },
        apply() { applied += 1 }
      }]
    }
  }
  host.apply(readyCtx)
  assert.equal(applied, 0, 'registry 已就绪时不应再触发插件体')

  // 场景 B：ctx 上没有 → 触发一次，且不 await（返回永不 resolve 也不挂）
  const hangingCtx = {
    logger: { info() {}, warn() {} },
    loader: {
      entries: () => [{
        options: { name: '@deepseek-ai/dsh-workspace' },
        apply() { return new Promise(() => {}) }  // 模拟常驻服务
      }]
    }
  }
  const start = Date.now()
  host.apply(hangingCtx)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 500, `宿主 apply 花了 ${elapsed}ms —— 疑似在 await 常驻 Promise`)
})

await check('宿主半边不再注册任何路由（0.4.0 无网络面）', () => {
  const source = read('lib/index.mjs')
  assert.ok(!source.includes('webServer.register'), '不应使用 webServer.register')
  assert.ok(!source.includes('connection.fetch.register'), '不应使用 connection.fetch.register')
})

console.log(`\n全部通过：${passed} 项`)
