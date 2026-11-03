/**
 * dsh-archived-sessions — 宿主（host）半边。
 *
 * 背景：DSH 把「归档」写进 `workspaceRegistry.archivedSessionIds`（注册表级隐藏
 * 名单），会话本身、工作区槽位、磁盘日志都不动，只是被所有分组界面过滤掉。
 * 而 Web 前端没有提供查看归档的入口 —— 归档之后就再也找不到那个会话了。
 *
 * 本插件补上这个缺口，只做三件事（全部是可回退的读操作 + 官方恢复 API）：
 *
 *   1. `GET  /api/archived-sessions/list`      归档会话清单（含标题、工作区、
 *                                              轮次、token、时间等展示信息）
 *   2. `POST /api/archived-sessions/unarchive` 恢复一个会话，内部调用
 *                                              `workspaceRegistry.unarchiveSession()`
 *                                              与官方 `unarchiveSession` Remote
 *                                              走同一套持久化路径
 *   3. `POST /api/archived-sessions/open`      交接（handoff）：归档集里临时摘掉该
 *                                              会话一小段时间，让浏览器跳转到会话
 *                                              页时官方列表仍把它当作可打开的会话；
 *                                              到期自动恢复归档。
 *
 * 为什么不用 `connection.fetch`：`connection` 是 Web 授权通道，非桌面宿主里
 * 不一定存在；`webServer.register` 是基础能力，且与 `dsh-client-modules`
 * 注册 `/plugins` 路由用的是同一套 API，兼容面最大。若你的宿主需要鉴权，
 * 把 `inject` 加上 `'connection'` 并改用 `ctx.connection.fetch.register` 即可。
 */

export const name = 'archived-sessions'

export const inject = ['webServer', 'loader']

/**
 * 路由前缀；与 client 半边共用同一常量值。
 *
 * ⚠️ 千万不要放在 `/api` 下面。`@deepseek-ai/dsh-client-connection` 把整个
 * `/api` 前缀注册成自己的兜底路由（先 connection.admit(req) 鉴权，再交给
 * connection/request waterfall 分发），插件挂在其下的路径要么被 401 拦掉，
 * 要么根本不落到自己的 handler —— 表现就是 fetch 永远 pending。
 * 用一个独立前缀，跟官方 RPC 通道井水不犯河水。
 */
export const ROUTE = '/x-archived-sessions'
/** 提供 `workspaceRegistry` 服务的官方包名。 */
const PKG_WORKSPACE = '@deepseek-ai/dsh-workspace'
/** 交接窗口：只够浏览器发起一次导航。 */
const HANDOFF_TTL_MS = 20_000

/**
 * 读取会话投影缓存里的展示字段（标题、首条提问、轮次、token、时间）。
 * 投影服务不在同一棵树上时，直接读文件最稳；读不到就返回 undefined，
 * 不影响列表和恢复功能本身。
 * @param {string} id 会话 id
 */
async function readProjection(id) {
  try {
    const { readFile } = await import('node:fs/promises')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const root = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    const text = await readFile(file, 'utf8')
    const unescape = (value) => value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, c) => {
      if (c.length === 5 && c[0] === 'u') return String.fromCharCode(parseInt(c.slice(1), 16))
      return { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c] ?? c
    })
    const pick = (re) => {
      const m = re.exec(text)
      return m === null ? undefined : unescape(m[1])
    }
    const title = pick(/"title":\s*\{\s*"ver":\s*\d+,\s*"seq":\s*\d+,\s*"val":\s*"((?:[^"\\]|\\.)*)"/)
    const firstPrompt = pick(/"titleInput"[\s\S]{0,800}?"text":\s*"((?:[^"\\]|\\.)*)"/)
    const turns = pick(/"turns":\s*(\d+),\s*"steps"/)
    const lastPromptAt = pick(/"lastPromptAt":\s*(\d+)/)
    const createdAt = pick(/"createdAt":\s*(\d+)/)
    const inputTokens = pick(/"uncachedInputTokens":\s*(\d+)/)
    const outputTokens = pick(/"outputTokens":\s*(\d+)/)
    const number = (value) => (value === undefined ? undefined : Number(value))
    return {
      title: title ?? firstPrompt ?? '',
      firstPrompt: firstPrompt ?? '',
      turns: number(turns) ?? 0,
      createdAt: number(createdAt),
      lastPromptAt: number(lastPromptAt),
      inputTokens: number(inputTokens) ?? 0,
      outputTokens: number(outputTokens) ?? 0
    }
  } catch {
    return undefined
  }
}

/**
 * 从 Loader 行拿到 `workspaceRegistry` 服务。
 *
 * 该服务由 `@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry` 提供，注册名
 * 是 `workspaceRegistry`，但它不在任何 Loader 行上，因此不能靠 `inject`
 * 字符串拿到。
 *
 * ⚠️ 关键：不能 `await apply.call(entry, ctx)`。官方 apply 内部是
 * `ctx.plugin(WorkspaceRegistry)`，它返回的 Promise 会一直挂着（插件本身就是
 * 常驻服务），await 会让整条路由永远不返回 —— 面板就会一直停在「读取中…」。
 * 这里只做「同步触发 + 同步检查」，拿到就返回，拿不到让调用方降级。
 * @param {any} ctx
 */
function locateRegistry(ctx) {
  if (ctx.workspaceRegistry !== undefined) return ctx.workspaceRegistry

  let entries = []
  try {
    entries = ctx.loader?.entries?.() ?? []
  } catch {
    return undefined
  }

  for (const entry of entries) {
    const options = entry?.options ?? {}
    const names = [options.name, options.id, options.package, options.module, entry?.name]
    if (!names.includes(PKG_WORKSPACE)) continue
    const apply = entry?.apply ?? entry?.plugin?.apply
    if (typeof apply !== 'function') continue
    try {
      // 只触发，不 await：apply 返回的 Promise 是常驻插件生命周期，永不 resolve。
      const result = apply.call(entry, ctx)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* 触发失败就降级 */
    }
    break
  }

  return ctx.workspaceRegistry
}

/**
 * 交接令牌：记录「谁被临时解除归档」，并在 TTL 或首次认领后失效。
 * 会话 id 被浏览器放在地址里，服务端只认令牌，避免把任意 id 交给前端去拼。
 */
function createHandoff() {
  /** @type {{ id: string, token: string, at: number } | undefined} */
  let active
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    active = undefined
  }
  return {
    arm(id) {
      clear()
      active = {
        id,
        token: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        at: Date.now()
      }
      timer = setTimeout(clear, HANDOFF_TTL_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return { token: active.token, expiresAt: active.at + HANDOFF_TTL_MS }
    },
    claim(token) {
      if (active === undefined || active.token !== token) return undefined
      const id = active.id
      clear()
      return id
    },
    dispose: clear
  }
}

/** @param {unknown} body @param {number} status */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/** @param {Request} request */
async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * 从请求里取出 `action` 与查询参数。
 *
 * 不能用 `new URL(request.url, base)`：桌面宿主的请求地址是 `dsh-app://...`
 * 这类自定义 scheme，URL 构造会抛 TypeError，网关转而回 400。
 * 这里只用字符串切分，任何 scheme 都能处理。
 * @param {Request} request
 */
function parseRequest(request) {
  const raw = typeof request.url === 'string' ? request.url : ''
  // 去掉 scheme://host 部分，只留路径与查询串
  const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/, '')
  const hashIndex = withoutScheme.indexOf('#')
  const withoutHash = hashIndex === -1 ? withoutScheme : withoutScheme.slice(0, hashIndex)
  const queryIndex = withoutHash.indexOf('?')
  const pathname = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)
  const search = queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1)

  const action = pathname
    .replace(new RegExp(`^.*${ROUTE}`), '') // 前缀之后的部分才算 action
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  const searchParams = new URLSearchParams(search)
  return { action, searchParams, pathname, search }
}

export function apply(ctx) {
  const handoff = createHandoff()
  let logged = false

  /**
   * 取 workspaceRegistry。locateRegistry 是同步的，不会挂起请求。
   * 拿不到时返回 undefined，路由降级成 available:false，面板给出提示。
   */
  const registry = () => {
    const found = locateRegistry(ctx)
    if (!logged) {
      logged = true
      if (found !== undefined) ctx.logger?.info?.('archived-sessions: workspaceRegistry 已就绪')
      else ctx.logger?.warn?.('archived-sessions: 未找到 workspaceRegistry，面板将显示不可用')
    }
    return found
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (request) => {
      try {
        return await handle(request)
      } catch (error) {
        // 任何异常都转成 JSON，绝不把 400/500 丢给面板
        ctx.logger?.warn?.(`archived-sessions: 处理 ${request.url} 失败：${String(error)}`)
        return json({ ok: false, reason: 'internal-error', message: String(error?.message ?? error) }, 500)
      }
    }
  }), 'archived-sessions: /x-archived-sessions')

  async function handle(request) {
    const { action, searchParams } = parseRequest(request)

    if (action === 'list') {
      const reg = registry()
      if (reg === undefined) {
        return json({ ok: false, available: false, reason: 'workspaceRegistry-unavailable', sessions: [] })
      }
      const archived = reg.archivedSessionIds.map(String)
      const sessions = await Promise.all(archived.map(async (id) => ({
        id,
        ...(await readProjection(id) ?? {})
      })))
      sessions.sort((left, right) => (right.lastPromptAt ?? right.createdAt ?? 0) - (left.lastPromptAt ?? left.createdAt ?? 0))
      return json({ ok: true, available: true, count: archived.length, sessions })
    }

    if (action === 'unarchive') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method-not-allowed' }, 405)
      const reg = registry()
      if (reg === undefined) return json({ ok: false, reason: 'workspaceRegistry-unavailable' }, 503)
      const body = await readJson(request)
      const id = typeof body?.id === 'string' ? body.id : ''
      if (id === '') return json({ ok: false, reason: 'missing-id' }, 400)
      await reg.unarchiveSession(id)
      return json({ ok: true, id, archived: reg.archivedSessionIds.map(String) })
    }

    if (action === 'open') {
      if (request.method !== 'POST') return json({ ok: false, reason: 'method-not-allowed' }, 405)
      const reg = registry()
      if (reg === undefined) return json({ ok: false, reason: 'workspaceRegistry-unavailable' }, 503)
      const body = await readJson(request)
      const id = typeof body?.id === 'string' ? body.id : ''
      if (id === '' || !reg.archivedSessionIds.includes(id)) {
        return json({ ok: false, reason: 'not-archived' }, 404)
      }
      // 交接：临时解除归档，交给浏览器去打开；TTL 到期自动回落。
      await reg.unarchiveSession(id)
      const lease = handoff.arm(id)
      return json({ ok: true, id, ...lease })
    }

    if (action === 'claim') {
      const id = handoff.claim(searchParams.get('token') ?? '')
      if (id === undefined) return json({ ok: false, reason: 'expired' }, 410)
      const reg = registry()
      // 认领即重新归档：会话页已经拿到了会话，恢复隐藏状态。
      if (reg !== undefined && !reg.archivedSessionIds.includes(id)) {
        await reg.archiveSession(id, { stopActivity: true })
      }
      return json({ ok: true, id })
    }

    return json({ ok: false, reason: 'not-found' }, 404)
  }

  ctx.effect(() => () => handoff.dispose(), 'archived-sessions: handoff timer')
}

/**
 * 供测试使用的纯函数导出。
 * 生产路径不会读它，也不会因为它的存在改变任何行为。
 */
export const __test = { readProjection, createHandoff, parseRequest }
