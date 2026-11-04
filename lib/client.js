window.__ModuleLoader__.load({
  id: "dsh-archived-sessions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const PANEL_ID = "archived-sessions";
    const NS = "dsh-archived-sessions";

    const zh = {
      panel: "已归档",
      title: "已归档会话",
      subtitle: "归档只是把会话从列表里藏起来，内容与日志仍完整保存在磁盘。",
      search: "搜索标题、首条提问、会话 id 或工作区…",
      restore: "恢复",
      restoring: "恢复中…",
      delete: "永久删除",
      deleting: "删除中…",
      deleteTitle: "确认永久删除",
      deleteConfirm: "永久删除“{title}”？会话正文、投影缓存以及归档和工作区引用会立即删除，且无法恢复。",
      cancel: "取消",
      confirmDelete: "确认永久删除",
      deleted: "会话已永久删除",
      deletedRefreshFailed: "会话已永久删除，但列表刷新失败：{msg}",
      expand: "查看交互",
      collapse: "收起交互",
      interaction: "第 {n} 轮",
      user: "提问",
      assistant: "回复",
      noInteractions: "没有可用的交互概要。旧会话可能尚未生成轮次投影。",
      loading: "正在加载归档会话…",
      noMatch: "没有匹配的归档会话",
      empty: "还没有归档任何会话",
      failed: "操作失败：{msg}",
      tokenFailed: "token 统计读取失败：{msg}",
      restored: "已恢复到原工作区",
      archived: "归档会话",
      turns: "总轮次",
      inputTokens: "输入 token",
      outputTokens: "输出 token",
      workspaces: "涉及工作区",
      allWorkspaces: "全部工作区",
      sortTime: "按最后活动",
      sortTurns: "按轮次",
      sortTokens: "按 token",
      copyIds: "复制全部 id",
      copied: "已复制 {n} 个会话 id",
      refresh: "刷新",
      refreshing: "刷新中…",
      refreshed: "已获取最新归档数据",
      unassigned: "（未归属工作区）",
      noTitle: "（无标题）",
      lastActive: "最后活动",
      turnCount: "轮次",
      steps: "步骤",
      token: "token",
      input: "入",
      output: "出",
      model: "模型"
    };
    const en = {
      panel: "Archived",
      title: "Archived sessions",
      subtitle: "Archiving hides sessions from lists while their content and logs remain on disk.",
      search: "Search title, first prompt, session id, or workspace…",
      restore: "Restore",
      restoring: "Restoring…",
      delete: "Delete permanently",
      deleting: "Deleting…",
      deleteTitle: "Confirm permanent deletion",
      deleteConfirm: "Permanently delete “{title}”? Session content, projection cache, and archive/workspace references will be removed immediately and cannot be recovered.",
      cancel: "Cancel",
      confirmDelete: "Delete permanently",
      deleted: "Session permanently deleted",
      deletedRefreshFailed: "Session was permanently deleted, but the list refresh failed: {msg}",
      expand: "View interactions",
      collapse: "Hide interactions",
      interaction: "Turn {n}",
      user: "Prompt",
      assistant: "Response",
      noInteractions: "No interaction outline is available. Older sessions may not have a turn projection.",
      loading: "Loading archived sessions…",
      noMatch: "No archived session matches",
      empty: "Nothing is archived yet",
      failed: "Operation failed: {msg}",
      tokenFailed: "Failed to load token usage: {msg}",
      restored: "Restored to its workspace",
      archived: "Archived",
      turns: "Total turns",
      inputTokens: "Input tokens",
      outputTokens: "Output tokens",
      workspaces: "Workspaces",
      allWorkspaces: "All workspaces",
      sortTime: "Last active",
      sortTurns: "Turns",
      sortTokens: "Tokens",
      copyIds: "Copy all ids",
      copied: "Copied {n} session ids",
      refresh: "Refresh",
      refreshing: "Refreshing…",
      refreshed: "Archived data refreshed",
      unassigned: "(unassigned)",
      noTitle: "(untitled)",
      lastActive: "Last active",
      turnCount: "Turns",
      steps: "Steps",
      token: "Tokens",
      input: "in",
      output: "out",
      model: "Model"
    };

    const format = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (_all, key) => String(values[key] ?? ""));

    const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function buildSessionRows(ids, sessionsSnapshot, workspacesSnapshot, unassigned, tokenUsageById = {}) {
      const workspaceBySession = new Map();
      for (const workspace of workspacesSnapshot.items ?? []) {
        for (const sessionId of workspace.sessionIds ?? []) {
          workspaceBySession.set(String(sessionId), workspace);
        }
      }

      return ids.map((id) => {
        const session = sessionsSnapshot.byId?.[id];
        const projection = session?.projectionValues ?? {};
        const stats = projection.sessionStats ?? {};
        const projectedTotals = projection.tokenUsage?.totals;
        const fetchedTotals = tokenUsageById[id];
        const totals = projectedTotals ?? fetchedTotals ?? {};
        const workspace = workspaceBySession.get(id);
        const rawOutline = projection.turnOutline;
        const outline = Array.isArray(rawOutline)
          ? rawOutline
          : (Array.isArray(rawOutline?.turns) ? rawOutline.turns : []);
        const interactions = outline.map((item, index) => ({
          turn: finite(item?.turn ?? index + 1),
          prompt: String(item?.prompt ?? ""),
          response: String(item?.response ?? "")
        }));
        const firstPrompt = projection.titleInput?.first?.text
          ?? interactions[0]?.prompt
          ?? "";
        const projectedTitle = typeof projection.title === "string" && projection.title !== ""
          ? projection.title
          : undefined;
        return {
          id,
          short: id.replace(/^session-/, "").slice(0, 8),
          title: projectedTitle ?? session?.displayTitle ?? "",
          firstPrompt: String(firstPrompt),
          turns: finite(stats.turns ?? projection.titleInput?.count),
          steps: finite(stats.steps),
          lastPromptAt: finite(projection.sessionListMetadata?.lastPromptAt ?? session?.updatedAt),
          inputTokens: finite(totals.uncachedInputTokens),
          outputTokens: finite(totals.outputTokens),
          tokenKnown: projectedTotals !== undefined || fetchedTotals !== undefined,
          model: String(projection.modelSelection?.lastUsed?.model ?? ""),
          workspace: String(workspace?.title ?? unassigned),
          workspacePath: String(workspace?.path ?? session?.cwd ?? ""),
          interactions
        };
      });
    }

    const S = {
      root: {
        display: "flex", flexDirection: "column", gap: 14, height: "100%", minHeight: 0,
        boxSizing: "border-box", padding: "24px 20px", font: "inherit",
        color: "var(--dsw-alias-label-primary, inherit)"
      },
      head: { display: "flex", flexDirection: "column", gap: 5 },
      headRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
      title: { margin: 0, fontSize: 18, fontWeight: 650 },
      subtitle: {
        margin: 0, fontSize: 12, lineHeight: 1.55,
        color: "var(--dsw-alias-label-secondary, currentColor)"
      },
      stats: {
        display: "flex", gap: 28, flexWrap: "wrap", padding: "12px 2px 14px",
        borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24))"
      },
      stat: { display: "flex", flexDirection: "column", gap: 2, minWidth: 86 },
      statValue: { fontSize: 18, lineHeight: 1.25, fontWeight: 650 },
      statLabel: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)" },
      bar: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
      input: {
        flex: "1 1 320px", minWidth: 220, height: 34, padding: "0 11px", fontSize: 13,
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)", outline: "none"
      },
      select: {
        height: 34, maxWidth: 200, padding: "0 28px 0 10px", fontSize: 12,
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        color: "var(--dsw-alias-label-primary, inherit)", colorScheme: "inherit", outline: "none"
      },
      option: {
        background: "var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, Canvas))",
        color: "var(--dsw-alias-label-primary, CanvasText)"
      },
      list: {
        display: "flex", flexDirection: "column", gap: 10, minHeight: 0,
        overflowY: "auto", paddingRight: 4, paddingBottom: 12
      },
      card: {
        display: "flex", flexDirection: "column", gap: 8, padding: "13px 15px", borderRadius: 7,
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24))",
        background: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,.035))", cursor: "pointer"
      },
      cardHead: { display: "flex", alignItems: "center", gap: 10, minWidth: 0, flexWrap: "wrap" },
      cardTitle: {
        flex: 1, minWidth: 0, fontSize: 14, fontWeight: 650, lineHeight: 1.4,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
      },
      badge: {
        maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        fontSize: 10, padding: "2px 7px", borderRadius: 10,
        border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))",
        color: "var(--dsw-alias-label-secondary, currentColor)"
      },
      id: {
        fontSize: 10, color: "var(--dsw-alias-label-secondary, currentColor)",
        fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
      },
      meta: {
        display: "flex", flexWrap: "wrap", gap: "4px 15px", fontSize: 11,
        color: "var(--dsw-alias-label-secondary, currentColor)"
      },
      metaStrong: { color: "inherit", fontWeight: 600, opacity: 1 },
      prompt: {
        padding: "7px 9px",
        borderLeft: "2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))",
        fontSize: 11, lineHeight: 1.5,
        color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "pre-wrap",
        wordBreak: "break-word", maxHeight: 58, overflow: "auto"
      },
      actions: { display: "flex", alignItems: "center", gap: 7, flex: "0 0 auto" },
      interactions: {
        display: "flex", flexDirection: "column", gap: 10, marginTop: 3, paddingTop: 10,
        borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.24))"
      },
      turn: {
        display: "flex", flexWrap: "wrap", gap: 10,
        padding: "10px", borderRadius: 6,
        background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.055))"
      },
      turnTitle: {
        flex: "1 0 100%", fontSize: 11, fontWeight: 650,
        color: "var(--dsw-alias-label-secondary, currentColor)"
      },
      message: { flex: "1 1 280px", minWidth: 0, fontSize: 11, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" },
      messageLabel: {
        display: "block", marginBottom: 4, fontSize: 10, fontWeight: 650,
        color: "var(--dsw-alias-label-secondary, currentColor)"
      },
      modalBackdrop: {
        position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center",
        justifyContent: "center", padding: 20, background: "rgba(0,0,0,.55)"
      },
      modal: {
        width: "min(460px, 100%)", padding: 18, borderRadius: 7,
        border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))",
        background: "var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #202020))",
        color: "var(--dsw-alias-label-primary, inherit)", boxShadow: "0 16px 48px rgba(0,0,0,.35)"
      },
      modalTitle: { margin: 0, fontSize: 16, fontWeight: 650 },
      modalBody: { margin: "10px 0 16px", fontSize: 12, lineHeight: 1.65, color: "var(--dsw-alias-label-secondary, currentColor)" },
      modalActions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      hint: {
        fontSize: 12, color: "var(--dsw-alias-label-secondary, currentColor)",
        textAlign: "center", padding: "28px 0"
      },
      notice: { fontSize: 12, color: "var(--dsw-alias-brand-primary, #3c78ff)" },
      error: { fontSize: 12, color: "var(--dsw-alias-state-error-primary, #e5484d)" }
    };

    function buttonStyle(primary, disabled) {
      return {
        height: 30, flex: "0 0 auto", padding: "0 12px", fontSize: 12, borderRadius: 6,
        border: primary
          ? "1px solid var(--dsw-alias-brand-primary, rgba(60,120,255,.65))"
          : "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32))",
        color: primary
          ? "var(--dsw-alias-brand-primary, #3c78ff)"
          : "var(--dsw-alias-label-primary, inherit)",
        background: "var(--dsw-alias-bg-layer-1, transparent)",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1
      };
    }

    function dangerButtonStyle(disabled, solid = false) {
      return {
        ...buttonStyle(false, disabled),
        border: "1px solid var(--dsw-alias-state-error-primary, #e5484d)",
        color: solid ? "#fff" : "var(--dsw-alias-state-error-primary, #e5484d)",
        background: solid ? "var(--dsw-alias-state-error-primary, #c9343a)" : "var(--dsw-alias-bg-layer-1, transparent)"
      };
    }

    function ArchivedPanelIcon({ size = 16 }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M2.6 2.8h10.8c.33 0 .6.27.6.6v1.5c0 .33-.27.6-.6.6H2.6a.6.6 0 0 1-.6-.6V3.4c0-.33.27-.6.6-.6Z",
          stroke: "currentColor", strokeWidth: 1.25
        }),
        h("path", {
          d: "M3.3 5.5v6.9c0 .6.49 1.1 1.1 1.1h7.2c.6 0 1.1-.5 1.1-1.1V5.5M6.1 8.5h3.8",
          stroke: "currentColor", strokeWidth: 1.25, strokeLinecap: "round", strokeLinejoin: "round"
        })
      );
    }

    function Stat({ value, label }) {
      return h("div", { style: S.stat },
        h("strong", { style: S.statValue }, value === null ? "—" : finite(value).toLocaleString()),
        h("span", { style: S.statLabel }, label)
      );
    }

    function Meta({ label, value }) {
      return h("span", null, `${label} `, h("b", { style: S.metaStrong }, value));
    }

    function SessionCard({ row, busy, expanded, t, onToggle, onRestore, onDelete }) {
      const stop = (callback) => (event) => {
        event.stopPropagation();
        callback();
      };
      return h("div", { style: S.card, onClick: onToggle },
        h("div", { style: S.cardHead },
          h("span", { style: S.cardTitle, title: row.title }, row.title || t("noTitle")),
          h("span", { style: S.badge, title: row.workspacePath || row.workspace }, row.workspace),
          h("code", { style: S.id }, row.short),
          h("div", { style: S.actions },
            h("button", {
              type: "button", style: buttonStyle(false, false),
              onClick: stop(onToggle)
            }, expanded ? t("collapse") : t("expand")),
            h("button", {
              type: "button", style: buttonStyle(true, busy), disabled: busy,
              onClick: stop(() => onRestore(row.id))
            }, busy ? t("restoring") : t("restore")),
            h("button", {
              type: "button", style: dangerButtonStyle(busy), disabled: busy,
              onClick: stop(() => onDelete(row))
            }, t("delete"))
          )
        ),
        h("div", { style: S.meta },
          h(Meta, { label: t("lastActive"), value: formatTime(row.lastPromptAt) }),
          h(Meta, { label: t("turnCount"), value: row.turns.toLocaleString() }),
          h(Meta, { label: t("steps"), value: row.steps.toLocaleString() }),
          h(Meta, {
            label: t("token"),
            value: row.tokenKnown
              ? `${row.inputTokens.toLocaleString()} ${t("input")} / ${row.outputTokens.toLocaleString()} ${t("output")}`
              : "—"
          }),
          row.model ? h(Meta, { label: t("model"), value: row.model }) : null
        ),
        row.firstPrompt && !expanded ? h("div", { style: S.prompt }, row.firstPrompt) : null,
        expanded ? h("div", { style: S.interactions },
          row.interactions.length === 0
            ? h("div", { style: S.hint }, t("noInteractions"))
            : row.interactions.map((item, index) => h("div", { style: S.turn, key: `${row.id}-${item.turn}-${index}` },
              h("div", { style: S.turnTitle }, format(t("interaction"), { n: item.turn || index + 1 })),
              h("div", { style: S.message },
                h("span", { style: S.messageLabel }, t("user")),
                item.prompt || "—"
              ),
              h("div", { style: S.message },
                h("span", { style: S.messageLabel }, t("assistant")),
                item.response || "—"
              )
            ))
        ) : null
      );
    }

    function ArchivedSessionsPage(props) {
      const t = props.t;
      const subscribeWorkspaces = react.useCallback(
        (listener) => props.workspaces.list.subscribe(listener), [props.workspaces]
      );
      const getWorkspaces = react.useCallback(
        () => props.workspaces.list.getSnapshot(), [props.workspaces]
      );
      const subscribeSessions = react.useCallback(
        (listener) => props.sessions.list.subscribe(listener), [props.sessions]
      );
      const getSessions = react.useCallback(
        () => props.sessions.list.getSnapshot(), [props.sessions]
      );
      const workspacesSnapshot = react.useSyncExternalStore(subscribeWorkspaces, getWorkspaces);
      const sessionsSnapshot = react.useSyncExternalStore(subscribeSessions, getSessions);
      const [query, setQuery] = react.useState("");
      const [workspaceFilter, setWorkspaceFilter] = react.useState("");
      const [sortMode, setSortMode] = react.useState("time");
      const [busyId, setBusyId] = react.useState("");
      const [expandedId, setExpandedId] = react.useState("");
      const [pendingDelete, setPendingDelete] = react.useState(null);
      const [notice, setNotice] = react.useState("");
      const [tokenUsageById, setTokenUsageById] = react.useState(null);
      const [tokenError, setTokenError] = react.useState("");
      const [refreshing, setRefreshing] = react.useState(false);
      const tokenRequestSequence = react.useRef(0);

      const ids = Array.isArray(workspacesSnapshot.archivedSessionIds)
        ? workspacesSnapshot.archivedSessionIds.map(String)
        : [];
      const tokenRequestKey = ids.join("\n");

      const loadTokenUsage = react.useCallback(async (currentIds) => {
        const sequence = tokenRequestSequence.current + 1;
        tokenRequestSequence.current = sequence;
        setTokenError("");
        if (currentIds.length === 0) {
          setTokenUsageById({});
          return;
        }
        setTokenUsageById(null);
        try {
          const response = await fetch("/api/archived-sessions/token-usage", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ids: currentIds })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.ok !== true) {
            throw new Error(result.message ?? result.reason ?? `HTTP ${response.status}`);
          }
          if (tokenRequestSequence.current === sequence) {
            setTokenUsageById(result.tokenUsageById ?? {});
          }
        } catch (error) {
          if (tokenRequestSequence.current === sequence) {
            setTokenError(String(error?.message ?? error));
          }
          throw error;
        }
      }, []);

      react.useEffect(() => {
        loadTokenUsage(ids).catch(() => {});
      }, [tokenRequestKey, loadTokenUsage]);

      const rows = buildSessionRows(
        ids, sessionsSnapshot, workspacesSnapshot, t("unassigned"), tokenUsageById ?? {}
      );
      const workspaces = [...new Set(rows.map((row) => row.workspace))].sort((a, b) => a.localeCompare(b));
      const keyword = query.trim().toLowerCase();
      const visible = rows.filter((row) => {
        if (workspaceFilter && row.workspace !== workspaceFilter) return false;
        if (!keyword) return true;
        return [row.title, row.firstPrompt, row.id, row.workspace]
          .join("\n").toLowerCase().includes(keyword);
      }).sort((left, right) => {
        if (sortMode === "turns") return right.turns - left.turns;
        if (sortMode === "tokens") {
          return (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens);
        }
        return right.lastPromptAt - left.lastPromptAt;
      });

      const totalTurns = rows.reduce((sum, row) => sum + row.turns, 0);
      const totalInput = rows.reduce((sum, row) => sum + row.inputTokens, 0);
      const totalOutput = rows.reduce((sum, row) => sum + row.outputTokens, 0);
      const tokensReady = rows.every((row) => row.tokenKnown);
      const loading = workspacesSnapshot.phase !== "ready" || sessionsSnapshot.phase !== "ready";
      const failed = workspacesSnapshot.state === "error";

      const restore = async (id) => {
        setBusyId(id);
        setNotice("");
        try {
          await props.workspaces.unarchiveSession(id);
          setNotice(t("restored"));
        } catch (error) {
          setNotice(format(t("failed"), { msg: String(error?.message ?? error) }));
        } finally {
          setBusyId("");
        }
      };

      const deletePermanently = async () => {
        if (!pendingDelete || busyId) return;
        const id = pendingDelete.id;
        let transactionToken = "";
        let committed = false;
        setBusyId(id);
        setNotice("");

        const runDeletePhase = async (body) => {
          const response = await fetch("/api/archived-sessions/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || result.ok !== true) {
            throw new Error(result.message ?? result.reason ?? `HTTP ${response.status}`);
          }
          return result;
        };

        try {
          const prepared = await runDeletePhase({ phase: "prepare", id });
          transactionToken = prepared.token;

          // The archive marker stays in place during this refresh, so the
          // official sidebar cannot expose an ungrouped intermediate record.
          await props.sessions.refresh();
          await runDeletePhase({ phase: "commit", token: transactionToken });
          committed = true;
          setPendingDelete(null);
          if (expandedId === id) setExpandedId("");
          try {
            await props.sessions.refresh();
            setNotice(t("deleted"));
          } catch (refreshError) {
            setNotice(format(t("deletedRefreshFailed"), {
              msg: String(refreshError?.message ?? refreshError)
            }));
          }
        } catch (error) {
          if (transactionToken && !committed) {
            await runDeletePhase({ phase: "rollback", token: transactionToken }).catch(() => {});
            await props.sessions.refresh().catch(() => {});
          }
          setNotice(format(t("failed"), { msg: String(error?.message ?? error) }));
        } finally {
          setBusyId("");
        }
      };

      const copyIds = async () => {
        try {
          await navigator.clipboard.writeText(rows.map((row) => row.id).join("\n"));
          setNotice(format(t("copied"), { n: rows.length }));
        } catch (error) {
          setNotice(format(t("failed"), { msg: String(error?.message ?? error) }));
        }
      };

      const refresh = async () => {
        if (refreshing) return;
        setRefreshing(true);
        setNotice("");
        try {
          await props.sessions.refresh();
          await loadTokenUsage(ids);
          setNotice(t("refreshed"));
        } catch (error) {
          setNotice(format(t("failed"), { msg: String(error?.message ?? error) }));
        } finally {
          setRefreshing(false);
        }
      };

      return h("div", { style: S.root, "data-dsh-archived-sessions": "" },
        h("div", { style: S.head },
          h("div", { style: S.headRow }, h("h2", { style: S.title }, t("title"))),
          h("p", { style: S.subtitle }, t("subtitle"))
        ),
        h("div", { style: S.stats },
          h(Stat, { value: rows.length, label: t("archived") }),
          h(Stat, { value: totalTurns, label: t("turns") }),
          h(Stat, { value: tokensReady ? totalInput : null, label: t("inputTokens") }),
          h(Stat, { value: tokensReady ? totalOutput : null, label: t("outputTokens") }),
          h(Stat, { value: workspaces.length, label: t("workspaces") })
        ),
        h("div", { style: S.bar },
          h("input", {
            style: S.input, value: query, placeholder: t("search"), "aria-label": t("search"),
            onChange: (event) => setQuery(event.target.value)
          }),
          h("select", {
            style: S.select, value: workspaceFilter, "aria-label": t("allWorkspaces"),
            onChange: (event) => setWorkspaceFilter(event.target.value)
          },
            h("option", { value: "", style: S.option }, t("allWorkspaces")),
            ...workspaces.map((workspace) => h("option", {
              key: workspace, value: workspace, style: S.option
            }, workspace))
          ),
          h("select", {
            style: S.select, value: sortMode, "aria-label": t("sortTime"),
            onChange: (event) => setSortMode(event.target.value)
          },
            h("option", { value: "time", style: S.option }, t("sortTime")),
            h("option", { value: "turns", style: S.option }, t("sortTurns")),
            h("option", { value: "tokens", style: S.option }, t("sortTokens"))
          ),
          h("button", {
            type: "button", style: buttonStyle(false, refreshing), disabled: refreshing,
            onClick: refresh
          }, refreshing ? t("refreshing") : t("refresh")),
          h("button", { type: "button", style: buttonStyle(false, false), onClick: copyIds }, t("copyIds"))
        ),
        notice ? h("div", { style: notice.startsWith(t("failed").split("{")[0]) ? S.error : S.notice }, notice) : null,
        tokenError ? h("div", { style: S.error }, format(t("tokenFailed"), { msg: tokenError })) : null,
        loading && rows.length === 0 ? h("div", { style: S.hint }, t("loading")) : null,
        failed ? h("div", { style: S.error }, format(t("failed"), {
          msg: String(workspacesSnapshot.error?.message ?? workspacesSnapshot.error ?? "unknown")
        })) : null,
        !loading && ids.length === 0 ? h("div", { style: S.hint }, t("empty")) : null,
        ids.length > 0 && visible.length === 0 ? h("div", { style: S.hint }, t("noMatch")) : null,
        h("div", { style: S.list },
          visible.map((row) => h(SessionCard, {
            key: row.id, row, busy: busyId === row.id, expanded: expandedId === row.id, t,
            onToggle: () => setExpandedId(expandedId === row.id ? "" : row.id),
            onRestore: restore, onDelete: setPendingDelete
          }))
        ),
        pendingDelete ? h("div", {
          style: S.modalBackdrop, role: "presentation",
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !busyId) setPendingDelete(null);
          }
        }, h("div", { style: S.modal, role: "dialog", "aria-modal": "true", "aria-labelledby": "archived-delete-title" },
          h("h3", { id: "archived-delete-title", style: S.modalTitle }, t("deleteTitle")),
          h("p", { style: S.modalBody }, format(t("deleteConfirm"), {
            title: pendingDelete.title || t("noTitle")
          })),
          h("div", { style: S.modalActions },
            h("button", {
              type: "button", style: buttonStyle(false, Boolean(busyId)), disabled: Boolean(busyId),
              onClick: () => setPendingDelete(null)
            }, t("cancel")),
            h("button", {
              type: "button", style: dangerButtonStyle(Boolean(busyId), true), disabled: Boolean(busyId),
              onClick: deletePermanently
            }, busyId ? t("deleting") : t("confirmDelete"))
          )
        )) : null
      );
    }

    const inject = ["workspaces", "sessions", "slots", "locale"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "archived-sessions: locale");
      const t = ctx.locale.bind(NS);
      const workspaces = ctx.workspaces;
      const sessions = ctx.sessions;

      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main", key: PANEL_ID, locale: NS
      }, (props) => ArchivedSessionsPage({ ...props, t, workspaces, sessions })));

      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist", id: PANEL_ID, order: 10,
        label: () => t("panel"), locale: NS
      }, ArchivedPanelIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ArchivedSessionsPage = ArchivedSessionsPage;
    exports.ArchivedPanelIcon = ArchivedPanelIcon;
    exports.buildSessionRows = buildSessionRows;
    exports.PANEL_ID = PANEL_ID;
    return module.exports;
  }
});
