# dsh-archived-sessions

> 给 DeepSeek Harness 补一个「已归档会话」面板：归档之后仍然找得到，能搜索、能恢复、能临时打开。

## 为什么需要它

DSH 的「归档」并不是删除，也不是移动到某个文件夹 —— 它往
`~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` 里追加一个会话 id，
于是这个会话被所有分组界面过滤掉。会话本身、工作区槽位、磁盘上的
`session.v4.jsonl.zstd` 全都保持原样。

问题在于：**归档之后就再也没有入口把它找回来了。** 官方 Web 前端（`dsh-web-frontend`
主包）里 `archived` 出现了 0 次，`dsh-client-ui-sidebar`、`dsh-client-ui-session`
等界面包里也没有任何「查看归档」的入口；只有 `dsh-api-workspace-controller`
暴露了 `archiveSession` / `unarchiveSession` 两个 Remote 方法，供插件调用。

本插件用这两个官方能力补上界面缺口。

## 功能

- **侧栏全局面板**「已归档」，与「插件」面板同级，列出所有归档会话
- 每条会话显示：标题、短 id、轮次、最后活动时间、输入/输出 token
- **搜索**：按标题、首条提问、会话 id 过滤
- **恢复**：一键 `unarchiveSession()`，会话回到原工作区原位（恢复到它当初的排序位置，不追加到末尾）
- **临时打开**：把会话从归档集里临时摘出来 20 秒，调用 `uiWorkspace.openSession()` 打开，
  过期自动重新归档 —— 只想瞄一眼内容时不必永久恢复
- 中英双语（跟随宿主语言），宿主没有 `workspaceRegistry` 时面板降级提示而不是报错

## 安装

需要 DSH 0.2.x（桌面版或 web 版均可）。

### 方式一：从 GitHub 安装（推荐）

```bash
# 装到桌面版 profile
dsh plugin --profile desktop add github:<你的账号>/dsh-archived-sessions

# 或者 web 版 profile
dsh plugin --profile web add github:<你的账号>/dsh-archived-sessions
```

也可以在 GUI 里走「插件 → 添加插件」，把 `github:<账号>/dsh-archived-sessions` 填进包名框。

### 方式二：本地路径安装（开发调试）

```bash
git clone https://github.com/<你的账号>/dsh-archived-sessions.git
dsh plugin --profile desktop add link:/绝对路径/dsh-archived-sessions
```

安装后重启 DSH，侧栏底部会出现「已归档」入口。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-archived-sessions
```

卸载不影响任何会话数据；归档状态仍然保存在 `workspace.json` 里。

## 实现说明

```
lib/index.mjs    宿主半边：注册 /api/archived-sessions 路由
lib/client.js    浏览器半边：侧栏面板 + 主页面
cordis.patch.yml 把本插件插入 profile 树
```

### 宿主路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/archived-sessions/list` | 归档会话清单（含标题、轮次、token 等展示信息） |
| POST | `/api/archived-sessions/unarchive` | 恢复一个会话，调用 `workspaceRegistry.unarchiveSession(id)` |
| POST | `/api/archived-sessions/open` | 临时解除归档并发放一次性令牌 |
| GET | `/api/archived-sessions/claim?token=…` | 认领令牌，把会话重新归档 |

### 拿 `workspaceRegistry` 的方式

`workspaceRegistry` 由 `@deepseek-ai/dsh-workspace` 提供，注册名是字符串
`"workspaceRegistry"`，但它**不在任何 Loader 行上**，因此不能用 `inject` 注入。
本插件的做法：

1. 先看同根 ctx 上是否已经有 `ctx.workspaceRegistry`；
2. 否则遍历 `ctx.loader.entries()`，找到 `@deepseek-ai/dsh-workspace` 那一行，
   借用它的 `apply(ctx)`（官方实现就是 `ctx.plugin(WorkspaceRegistry)`），
   让服务在同一根 ctx 上出现；
3. 都拿不到就返回 `available: false`，面板显示降级提示，不影响宿主其他功能。

如果你在别的宿主里跑，也可以把它改成从服务容器直接取，逻辑集中在
`lib/index.mjs` 的 `locateRegistry()` 一个函数里。

### 为什么用 `webServer.register` 而不是 `connection.fetch.register`

`connection.fetch` 自带 Web 授权通道，但 `connection` 在非桌面宿主里不一定存在；
`webServer.register` 是更底层的基础能力，`dsh-client-modules` 注册 `/plugins`
路由用的就是它。如果你需要鉴权，把 `inject` 加上 `'connection'` 并换成
`ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })` 即可，
handler 签名完全一致。

## 开发

```bash
node test/self-check.mjs    # 清单 / patch / client bundle 契约（9 项）
node test/host-routes.mjs   # 宿主路由行为回归（9 项）
```

两个测试都不依赖 DSH 运行时，纯 Node 即可运行，适合放进 CI。

## 已知限制

- 「临时打开」依赖 `ctx.uiWorkspace.openSession()`（`dsh-client-ui-workspace` 提供）。
  若该服务不在当前 profile 里，面板会提示打开失败，但仍可正常恢复。
- 归档集合是注册表级的（全局），所以面板对所有工作区一视同仁，不按工作区分组。
- 展示信息来自 `~/.dsh/storages/session_projcache/`，若该会话从未生成投影缓存，
  则只显示会话 id，恢复功能不受影响。

## License

MIT
