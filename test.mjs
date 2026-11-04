/**
 * 本地自检：不依赖 DSH 运行时。
 *
 * 运行：node test.mjs
 *
 * 架构（0.6.0 查看交互与永久删除版）：
 *   - 数据来源：官方 workspaces 与 sessions 服务的稳定状态快照
 *   - 宿主半边激活 registry，并注册带校验和回滚的永久删除路由
 *   - 客户端合并归档集合、工作区归属与会话投影，展示交互并支持恢复/删除
 *
 * 覆盖：清单契约、client bundle 模块形态、slot 注册、inject 完整性、宿主触发逻辑
 */

import { strict as assert } from 'node:assert'
import { access, mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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

await check('client.inject 含官方 Session/Workspace Controller 及界面依赖', () => {
  const inject = pkg.dsh?.client?.inject ?? []
  assert.ok(inject.includes('@deepseek-ai/dsh-api-remotes'), '缺 api-remotes → Workspace Controller 无底层传输')
  assert.ok(inject.includes('@deepseek-ai/dsh-api-workspace-controller'),
    '缺 workspace-controller → ctx.workspaces 不存在')
  assert.ok(inject.includes('@deepseek-ai/dsh-api-session-controller'),
    '缺 session-controller → ctx.sessions 不存在')
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
    useSyncExternalStore: (_subscribe, getSnapshot) => {
      const snapshot = getSnapshot()
      assert.strictEqual(getSnapshot(), snapshot,
        'useSyncExternalStore 的 getSnapshot 必须在状态未变化时返回同一对象')
      return snapshot
    },
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
  assert.equal(typeof client.buildSessionRows, 'function')
  assert.equal(client.PANEL_ID, 'archived-sessions')
})

await check('client 仅对 token 补全和永久删除使用宿主 fetch 路由', () => {
  const source = read('lib/client.js')
  assert.ok(!source.includes('webServer.register'), '不应再使用 webServer.register')
  assert.ok(!source.includes('connection.fetch.register'), '不应再使用 connection.fetch.register')
  assert.ok(source.includes('fetch("/api/archived-sessions/delete"'), '永久删除应调用绝对宿主路由')
  assert.ok(source.includes('fetch("/api/archived-sessions/token-usage"'), 'token 统计应调用绝对宿主路由')
})

await check('表单和弹层选项使用 DSH 主题变量', () => {
  const source = read('lib/client.js')
  assert.ok(source.includes('--dsw-alias-bg-overlay'), '下拉选项应使用主题弹层背景')
  assert.ok(source.includes('--dsw-alias-label-primary'), '控件应使用主题主文字色')
  assert.ok(source.includes('--dsw-alias-border-l2'), '控件应使用主题边框色')
  assert.ok(source.includes('colorScheme: "inherit"'), '原生控件应继承当前明暗模式')
  assert.ok(source.includes('style: S.option'), '每个 option 都应显式应用主题样式')
})

await check('client.apply 注册 main 与 sidebar.panellist', () => {
  const client = loadClientBundle()
  const injected = []
  const workspaceSnapshot = {
    items: [], archivedSessionIds: [], pinnedSessionIds: [],
    state: 'idle', phase: 'ready', error: null
  }
  const sessionSnapshot = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
  const ctx = {
    effect: (fn) => fn(),
    workspaces: {
      list: { subscribe: () => () => {}, getSnapshot: () => workspaceSnapshot },
      unarchiveSession: async () => {}
    },
    sessions: {
      list: { subscribe: () => () => {}, getSnapshot: () => sessionSnapshot }
    },
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

await check('会话投影可转换为与离线报告一致的可读字段', () => {
  const client = loadClientBundle()
  const rows = client.buildSessionRows(
    ['session-baef3b2c-cb75-4304-86e2-87fd54113671'],
    {
      byId: {
        'session-baef3b2c-cb75-4304-86e2-87fd54113671': {
          displayTitle: '你好',
          updatedAt: 1793697282878,
          cwd: 'E:\\work\\欧童\\欧通BS',
          projectionValues: {
            title: '你好',
            titleInput: { first: { text: '你好' }, count: 2 },
            sessionStats: { turns: 2, steps: 2 },
            modelSelection: { lastUsed: { model: 'deepseek-v4.1-flash' } },
            sessionListMetadata: { lastPromptAt: 1793697282878 },
            turnOutline: [
              { turn: 1, prompt: '你好', response: '你好！有什么可以帮你？' },
              { turn: 2, prompt: '介绍一下你自己', response: '我是一个 AI 助手。' }
            ]
          }
        }
      }
    },
    {
      items: [{
        title: '欧通BS', path: 'E:\\work\\欧童\\欧通BS',
        sessionIds: ['session-baef3b2c-cb75-4304-86e2-87fd54113671']
      }]
    },
    '（未归属工作区）',
    {
      'session-baef3b2c-cb75-4304-86e2-87fd54113671': {
        uncachedInputTokens: 959,
        outputTokens: 75
      }
    }
  )
  assert.deepEqual(rows[0], {
    id: 'session-baef3b2c-cb75-4304-86e2-87fd54113671',
    short: 'baef3b2c',
    title: '你好',
    firstPrompt: '你好',
    turns: 2,
    steps: 2,
    lastPromptAt: 1793697282878,
    inputTokens: 959,
    outputTokens: 75,
    tokenKnown: true,
    model: 'deepseek-v4.1-flash',
    workspace: '欧通BS',
    workspacePath: 'E:\\work\\欧童\\欧通BS',
    interactions: [
      { turn: 1, prompt: '你好', response: '你好！有什么可以帮你？' },
      { turn: 2, prompt: '介绍一下你自己', response: '我是一个 AI 助手。' }
    ]
  })
})

await check('归档面板读取两份稳定快照并可完成首屏渲染', () => {
  const client = loadClientBundle()
  const snapshot = {
    items: [],
    archivedSessionIds: ['session-alpha', 'session-beta'],
    pinnedSessionIds: [],
    state: 'idle',
    phase: 'ready',
    error: null
  }
  const sessionSnapshot = {
    ids: [], byId: {}, phase: 'ready', projectionsBySession: {}
  }
  const page = client.ArchivedSessionsPage({
    t: (key) => key,
    workspaces: {
      list: { subscribe: () => () => {}, getSnapshot: () => snapshot },
      unarchiveSession: async () => {}
    },
    sessions: {
      list: {
        subscribe: () => () => {},
        getSnapshot: () => sessionSnapshot
      }
    }
  })
  assert.equal(page.props['data-dsh-archived-sessions'], '')
})

// 客户端插件有两份依赖清单，命名空间不同、绝不能混写：
//   - package.json > dsh.client.inject：写**包名**，供 client-modules 排加载顺序
//   - lib/client.js > exports.inject：写**服务名**（短名），供 cordis 做服务注入
// 把包名写进 exports.inject，cordis 永远等不到同名服务，插件恒 pending，
// web boot 报 "entry did not activate"，整个前端起不来（0.3.1 / 0.4.0 各踩一次）。
// 官方参照 dsh-client-ui-workspace：exports.inject 是
// ["slots","sessions","workspaces","locale",...] 这类短名。
await check('exports.inject 是服务名（短名），包名混进去会让 web boot 卡死', () => {
  const client = loadClientBundle()
  for (const name of client.inject) {
    assert.ok(!name.startsWith('@') && !name.includes('/'),
      `"${name}" 是包名不是服务名；exports.inject 必须写短名（如 locale、slots、workspaces）`)
  }
})

await check('exports.inject 覆盖 apply 里用到的全部服务', () => {
  const client = loadClientBundle()
  const source = read('lib/client.js')
  const used = new Set()
  for (const match of source.matchAll(/ctx\.([a-zA-Z_$][\w$]*)/g)) {
    const service = match[1]
    // effect 是生命周期钩子，不算服务。
    if (service === 'effect') continue
    used.add(service)
  }
  assert.ok(used.size > 0, '没从源码里识别出任何服务调用，正则可能失效')
  for (const service of used) {
    assert.ok(client.inject.includes(service),
      `apply() 用到 ctx.${service} 但 exports.inject 缺少 "${service}"，会一直 pending`)
  }
  assert.ok(client.inject.includes('workspaces'),
    '数据走官方 Workspace Controller，需声明服务 "workspaces"')
  assert.ok(client.inject.includes('sessions'),
    '展示信息走官方 Session Controller，需声明服务 "sessions"')
})

await check('dsh.client.inject 是包名且覆盖 RPC 与侧栏依赖', () => {
  const list = pkg.dsh?.client?.inject ?? []
  assert.ok(list.length > 0, '声明了 dsh.client 就必须列出依赖包')
  for (const name of list) {
    assert.ok(name.includes('/'), `"${name}" 是服务名不是包名；dsh.client.inject 必须写包名`)
  }
  assert.ok(list.includes('@deepseek-ai/dsh-api-remotes'), '缺 api-remotes → Workspace Controller 无底层传输')
  assert.ok(list.includes('@deepseek-ai/dsh-api-workspace-controller'),
    '缺 workspace-controller → workspaces 服务不存在')
  assert.ok(list.includes('@deepseek-ai/dsh-api-session-controller'),
    '缺 session-controller → sessions 服务不存在')
  assert.ok(list.includes('@deepseek-ai/dsh-client-locale'), '缺 locale → ctx.locale 调用会 pending')
  assert.ok(list.includes('@deepseek-ai/dsh-client-ui-sidebar'), '缺 sidebar → 没有侧栏入口')
})

await check('数据源走官方 Controller，恢复操作走 workspaces 服务', () => {
  const source = read('lib/client.js')
  assert.ok(source.includes('archivedSessionIds'), '应读取 archivedSessionIds')
  assert.ok(source.includes('workspaces.list.subscribe'), '应订阅官方 workspaces.list 状态源')
  assert.ok(source.includes('workspaces.list.getSnapshot'), '应读取官方稳定快照')
  assert.ok(source.includes('sessions.list.subscribe'), '应订阅官方 sessions.list 状态源')
  assert.ok(source.includes('sessions.list.getSnapshot'), '应读取官方会话投影快照')
  assert.ok(source.includes('workspaces.unarchiveSession(id)'), '恢复操作应调用官方 workspaces 服务')
  assert.ok(source.includes('props.sessions.refresh()'), '刷新按钮应调用官方 sessions.refresh()')
  assert.ok(source.includes('loadTokenUsage(ids)'), '刷新按钮应重新读取归档 token 投影')
  const prepareIndex = source.indexOf('phase: "prepare"')
  const deleteRefreshIndex = source.indexOf('props.sessions.refresh()', prepareIndex)
  const commitIndex = source.indexOf('phase: "commit"')
  assert.ok(prepareIndex >= 0, '永久删除应先准备事务')
  assert.ok(deleteRefreshIndex > prepareIndex, '准备事务后应先刷新官方 Session 列表')
  assert.ok(commitIndex > deleteRefreshIndex, '官方列表刷新后才能提交引用删除')
  assert.ok(source.includes('phase: "rollback"'), '提交前失败应显式回滚删除事务')
  assert.ok(!source.includes('workspace/increment'), 'workspace 状态走 follow 流，不是 Remote 转发事件')
  assert.ok(!source.includes('ctx.remote'), '面板不应绕过 Workspace Controller 直接操作底层 Remote')
})

// ── 3. 宿主半边 ────────────────────────────────────────────────────────────
await check('宿主直接依赖官方 workspaceRegistry 并注册两条精确路由', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  assert.equal(host.name, 'archived-sessions')
  assert.deepEqual(host.inject, ['webServer', 'connection', 'workspaceRegistry', 'sessions'])

  const routeRegistrations = []
  const hostServices = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (options) => routeRegistrations.push(options) } }
  }

  const readyCtx = {
    ...hostServices,
    workspaceRegistry: { marker: true },
    logger: { info() {}, warn() {} }
  }
  host.apply(readyCtx)
  assert.equal(routeRegistrations.length, 2)
  assert.deepEqual(
    routeRegistrations.map((route) => route.path).sort(),
    ['/api/archived-sessions/delete', '/api/archived-sessions/token-usage']
  )
})

await check('宿主 token 与永久删除路由使用 DSH connection.fetch', () => {
  const source = read('lib/index.mjs')
  assert.ok(!source.includes('webServer.register'), '不应使用 webServer.register')
  assert.ok(source.includes('connection.fetch.register'), '应注册 DSH 自带 fetch 路由')
  assert.ok(source.includes("methods: ['POST']"), '删除路由只应接受 POST')
})

await check('精确注册的 token 路由可收到请求而不是返回 404', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-route-'))
  const id = 'session-route-test'
  const projectionDir = join(tempRoot, 'storages', 'session_projcache', 'sessions')
  await mkdir(projectionDir, { recursive: true })
  await writeFile(join(projectionDir, `${id}.json`), JSON.stringify({
    record: { rows: { tokenUsage: { val: { totals: {
      uncachedInputTokens: 123,
      outputTokens: 45
    } } } } }
  }))

  const routes = []
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = tempRoot
  try {
    host.apply({
      workspaceRegistry: { archivedSessionIds: [id] },
      effect: (fn) => fn(),
      connection: { fetch: { register: (options) => routes.push(options) } },
      logger: { info() {}, warn() {} }
    })
    const route = routes.find((item) => item.path === '/api/archived-sessions/token-usage')
    assert.ok(route, 'token 路由未按完整路径注册')
    const response = await route.fetch(new Request('http://localhost/api/archived-sessions/token-usage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] })
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      ok: true,
      tokenUsageById: { [id]: { uncachedInputTokens: 123, outputTokens: 45 } }
    })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('宿主从归档投影缓存批量读取 token 并拒绝越权会话', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-tokens-'))
  const archivedId = 'session-token-test'
  const activeId = 'session-not-archived'
  const projectionDir = join(tempRoot, 'storages', 'session_projcache', 'sessions')
  await mkdir(projectionDir, { recursive: true })
  const projection = (input, output) => JSON.stringify({
    record: { rows: { tokenUsage: { val: { totals: {
      uncachedInputTokens: input,
      outputTokens: output
    } } } } }
  })
  await writeFile(join(projectionDir, `${archivedId}.json`), projection(959, 75))
  await writeFile(join(projectionDir, `${activeId}.json`), projection(999999, 999999))

  try {
    const result = await host.__test.readArchivedTokenUsage({
      root: tempRoot,
      ids: [archivedId, activeId, archivedId],
      registry: { archivedSessionIds: [archivedId] }
    })
    assert.deepEqual(result, {
      [archivedId]: { uncachedInputTokens: 959, outputTokens: 75 }
    })
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('workspaceRegistry 不可用时 token 路由从 workspace.json 校验归档集合', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-token-fallback-'))
  const id = 'session-token-fallback'
  const storageDir = join(tempRoot, 'storages')
  const projectionDir = join(storageDir, 'session_projcache', 'sessions')
  await mkdir(projectionDir, { recursive: true })
  await writeFile(join(storageDir, 'workspace.json'), JSON.stringify({
    global: { archivedSessionIds: [id] }
  }))
  await writeFile(join(projectionDir, `${id}.json`), JSON.stringify({
    record: { rows: { tokenUsage: { val: { totals: {
      uncachedInputTokens: 2468,
      outputTokens: 135
    } } } } }
  }))

  try {
    assert.deepEqual(await host.__test.readArchivedTokenUsage({
      root: tempRoot,
      ids: [id],
      registry: undefined
    }), {
      [id]: { uncachedInputTokens: 2468, outputTokens: 135 }
    })
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('两阶段删除在提交前保持归档隐藏，提交后才移除引用', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-prepare-'))
  const id = 'session-prepare-test'
  const body = join(tempRoot, 'sessions', 'workspace-a', id, 'session.v4.jsonl.zstd')
  const projection = join(tempRoot, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  await mkdir(dirname(body), { recursive: true })
  await mkdir(dirname(projection), { recursive: true })
  await writeFile(body, 'prepared-body')
  await writeFile(projection, '{"prepared":true}')

  const workspace = {
    sessionIds: [id],
    async detachSession(value) { this.sessionIds = this.sessionIds.filter((item) => item !== value) },
    async attachSession(value) { if (!this.sessionIds.includes(value)) this.sessionIds.push(value) }
  }
  const registry = {
    archivedSessionIds: [id],
    list: () => [workspace],
    async unarchiveSession(value) { this.archivedSessionIds = this.archivedSessionIds.filter((item) => item !== value) },
    async archiveSession(value) { if (!this.archivedSessionIds.includes(value)) this.archivedSessionIds.push(value) }
  }

  try {
    const prepared = await host.__test.prepareArchivedSessionDeletion({
      root: tempRoot, id, registry, sessions: { get: () => undefined }
    })
    await assert.rejects(access(body))
    await assert.rejects(access(projection))
    assert.deepEqual(registry.archivedSessionIds, [id], 'prepare 期间必须继续保持归档隐藏')
    assert.deepEqual(workspace.sessionIds, [id], 'prepare 期间不能提前发布工作区引用变更')

    const result = await host.__test.commitPreparedDeletion(prepared)
    assert.deepEqual(result, { id, sessionDirectories: 1, projection: true, workspaces: 1 })
    assert.deepEqual(registry.archivedSessionIds, [])
    assert.deepEqual(workspace.sessionIds, [])
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('两阶段删除显式回滚会恢复正文且不改变归档引用', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-explicit-rollback-'))
  const id = 'session-explicit-rollback'
  const body = join(tempRoot, 'sessions', 'workspace-a', id, 'session.v4.jsonl.zstd')
  const projection = join(tempRoot, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  await mkdir(dirname(body), { recursive: true })
  await mkdir(dirname(projection), { recursive: true })
  await writeFile(body, 'rollback-body')
  await writeFile(projection, '{"rollback":true}')

  const workspace = { sessionIds: [id] }
  const registry = { archivedSessionIds: [id], list: () => [workspace] }

  try {
    const prepared = await host.__test.prepareArchivedSessionDeletion({
      root: tempRoot, id, registry, sessions: { get: () => undefined }
    })
    await host.__test.rollbackPreparedDeletion(prepared)
    assert.equal(await readFile(body, 'utf8'), 'rollback-body')
    assert.equal(await readFile(projection, 'utf8'), '{"rollback":true}')
    assert.deepEqual(registry.archivedSessionIds, [id])
    assert.deepEqual(workspace.sessionIds, [id])
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('永久删除移除正文、投影缓存、归档引用和工作区引用', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-delete-'))
  const id = 'session-delete-test'
  const sessionDir = join(tempRoot, 'sessions', 'workspace-a', id)
  const projection = join(tempRoot, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  await mkdir(sessionDir, { recursive: true })
  await mkdir(dirname(projection), { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'session-body')
  await writeFile(projection, '{}')

  const workspace = {
    sessionIds: [id],
    async detachSession(value) { this.sessionIds = this.sessionIds.filter((item) => item !== value) },
    async attachSession(value) { if (!this.sessionIds.includes(value)) this.sessionIds.push(value) }
  }
  const registry = {
    archivedSessionIds: [id],
    list: () => [workspace],
    async unarchiveSession(value) { this.archivedSessionIds = this.archivedSessionIds.filter((item) => item !== value) },
    async archiveSession(value) { if (!this.archivedSessionIds.includes(value)) this.archivedSessionIds.push(value) }
  }

  try {
    const result = await host.__test.deleteArchivedSession({
      root: tempRoot, id, registry, sessions: { get: () => undefined }
    })
    assert.deepEqual(result, { id, sessionDirectories: 1, projection: true, workspaces: 1 })
    await assert.rejects(access(sessionDir))
    await assert.rejects(access(projection))
    assert.deepEqual(registry.archivedSessionIds, [])
    assert.deepEqual(workspace.sessionIds, [])
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('非归档或仍在运行的会话会被拒绝且文件保持不动', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-guard-'))
  const id = 'session-guard-test'
  const body = join(tempRoot, 'sessions', 'workspace-a', id, 'session.v4.jsonl.zstd')
  await mkdir(dirname(body), { recursive: true })
  await writeFile(body, 'keep-me')
  const registry = { archivedSessionIds: [], list: () => [] }

  try {
    await assert.rejects(
      host.__test.deleteArchivedSession({ root: tempRoot, id, registry }),
      (error) => error.code === 'not-archived'
    )
    assert.equal(await readFile(body, 'utf8'), 'keep-me')

    registry.archivedSessionIds.push(id)
    await assert.rejects(
      host.__test.deleteArchivedSession({
        root: tempRoot, id, registry, sessions: { get: () => ({ id }) }
      }),
      (error) => error.code === 'session-live'
    )
    assert.equal(await readFile(body, 'utf8'), 'keep-me')
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

await check('引用更新失败时恢复正文、投影及归档引用', async () => {
  const host = await import(`file://${resolve(root, 'lib/index.mjs').replace(/\\/g, '/')}`)
  const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-archived-rollback-'))
  const id = 'session-rollback-test'
  const body = join(tempRoot, 'sessions', 'workspace-a', id, 'session.v4.jsonl.zstd')
  const projection = join(tempRoot, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  await mkdir(dirname(body), { recursive: true })
  await mkdir(dirname(projection), { recursive: true })
  await writeFile(body, 'restore-me')
  await writeFile(projection, '{"keep":true}')

  const workspace = {
    sessionIds: [id],
    async detachSession() { throw new Error('simulated reference failure') },
    async attachSession(value) { if (!this.sessionIds.includes(value)) this.sessionIds.push(value) }
  }
  const registry = {
    archivedSessionIds: [id],
    list: () => [workspace],
    async unarchiveSession(value) { this.archivedSessionIds = this.archivedSessionIds.filter((item) => item !== value) },
    async archiveSession(value) { if (!this.archivedSessionIds.includes(value)) this.archivedSessionIds.push(value) }
  }

  try {
    await assert.rejects(
      host.__test.deleteArchivedSession({ root: tempRoot, id, registry }),
      /simulated reference failure/
    )
    assert.equal(await readFile(body, 'utf8'), 'restore-me')
    assert.equal(await readFile(projection, 'utf8'), '{"keep":true}')
    assert.deepEqual(registry.archivedSessionIds, [id])
    assert.deepEqual(workspace.sessionIds, [id])
  } finally {
    await rmdir(tempRoot, { recursive: true })
  }
})

console.log(`\n全部通过：${passed} 项`)
