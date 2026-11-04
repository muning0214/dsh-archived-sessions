# dsh-archived-sessions

> 给 DeepSeek Harness 补一个「已归档会话」面板。归档后的会话仍可查找、查看交互、恢复或永久删除。

## 功能

- 在侧栏增加「已归档」入口。
- 显示标题、首条提问、工作区、最后活动时间、轮次、步骤、token 和模型。
- 按标题、首条提问、会话 ID 或工作区即时过滤。
- 按工作区筛选，并按活动时间、轮次或 token 排序。
- 汇总归档数量、总轮次、输入/输出 token 和涉及工作区。
- 从宿主投影缓存补全官方列表快照未下发的 token 统计。
- 控件、下拉弹层、卡片和按钮跟随 DSH 明暗及自定义主题。
- 点击会话卡片可展开每轮提问与回复概要。
- 调用 DSH 官方 Workspace Controller 恢复会话。
- 点击「永久删除」并确认后，删除会话正文、投影缓存及归档/工作区引用。
- 永久删除采用两阶段提交：保持归档隐藏状态暂存正文，刷新官方会话列表后再提交引用删除，避免已删会话短暂出现在「未分组」。
- 跟随官方 Workspace 状态流自动更新，无需手动刷新。
- 提供「刷新」按钮，主动刷新官方会话列表并重新读取归档 token 投影。

DSH 的归档操作不会删除会话内容，只会把会话 ID 加入全局归档集合，使其不再出现在普通工作区列表中。本插件提供查看和恢复这个集合的入口。

## 安装

需要 DSH 0.2.x 和 Node.js 22 或更高版本。

```bash
# 从 GitHub 安装到桌面版 profile
dsh plugin --profile desktop add github:<你的账号>/dsh-archived-sessions

# 或使用本地仓库
dsh plugin --profile desktop add link:/绝对路径/dsh-archived-sessions
```

安装后重启 DSH，侧栏中会出现「已归档」。

## 用法

| 操作 | 效果 |
|---|---|
| 搜索 | 按标题、首条提问、会话 ID 或工作区过滤 |
| 筛选与排序 | 按工作区筛选，按活动时间、轮次或 token 排序 |
| 复制全部 ID | 将所有归档会话 ID 写入剪贴板 |
| 刷新 | 主动获取最新会话投影与归档 token 统计 |
| 查看交互 | 点击卡片或「查看交互」，展开每轮提问与回复概要 |
| 恢复 | 将会话移出归档集合并放回原工作区 |
| 永久删除 | 弹出明确确认；确认后立即删除且无法恢复 |

永久删除只允许用于仍处于归档状态、且当前没有运行时实例的会话。删除过程先把磁盘内容移动到同盘临时区，但暂时保留归档和工作区引用；官方会话列表刷新并确认正文不可见后才提交引用删除。刷新、提交或窗口生命周期中途失败会自动回滚，未提交事务也会在 60 秒后回滚。附件采用共享内容寻址存储，插件不会删除可能仍被其他会话引用的共享附件对象。

## 架构

插件包含宿主端和浏览器端两个入口：

```text
lib/index.mjs
  -> 确保宿主 workspaceRegistry 已激活
  -> 注册受控的永久删除路由
  -> 校验归档和运行状态，原子暂存正文/投影后删除引用

lib/client.js
  -> 注册 main 与 sidebar.panellist
  -> 订阅官方 workspaces.list 稳定快照
  -> 订阅官方 sessions.list 会话投影
  -> 从 turnOutline 展示每轮提问与回复概要
  -> 调用 workspaces.unarchiveSession(id)
  -> 确认后按 prepare / 刷新 / commit 顺序调用宿主永久删除路由
```

浏览器端依赖官方 Workspace Controller 和 Session Controller。前者提供归档集合、工作区归属和恢复命令；后者提供持久化投影中的标题、交互概要、统计、token、模型和活动时间。宿主端通过 DSH 自带的受控 fetch 通道处理永久删除，浏览器端不直接访问磁盘。

客户端插件有两套不同的依赖声明：

- `package.json > dsh.client.inject` 使用包名，控制客户端包加载顺序。
- `lib/client.js > exports.inject` 使用 Cordis 服务名，如 `workspaces`、`sessions`、`slots` 和 `locale`。

## 开发与测试

```bash
npm test
```

测试不依赖正在运行的 DSH，覆盖包清单、客户端模块、slot 注册、稳定快照、依赖注入、永久删除及拒绝误删逻辑。

## 已知限制

- 归档集合是全局的，当前不按工作区分组。
- 某条会话的投影缓存缺失时，该条会话会降级显示 ID，恢复功能不受影响。
- 交互详情来自官方 `turnOutline` 投影，是提问和回复概要，不是完整原始事件日志。
- 宿主 profile 必须包含官方 Workspace 与 Remote 组件。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-archived-sessions
```

卸载插件不会删除会话，也不会改变现有归档状态。

## License

MIT
