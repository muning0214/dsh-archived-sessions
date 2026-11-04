import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rmdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const name = 'archived-sessions'
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessions']

export const ROUTE = '/api/archived-sessions'
export const DELETE_ROUTE = `${ROUTE}/delete`
export const TOKEN_USAGE_ROUTE = `${ROUTE}/token-usage`
const SESSION_ID = /^session-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DELETE_TRANSACTION_TTL_MS = 60_000

class DeleteSessionError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'DeleteSessionError'
    this.code = code
    this.status = status
  }
}

function locateRegistry(ctx) {
  return ctx.workspaceRegistry
}

function validateSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID.test(value) || basename(value) !== value) {
    throw new DeleteSessionError('invalid-session-id', '会话 id 不合法')
  }
  return value
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function tokenCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

async function readTokenUsage(root, id) {
  validateSessionId(id)
  const path = resolve(root, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  try {
    const record = JSON.parse(await readFile(path, 'utf8'))
    const totals = record?.record?.rows?.tokenUsage?.val?.totals ?? {}
    return {
      uncachedInputTokens: tokenCount(totals.uncachedInputTokens),
      outputTokens: tokenCount(totals.outputTokens)
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) {
      return { uncachedInputTokens: 0, outputTokens: 0 }
    }
    throw error
  }
}

async function readArchivedIds(root, registry) {
  if (registry !== undefined) return registry.archivedSessionIds.map(String)
  const state = JSON.parse(await readFile(resolve(root, 'storages', 'workspace.json'), 'utf8'))
  return Array.isArray(state?.global?.archivedSessionIds)
    ? state.global.archivedSessionIds.map(String)
    : []
}

async function readArchivedTokenUsage({ root, ids, registry }) {
  if (!Array.isArray(ids) || ids.length > 5000) {
    throw new DeleteSessionError('invalid-session-ids', '会话 id 列表不合法')
  }
  const archived = new Set(await readArchivedIds(root, registry))
  const selected = [...new Set(ids.map(validateSessionId))].filter((id) => archived.has(id))
  const entries = await Promise.all(selected.map(async (id) => [id, await readTokenUsage(root, id)]))
  return Object.fromEntries(entries)
}

async function findSessionDirectories(root, id) {
  const sessionsRoot = resolve(root, 'sessions')
  let workspaceDirectories = []
  try {
    workspaceDirectories = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }

  const matches = []
  for (const workspace of workspaceDirectories) {
    if (!workspace.isDirectory()) continue
    const candidate = resolve(sessionsRoot, workspace.name, id)
    if (!candidate.startsWith(`${sessionsRoot}\\`) && candidate !== sessionsRoot) continue
    if (await exists(candidate)) matches.push(candidate)
  }
  return matches
}

async function moveIntoStaging(source, target, moved) {
  if (!await exists(source)) return
  await mkdir(dirname(target), { recursive: true })
  await rename(source, target)
  moved.push({ source, target })
}

async function restoreMoved(moved) {
  for (const item of [...moved].reverse()) {
    if (!await exists(item.target)) continue
    await mkdir(dirname(item.source), { recursive: true })
    await rename(item.target, item.source)
  }
}

async function removeTree(path) {
  try {
    await rmdir(path, { recursive: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function rollbackRegistry(registry, id, owners) {
  for (const workspace of owners) {
    if (!workspace.sessionIds.includes(id)) await workspace.attachSession(id)
  }
  if (!registry.archivedSessionIds.includes(id)) {
    await registry.archiveSession(id, { stopActivity: true })
  }
}

async function prepareArchivedSessionDeletion({ root, id, registry, sessions }) {
  validateSessionId(id)
  if (!registry.archivedSessionIds.map(String).includes(id)) {
    throw new DeleteSessionError('not-archived', '只能永久删除仍处于归档状态的会话', 409)
  }
  if (sessions?.get?.(id) !== undefined) {
    throw new DeleteSessionError('session-live', '该会话仍在运行时内存中，请重启 DSH 后再删除', 409)
  }

  const owners = registry.list().filter((workspace) => workspace.sessionIds.map(String).includes(id))
  const sessionDirectories = await findSessionDirectories(root, id)
  const projection = resolve(root, 'storages', 'session_projcache', 'sessions', `${id}.json`)
  const staging = resolve(root, 'storages', `.archived-sessions-delete-${randomBytes(16).toString('hex')}`)
  const moved = []

  try {
    for (const [index, source] of sessionDirectories.entries()) {
      await moveIntoStaging(source, join(staging, `session-${index}`), moved)
    }
    await moveIntoStaging(projection, join(staging, 'projection.json'), moved)
  } catch (error) {
    await restoreMoved(moved).catch(() => {})
    await removeTree(staging).catch(() => {})
    throw error
  }

  return {
    id,
    registry,
    owners,
    moved,
    staging,
    result: {
      id,
      sessionDirectories: sessionDirectories.length,
      projection: moved.some((item) => item.source === projection),
      workspaces: owners.length
    }
  }
}

async function rollbackPreparedDeletion(prepared) {
  await restoreMoved(prepared.moved)
  await removeTree(prepared.staging)
}

async function commitPreparedDeletion(prepared) {
  const { id, registry, owners, moved, staging } = prepared
  try {
    await registry.unarchiveSession(id)
    for (const workspace of owners) await workspace.detachSession(id)
    await removeTree(staging)
  } catch (error) {
    await restoreMoved(moved).catch(() => {})
    await rollbackRegistry(registry, id, owners).catch(() => {})
    await removeTree(staging).catch(() => {})
    throw error
  }
  return prepared.result
}

/** Permanently remove one archived, cold Session in one call for tests/tools. */
async function deleteArchivedSession(options) {
  const prepared = await prepareArchivedSessionDeletion(options)
  return commitPreparedDeletion(prepared)
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  })
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function requestAction(request) {
  const raw = typeof request.url === 'string' ? request.url : ''
  const withoutScheme = raw.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/, '')
  const pathname = withoutScheme.split(/[?#]/, 1)[0]
  return pathname
    .replace(new RegExp(`^.*${ROUTE}`), '')
    .replace(/^\/+|\/+$/g, '')
}

export function apply(ctx) {
  const pendingDeletes = new Map()
  const initialRegistry = locateRegistry(ctx)
  if (initialRegistry !== undefined) {
    ctx.logger?.info?.('archived-sessions: workspaceRegistry 已就绪')
  } else {
    ctx.logger?.warn?.('archived-sessions: workspaceRegistry 未注入，永久删除不可用')
  }

  for (const [action, path] of [['delete', DELETE_ROUTE], ['token-usage', TOKEN_USAGE_ROUTE]]) {
    ctx.effect(() => ctx.connection.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method !== 'POST') return json({ ok: false, reason: 'method-not-allowed' }, 405)
        const registry = locateRegistry(ctx)
        if (action === 'delete' && registry === undefined) {
          return json({ ok: false, reason: 'workspace-unavailable' }, 503)
        }

        try {
          const body = await readJson(request)
          const root = process.env.DSH_HOME || join(homedir(), '.dsh')
          if (action === 'token-usage') {
            const tokenUsageById = await readArchivedTokenUsage({
              root,
              ids: body?.ids,
              registry
            })
            return json({ ok: true, tokenUsageById })
          }
          const phase = body?.phase
          if (phase === 'prepare') {
            if ([...pendingDeletes.values()].some((entry) => entry.prepared.id === body?.id)) {
              throw new DeleteSessionError('delete-pending', '该会话已有删除事务正在进行', 409)
            }
            const prepared = await prepareArchivedSessionDeletion({
              root,
              id: body?.id,
              registry,
              sessions: ctx.sessions
            })
            const token = randomBytes(24).toString('hex')
            const timer = setTimeout(() => {
              const entry = pendingDeletes.get(token)
              if (entry === undefined) return
              pendingDeletes.delete(token)
              rollbackPreparedDeletion(entry.prepared).catch((error) => {
                ctx.logger?.warn?.(`archived-sessions: 删除事务超时回滚失败：${String(error?.message ?? error)}`)
              })
            }, DELETE_TRANSACTION_TTL_MS)
            timer.unref?.()
            pendingDeletes.set(token, { prepared, timer })
            return json({ ok: true, token, id: prepared.id, expiresInMs: DELETE_TRANSACTION_TTL_MS })
          }

          const token = typeof body?.token === 'string' ? body.token : ''
          const entry = pendingDeletes.get(token)
          if (entry === undefined) {
            throw new DeleteSessionError('delete-transaction-missing', '删除事务不存在或已超时', 409)
          }
          clearTimeout(entry.timer)
          pendingDeletes.delete(token)
          if (phase === 'rollback') {
            await rollbackPreparedDeletion(entry.prepared)
            return json({ ok: true, rolledBack: true, id: entry.prepared.id })
          }
          if (phase !== 'commit') {
            await rollbackPreparedDeletion(entry.prepared)
            throw new DeleteSessionError('invalid-delete-phase', '删除阶段不合法')
          }
          const result = await commitPreparedDeletion(entry.prepared)
          return json({ ok: true, deleted: result })
        } catch (error) {
          const status = error instanceof DeleteSessionError ? error.status : 500
          const reason = error instanceof DeleteSessionError ? error.code : `${action}-failed`
          ctx.logger?.warn?.(`archived-sessions: ${action} 处理失败：${String(error?.message ?? error)}`)
          return json({
            ok: false,
            reason,
            message: String(error?.message ?? error)
          }, status)
        }
      }
    }), `archived-sessions: ${action} route`)
  }

  ctx.effect(() => async () => {
    const entries = [...pendingDeletes.values()]
    pendingDeletes.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      await rollbackPreparedDeletion(entry.prepared).catch(() => {})
    }
  }, 'archived-sessions: rollback pending deletes on dispose')
}

export const __test = {
  deleteArchivedSession,
  findSessionDirectories,
  locateRegistry,
  readArchivedIds,
  readArchivedTokenUsage,
  readTokenUsage,
  commitPreparedDeletion,
  prepareArchivedSessionDeletion,
  requestAction,
  rollbackPreparedDeletion,
  validateSessionId
}
