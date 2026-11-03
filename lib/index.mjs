/**
 * dsh-archived-sessions — 单文件 DSH 插件（宿主半边 lib/index.mjs + 浏览器半边 lib/client.js）。
 *
 * ⚠️ 本文件会被解析两次，用 `dsh.client` 标记切开：
 *   - 第一段（本注释到标记之前）作为 ES 模块加载 = 插件宿主入口
 *   - 第二段（标记之后）原样作为浏览器脚本执行 = __ModuleLoader__ 工厂模块
 * 所以两段之间不要放任何 ES 顶层语法（import/export 只能出现在第一段）。
 *
 * 为什么需要它：DSH 的「归档」只是往 ~/.dsh/storages/workspace.json 的
 * global.archivedSessionIds 追加会话 id，会话正文、工作区槽位、磁盘日志都不动；
 * 但官方 Web 前端没有任何「查看归档」入口，归档之后就再也找不到那个会话。
 * 本插件补上侧栏「已归档」面板：可搜索、可恢复、可临时打开。
 *
 * 安装：dsh plugin --profile desktop add github:<账号>/dsh-archived-sessions
 * 完全卸载：`dsh plugin remove` 之后删掉两处产物与 ~/.dsh/storages/archived-sessions.html。
 */

export const name = 'archived-sessions'

/** 运行期注入：webServer 提供路由，loader 用来定位 workspace 包。 */
export const inject = ['webServer', 'loader']

/** 路由前缀，浏览器半边共用同一常量值。 */
const ROUTE = '/api/archived-sessions'
/** 提供 workspaceRegistry 服务的官方包名。 */
const PKG_WORKSPACE = '@deepseek-ai/dsh-workspace'
/** 临时打开（交接）窗口：只够浏览器发起一次导航。 */
const HANDOFF_TTL_MS = 20_000
/** 面板路由：由 Web 渲染进程反代到这里的独立静态页。 */
const PANEL_ROUTE = '/api/archived-sessions/panel'

/** 把一个 JSON 字符串字面量解码成普通字符串（只处理常见转义）。 */
function unescapeJsonString(value) {
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_all, ch) => {
    if (ch.length === 5 && ch[0] === 'u') return String.fromCharCode(parseInt(ch.slice(1), 16))
    const table = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    return table[ch] ?? ch
  })
}

/**
 * 读取会话投影缓存里的展示字段（标题、首条提问、轮次、token、时间）。
 * 投影服务不在同一棵树时直接读文件最稳；读不到就返回 undefined，
 * 只影响展示，不影响列表和恢复。
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
    const pick = (re) => {
      const m = re.exec(text)
      return m === null ? undefined : unescapeJsonString(m[1])
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
 * 从 Loader 行拿到 workspaceRegistry 服务。
 *
 * 该服务注册名是 `workspaceRegistry`，但它不在任何 Loader 行上，不能靠
 * `inject` 字符串注入。可行路径：先看同根 ctx 是否已有；否则找到
 * `@deepseek-ai/dsh-workspace` 的 Loader 行，借用它的 `apply(ctx)`
 * （官方实现就是 `ctx.plugin(WorkspaceRegistry)`）让服务在同一根 ctx 出现。
 * @param {any} ctx
 */
async function locateRegistry(ctx) {
  if (ctx.workspaceRegistry !== undefined) return ctx.workspaceRegistry
  for (const entry of ctx.loader.entries()) {
    const options = entry?.options ?? {}
    const names = [options.name, options.id, options.package, options.module, entry?.name]
    if (!names.includes(PKG_WORKSPACE)) continue
    const apply = entry?.apply ?? entry?.plugin?.apply
    if (typeof apply !== 'function') continue
    try {
      await apply.call(entry, ctx)
    } catch {
      /* 探测失败就让调用方降级 */
    }
    if (ctx.workspaceRegistry !== undefined) return ctx.workspaceRegistry
    break
  }
  return undefined
}

/** 交接令牌：记录谁被临时解除归档，TTL 或首次认领后失效。 */
function createHandoff() {
  let active
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

/** JSON 响应。 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

/** 安全解析请求体。 */
async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/**
 * 把面板 HTML 写到 ~/.dsh/storages/archived-sessions.html，供 Web 渲染进程反代读取。
 * 写失败（只读目录等）只告警，不影响路由本身。
 * @param {any} ctx
 */
async function publishPanel(ctx) {
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const root = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(root, 'storages')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'archived-sessions.html'), renderPanelHtml(), 'utf8')
  } catch (error) {
    ctx.logger?.warn?.(`archived-sessions: 面板页写入失败（不影响恢复功能）：${String(error)}`)
  }
}

export function apply(ctx) {
  const handoff = createHandoff()
  let pending

  const registry = () => {
    if (pending === undefined) {
      pending = locateRegistry(ctx).then((found) => {
        if (found !== undefined) ctx.logger?.info?.('archived-sessions: workspaceRegistry 已就绪')
        else ctx.logger?.warn?.('archived-sessions: 未找到 workspaceRegistry，面板将显示不可用')
        return found
      })
    }
    return pending
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (request) => {
      const url = new URL(request.url, 'http://dsh.invalid')
      const action = url.pathname
        .slice(ROUTE.length)
        .replace(/^\/+/, '')
        .replace(/\/+$/, '')

      if (action === 'panel') {
        return new Response(renderPanelHtml(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        })
      }

      if (action === 'list') {
        const reg = await registry()
        if (reg === undefined) {
          return json({ ok: false, available: false, reason: 'workspaceRegistry-unavailable', sessions: [] })
        }
        const archived = reg.archivedSessionIds.map(String)
        const sessions = await Promise.all(archived.map(async (id) => ({
          id,
          ...(await readProjection(id) ?? {})
        })))
        sessions.sort((left, right) =>
          (right.lastPromptAt ?? right.createdAt ?? 0) - (left.lastPromptAt ?? left.createdAt ?? 0))
        return json({ ok: true, available: true, count: archived.length, sessions })
      }

      if (action === 'unarchive') {
        if (request.method !== 'POST') return json({ ok: false, reason: 'method-not-allowed' }, 405)
        const reg = await registry()
        if (reg === undefined) return json({ ok: false, reason: 'workspaceRegistry-unavailable' }, 503)
        const body = await readJson(request)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') return json({ ok: false, reason: 'missing-id' }, 400)
        await reg.unarchiveSession(id)
        return json({ ok: true, id, archived: reg.archivedSessionIds.map(String) })
      }

      if (action === 'open') {
        if (request.method !== 'POST') return json({ ok: false, reason: 'method-not-allowed' }, 405)
        const reg = await registry()
        if (reg === undefined) return json({ ok: false, reason: 'workspaceRegistry-unavailable' }, 503)
        const body = await readJson(request)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '' || !reg.archivedSessionIds.includes(id)) {
          return json({ ok: false, reason: 'not-archived' }, 404)
        }
        // 交接：临时解除归档，交给浏览器打开；TTL 到期自动回落。
        await reg.unarchiveSession(id)
        return json({ ok: true, id, ...handoff.arm(id) })
      }

      if (action === 'claim') {
        const id = handoff.claim(url.searchParams.get('token') ?? '')
        if (id === undefined) return json({ ok: false, reason: 'expired' }, 410)
        const reg = await registry()
        if (reg !== undefined && !reg.archivedSessionIds.includes(id)) {
          await reg.archiveSession(id, { stopActivity: true })
        }
        return json({ ok: true, id })
      }

      return json({ ok: false, reason: 'not-found' }, 404)
    }
  }), 'archived-sessions: /api/archived-sessions')

  ctx.effect(() => () => handoff.dispose(), 'archived-sessions: handoff timer')

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      void publishPanel(webCtx)
    }, 'archived-sessions: panel asset')
  })
}

/* dsh.client =================================================================
 * 以下内容不属于宿主模块：它是原样发给浏览器的脚本。
 * 数据只经由宿主的 /api/archived-sessions/* 路由读写，页面本身不含任何
 * Electron / Node 权限，也不会内联 JSON（避免把 script 段提前切断）。
 * ========================================================================== */

/** 面板页：极简原生 JS，无构建、无外部依赖。 */
function renderPanelHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>已归档会话 · DSH</title>
<style>
:root{color-scheme:light dark;--line:rgba(127,127,127,.28);--soft:rgba(127,127,127,.07);--accent:#3c78ff;--danger:#e5484d}
*{box-sizing:border-box}
body{margin:0;padding:20px 18px 40px;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:inherit;background:transparent}
h1{margin:0;font-size:16px;font-weight:600}
.sub{margin:6px 0 16px;font-size:12px;opacity:.6;line-height:1.6}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:12px}
input{flex:1;min-width:0;height:32px;padding:0 10px;font-size:13px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;outline:none}
input:focus{border-color:var(--accent)}
button{height:30px;padding:0 12px;font-size:12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button:hover{background:var(--soft)}
button.primary{border-color:rgba(60,120,255,.55);color:var(--accent)}
button:disabled{opacity:.5;cursor:not-allowed}
.count{font-size:11px;opacity:.5;margin-left:auto}
.list{display:flex;flex-direction:column;gap:8px}
.card{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--soft)}
.card.pulse{animation:pulse 1.2s ease}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(60,120,255,.5)}100%{box-shadow:0 0 0 14px rgba(60,120,255,0)}}
.head{display:flex;gap:8px;align-items:baseline}
.title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.id{font-size:10px;opacity:.42;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.meta{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;opacity:.55}
.actions{display:flex;justify-content:flex-end;gap:8px}
.hint{padding:14px 0;text-align:center;font-size:12px;opacity:.55}
.err{font-size:12px;color:var(--danger)}
.notice{font-size:12px;opacity:.8;margin-bottom:10px}
</style>
</head>
<body>
<h1>已归档会话</h1>
<p class="sub">归档只是把会话从列表里藏起来，内容与日志都还在磁盘上。恢复后会话回到原工作区原位；「打开」会临时解除归档 20 秒，随后自动归档。</p>
<div class="bar">
  <input id="q" placeholder="搜索标题、首条提问或会话 id…" aria-label="搜索">
  <button id="refresh" type="button">刷新</button>
</div>
<div class="count" id="count"></div>
<div class="notice" id="notice" hidden></div>
<div class="list" id="list"></div>
<script>
(function () {
  'use strict';
  var API = 'api/archived-sessions/';
  var el = {
    q: document.getElementById('q'),
    refresh: document.getElementById('refresh'),
    count: document.getElementById('count'),
    notice: document.getElementById('notice'),
    list: document.getElementById('list')
  };
  var state = { sessions: [], loading: true, available: true, error: '', openedId: '' };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function time(ms) {
    if (!ms || !isFinite(ms)) return '';
    var d = new Date(ms);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function request(action, init) {
    return fetch(API + action, init).then(function (response) {
      return response.text().then(function (text) {
        var body = {};
        if (text) { try { body = JSON.parse(text); } catch (e) { throw new Error(response.status + ' ' + text.slice(0, 160)); } }
        if (!response.ok) throw new Error(body.reason || String(response.status));
        return body;
      });
    });
  }

  function notify(text, isError) {
    el.notice.hidden = !text;
    el.notice.textContent = text || '';
    el.notice.className = isError ? 'err' : 'notice';
  }

  function render() {
    var keyword = el.q.value.trim().toLowerCase();
    var rows = state.sessions.filter(function (session) {
      if (!keyword) return true;
      return ((session.title || '') + '\\n' + (session.firstPrompt || '') + '\\n' + session.id).toLowerCase().indexOf(keyword) >= 0;
    });
    el.count.textContent = state.loading ? '读取中…' : ('共 ' + state.sessions.length + ' 个归档会话');

    if (state.error) {
      el.list.innerHTML = '<div class="err">读取失败：' + esc(state.error) + '</div>';
      return;
    }
    if (state.loading) { el.list.innerHTML = '<div class="hint">读取中…</div>'; return; }
    if (!state.available) { el.list.innerHTML = '<div class="hint">当前宿主没有暴露 workspaceRegistry，面板暂不可用</div>'; return; }
    if (state.sessions.length === 0) { el.list.innerHTML = '<div class="hint">还没有归档任何会话</div>'; return; }
    if (rows.length === 0) { el.list.innerHTML = '<div class="hint">没有匹配的归档会话</div>'; return; }

    el.list.innerHTML = rows.map(function (session) {
      var meta = [];
      if (session.turns > 0) meta.push(session.turns + ' 轮');
      var stamp = time(session.lastPromptAt) || time(session.createdAt);
      if (stamp) meta.push(stamp);
      if (session.inputTokens || session.outputTokens) meta.push('入 ' + (session.inputTokens || 0) + ' / 出 ' + (session.outputTokens || 0) + ' tokens');
      var title = (session.title || '').trim() || '（无标题）';
      return '<div class="card' + (session.id === state.openedId ? ' pulse' : '') + '" data-id="' + esc(session.id) + '">' +
        '<div class="head"><span class="title" title="' + esc(title) + '">' + esc(title) + '</span>' +
        '<code class="id" title="' + esc(session.id) + '">' + esc(String(session.id).replace(/^session-/, '').slice(0, 8)) + '</code></div>' +
        (meta.length ? '<div class="meta">' + meta.map(function (item) { return '<span>' + esc(item) + '</span>'; }).join('') + '</div>' : '') +
        '<div class="actions"><button type="button" data-act="open">打开</button>' +
        '<button type="button" class="primary" data-act="restore">恢复</button></div></div>';
    }).join('');
  }

  function load() {
    state.loading = true;
    state.error = '';
    render();
    return request('list').then(function (body) {
      state.loading = false;
      state.available = body.available !== false;
      state.sessions = Array.isArray(body.sessions) ? body.sessions : [];
      render();
    }, function (error) {
      state.loading = false;
      state.error = String(error.message || error);
      render();
    });
  }

  function busy(card, value) {
    card.style.opacity = value ? '.55' : '';
    Array.prototype.forEach.call(card.querySelectorAll('button'), function (button) { button.disabled = value; });
  }

  el.list.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var card = button.closest('.card');
    var id = card.getAttribute('data-id');
    var act = button.getAttribute('data-act');
    busy(card, true);
    notify('', false);
    if (act === 'restore') {
      request('unarchive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: id })
      }).then(function () {
        notify('已恢复到原工作区');
        return load();
      }, function (error) {
        busy(card, false);
        notify('恢复失败：' + error.message, true);
      });
      return;
    }
    request('open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: id })
    }).then(function (lease) {
      state.openedId = id;
      notify('已临时解除归档，请在 DSH 会话列表里打开它；20 秒后自动回到归档');
      render();
      return request('claim?token=' + encodeURIComponent(lease.token)).then(load, load);
    }).catch(function (error) {
      busy(card, false);
      notify('打开失败：' + error.message, true);
    });
  });

  el.q.addEventListener('input', render);
  el.refresh.addEventListener('click', function () { void load(); });
  load();
})();
</script>
</body>
</html>
`
}
