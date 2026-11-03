/**
 * dsh-archived-sessions — 宿主半边（RPC 版，极薄）。
 *
 * 数据与操作全部走渲染进程的官方 Remote（ctx.remote.workspace），
 * 宿主半边不再注册任何路由、不读任何文件。保留这个文件只做一件事：
 * 在启动时触发 @deepseek-ai/dsh-workspace 的插件体，确保
 * workspaceRegistry（宿主侧）被激活，从而 Remote 的 workspace 命令
 * 有真实的宿主实现可调用。
 *
 * 面板 UI 与数据流见 lib/client.js。
 */

export const name = 'archived-sessions'

export const inject = ['loader']

/**
 * 从 Loader 行触发 `@deepseek-ai/dsh-workspace` 的插件体。
 * 只触发不 await —— 常驻服务的 Promise 永不 resolve。
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
    if (!names.includes('@deepseek-ai/dsh-workspace')) continue
    const apply = entry?.apply ?? entry?.plugin?.apply
    if (typeof apply !== 'function') continue
    try {
      const result = apply.call(entry, ctx)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* 降级 */
    }
    if (ctx.workspaceRegistry !== undefined) return ctx.workspaceRegistry
    break
  }
  return undefined
}

export function apply(ctx) {
  const registry = locateRegistry(ctx)
  if (registry !== undefined) {
    ctx.logger?.info?.('archived-sessions: workspaceRegistry 已就绪（数据走渲染进程 Remote）')
  } else {
    ctx.logger?.warn?.('archived-sessions: workspaceRegistry 未定位到；若面板为空请检查 profile 是否含 dsh-workspace')
  }
}

/** 供测试使用的纯函数导出。 */
export const __test = { locateRegistry }
