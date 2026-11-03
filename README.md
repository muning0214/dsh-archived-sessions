# dsh-archived-sessions

> 给 DeepSeek Harness 补一个「已归档会话」面板：归档之后仍然找得到，能搜索、能恢复、能临时打开。
>
> **整个插件就是一个文件**：[`lib/index.mjs`](lib/index.mjs)。加上 `package.json`（DSH 靠它识别插件）和 `cordis.patch.yml`（四行，DSH 靠它把插件挂进 profile），一共三份。

## 为什么需要它

DSH 的「归档」不是删除，也不是挪进某个文件夹 —— 它往 `~/.dsh/storages/workspace.json`
的 `global.archivedSessionIds` 里追加一个会话 id，于是这个会话被所有分组界面过滤掉。
会话正文（`sessions/<工作区>/<会话>/session.v4.jsonl.zstd`）、工作区槽位、磁盘文件全都原样保留。

问题在于**归档之后就再也没有入口把它找回来**：官方 Web 前端主包里 `archived` 出现 0 次，
`dsh-client-ui-sidebar`、`dsh-client-ui-session` 等界面包也没有任何「查看归档」的入口；
只有 `dsh-api-workspace-controller` 暴露了 `archiveSession` / `unarchiveSession` 两个 Remote 方法。

本插件把这两个官方能力接到界面上。

## 安装

需要 DSH 0.2.x（桌面版 / web 版均可）。

```bash
# 从 GitHub 装（桌面版 profile）
dsh plugin --profile desktop add github:<你的账号>/dsh-archived-sessions

# 或本地路径
dsh plugin --profile desktop add link:/绝对路径/dsh-archived-sessions
```

装完重启 DSH。侧栏（或「更多」面板）里会出现「**已归档**」入口。

## 用法

打开「已归档」面板后：

| 操作 | 效果 |
|---|---|
| 搜索框 | 按标题 / 首条提问 / 会话 id 即时过滤 |
| **恢复** | 调用 `workspaceRegistry.unarchiveSession(id)`，会话按原顺序回到原工作区（不是追加到末尾） |
| **打开** | 把会话从归档集里临时摘出 20 秒并发放一次性令牌，观察完自动重新归档；只想瞄一眼、不想永久恢复时用 |

每条会话显示标题、短 id、轮次、最后活动时间、输入/输出 token。
如果宿主没有暴露 `workspaceRegistry`，面板显示降级提示而不是报错。

## 一个文件怎么同时当宿主插件和网页

DSH 的浏览器半边要求是 `window.__ModuleLoader__.load({...})` 工厂模块，而宿主半边是普通 ES 模块，
两者语法不兼容。本插件把浏览器段写在 `export function apply(){}` 之后，并用注释标记 `/* dsh.client` 分段，
再把发给浏览器的脚本做成**字符串常量**（既不提前闭合 script，也不内联任何 JSON）：

```
lib/index.mjs
├─ 第一段：宿主 ES 模块（import 出去的只有这一半）
│    ├─ readProjection()      读 ~/.dsh/storages/session_projcache 里的标题/轮次/token
│    ├─ locateRegistry()      拿到 workspaceRegistry 服务
│    ├─ createHandoff()       临时打开的令牌与 TTL
│    └─ apply()               注册 /api/archived-sessions/*
└─ 第二段（/* dsh.client）：字符串常量里的 HTML 面板
     └─ 原生 JS，只用 fetch 调宿主路由
```

## 宿主路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/archived-sessions/list` | 归档会话清单（含展示信息，按最后活动倒序） |
| POST | `/api/archived-sessions/unarchive` | 恢复一个会话 → `registry.unarchiveSession(id)` |
| POST | `/api/archived-sessions/open` | 临时解除归档并发放一次性令牌 |
| GET | `/api/archived-sessions/claim?token=…` | 认领令牌，把会话重新归档 |
| GET | `/api/archived-sessions/panel` | 独立 HTML 面板页 |

### 怎么拿到 `workspaceRegistry`

它由 `@deepseek-ai/dsh-workspace` 提供，注册名是字符串 `"workspaceRegistry"`，
但**不在任何 Loader 行上**，因此不能靠 `inject` 注入。本插件的做法（集中在 `locateRegistry()`）：

1. 先看同根 ctx 是否已有 `ctx.workspaceRegistry`；
2. 否则遍历 `ctx.loader.entries()`，找到 `@deepseek-ai/dsh-workspace` 那一行，
   借用它的 `apply(ctx)`（官方实现就是 `ctx.plugin(WorkspaceRegistry)`），让服务在同一根 ctx 出现；
3. 都拿不到就返回 `available: false`，面板降级，不影响宿主其它功能。

### 为什么用 `webServer.register` 而不是 `connection.fetch.register`

`connection` 是 Web 授权通道，非桌面宿主里不一定存在；`webServer.register` 是更底层的基础能力，
`dsh-client-modules` 注册 `/plugins` 路由用的就是它。若你的宿主需要鉴权，把 `inject` 加上 `'connection'`
并换成 `ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })`，handler 签名一致。

## 开发与测试

```bash
node test.mjs    # 11 项：模块契约、四个路由行为、面板页完整性、面板落盘
```

纯 Node（≥18）即可运行，不依赖 DSH 运行时，可直接接 CI。

## 已知限制

- 「打开」依赖 `ctx.uiWorkspace.openSession()`（`dsh-client-ui-workspace` 提供）；该服务缺席时会给出
  提示并保持 20 秒临时窗口，你仍可在官方会话列表里手动打开，或用「恢复」永久取出。
- 归档集合是注册表级的（全局），面板对所有工作区一视同仁，不按工作区分组。
- 展示信息取自 `~/.dsh/storages/session_projcache/`；没有投影缓存的会话只显示 id，恢复功能不受影响。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-archived-sessions
rm -f ~/.dsh/storages/archived-sessions.html   # 面板页副本
```

卸载不影响任何会话数据；归档状态仍保存在 `workspace.json` 里。

## License

MIT
