window.__ModuleLoader__.load({
  id: "dsh-archived-sessions",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");

    // ─────────────────────────────────────────────────────────────────────
    // 常量
    // ─────────────────────────────────────────────────────────────────────

    /** 侧栏全局面板 id（同时是 main slot 的 key）。 */
    const PANEL_ID = "archived-sessions";
    const NS = "dsh-archived-sessions";

    const zh = {
      panel: "已归档",
      title: "已归档会话",
      subtitle: "归档只是把会话从列表里藏起来，内容与日志都还在。选中「恢复」即可放回原工作区。",
      search: "搜索标题或会话 id…",
      refresh: "刷新",
      restore: "恢复",
      restoring: "恢复中…",
      noMatch: "没有匹配的归档会话",
      empty: "还没有归档任何会话",
      unavailable: "workspace 服务不可用（profile 未包含 api-remotes）",
      count: "共 {n} 个归档会话",
      turns: "{n} 轮",
      restored: "已恢复到原工作区",
      failed: "操作失败：{msg}",
      noTitle: "（无标题）"
    };
    const en = {
      panel: "Archived",
      title: "Archived sessions",
      subtitle: "Archiving only hides a session from lists — content and logs stay on disk. \"Restore\" puts it back to its workspace.",
      search: "Search title or session id…",
      refresh: "Refresh",
      restore: "Restore",
      restoring: "Restoring…",
      noMatch: "No archived session matches",
      empty: "Nothing is archived yet",
      unavailable: "workspace service unavailable (profile lacks api-remotes)",
      count: "{n} archived session(s)",
      turns: "{n} turns",
      restored: "Restored to its workspace",
      failed: "Operation failed: {msg}",
      noTitle: "(untitled)"
    };

    // ─────────────────────────────────────────────────────────────────────
    // 数据层：直接调官方 Remote（ctx.remote.workspace）
    // ─────────────────────────────────────────────────────────────────────

    /**
     * 从 ctx.remote.workspace 拿归档清单。
     * Workspace increment 帧（type:"archived"）携带完整 archivedSessionIds；
     * Remote 首次连接时会推一次全量，之后增量更新，因此订阅即可保持同步。
     */
    function createArchiveSource(ctx) {
      let state = { phase: "loading", ids: [], error: "" };
      const listeners = new Set();
      let revision = 0;

      const publish = () => {
        revision += 1;
        for (const listener of listeners) {
          try { listener() } catch { /* 单个监听者出错不影响其它 */ }
        }
      };

      const acceptArchived = (ids) => {
        state = { phase: "ready", ids: ids.map(String), error: "" };
        publish();
      };

      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };

      const start = () => {
        try {
          // 官方 increment 帧：{ type: "archived", archivedSessionIds: [...] }
          ctx.remote.$on?.("workspace/increment", (frame) => {
            if (frame && frame.type === "archived" && Array.isArray(frame.archivedSessionIds)) {
              acceptArchived(frame.archivedSessionIds);
            }
          });
          //Remote 上还有直接的读方法时优先用之（拿一次全量）
          const workspace = ctx.remote?.workspace;
          if (workspace && typeof workspace.subscribeState === "function") {
            // 某些版本暴露状态流
            const snapshot = workspace.subscribeState?.(() => {});
            if (snapshot && typeof snapshot.getSnapshot === "function") {
              const value = snapshot.getSnapshot();
              if (value && Array.isArray(value.archivedSessionIds)) acceptArchived(value.archivedSessionIds);
            }
          }
        } catch (error) {
          state = { phase: "error", ids: [], error: String(error?.message ?? error) };
          publish();
        }
      };

      return {
        getSnapshot: () => ({ ...state, revision }),
        subscribe,
        start
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────────────────────────────

    const format = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (_all, key) => String(values[key] ?? ""));

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "";
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    const S = {
      root: {
        display: "flex", flexDirection: "column", gap: 12, height: "100%",
        minHeight: 0, boxSizing: "border-box", padding: "18px 16px", font: "inherit", color: "inherit"
      },
      head: { display: "flex", flexDirection: "column", gap: 6 },
      headRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      count: { fontSize: 11, opacity: 0.5 },
      subtitle: { margin: 0, fontSize: 12, lineHeight: 1.55, opacity: 0.6 },
      bar: { display: "flex", gap: 8, alignItems: "center" },
      input: {
        flex: 1, minWidth: 0, height: 30, padding: "0 10px", fontSize: 13, borderRadius: 8,
        border: "1px solid rgba(127,127,127,.35)", background: "transparent", color: "inherit", outline: "none"
      },
      list: {
        display: "flex", flexDirection: "column", gap: 8, minHeight: 0,
        overflowY: "auto", paddingBottom: 8
      },
      card: {
        display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 10,
        border: "1px solid rgba(127,127,127,.22)", background: "rgba(127,127,127,.06)"
      },
      cardHead: { display: "flex", alignItems: "baseline", gap: 8 },
      cardTitle: {
        flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.45,
        overflow: "hidden", textOverflow: "ellipsis"
      },
      id: { fontSize: 10, opacity: 0.42, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
      meta: { display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, opacity: 0.55 },
      actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      hint: { fontSize: 12, opacity: 0.55, textAlign: "center", padding: "10px 0" },
      error: { fontSize: 12, color: "#e5484d" }
    };

    function buttonStyle(primary, disabled) {
      return {
        height: 28, padding: "0 12px", fontSize: 12, lineHeight: "26px", borderRadius: 8,
        border: primary ? "1px solid rgba(60,120,255,.55)" : "1px solid rgba(127,127,127,.32)",
        color: primary ? "#3c78ff" : "inherit", background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1
      };
    }

    const h = react.createElement;

    function ArchivedPanelIcon({ size = 16 }) {
      return h("svg", {
        width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true"
      },
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

    function SessionCard({ id, turns, busy, t, onRestore }) {
      return h("div", { style: S.card },
        h("div", { style: S.cardHead },
          h("span", { style: S.cardTitle }, id.replace(/^session-/, "").slice(0, 8)),
          h("code", { style: { ...S.id, opacity: 1, fontSize: 12 } }, t("turns", { n: turns }))
        ),
        h("div", { style: S.actions },
          h("button", {
            type: "button", style: buttonStyle(true, busy), disabled: busy, onClick: () => onRestore(id)
          }, busy ? t("restoring") : t("restore"))
        )
      );
    }

    /** 面板主页面。 */
    function ArchivedSessionsPage(props) {
      const t = props.t;
      const source = props.archiveSource;
      const snapshot = react.useSyncExternalStore(source.subscribe, source.getSnapshot);
      const [query, setQuery] = react.useState("");
      const [busyId, setBusyId] = react.useState("");
      const [notice, setNotice] = react.useState("");

      react.useEffect(() => { source.start(); }, [source]);

      const restore = async (id) => {
        setBusyId(id);
        setNotice("");
        try {
          const result = await props.ctx.remote.workspace.unarchiveSession({ sessionId: id });
          if (result && result.ok === false) throw new Error(result.error?.code ?? "unknown");
          setNotice(t("restored"));
        } catch (error) {
          setNotice(format(t("failed"), { msg: String(error?.message ?? error) }));
        } finally {
          setBusyId("");
        }
      };

      const keyword = query.trim().toLowerCase();
      const visible = keyword === ""
        ? snapshot.ids
        : snapshot.ids.filter((id) => id.toLowerCase().includes(keyword));

      return h("div", { style: S.root, "data-dsh-archived-sessions": "" },
        h("div", { style: S.head },
          h("div", { style: S.headRow },
            h("h2", { style: S.title }, t("title")),
            h("span", { style: S.count }, format(t("count"), { n: snapshot.ids.length }))
          ),
          h("p", { style: S.subtitle }, t("subtitle"))
        ),
        h("div", { style: S.bar },
          h("input", {
            style: S.input, value: query, placeholder: t("search"),
            "aria-label": t("search"), onChange: (event) => setQuery(event.target.value)
          }),
          h("button", { type: "button", style: buttonStyle(false, false), onClick: () => source.start() }, t("refresh"))
        ),
        notice !== "" ? h("div", { style: S.error }, notice) : null,
        snapshot.phase === "loading" ? h("div", { style: S.hint }, t("loading") ?? "…") : null,
        snapshot.phase === "error" ? h("div", { style: S.error }, format(t("failed"), { msg: snapshot.error })) : null,
        snapshot.phase === "ready" && !source.available ? h("div", { style: S.hint }, t("unavailable")) : null,
        snapshot.phase === "ready" && snapshot.ids.length === 0 ? h("div", { style: S.hint }, t("empty")) : null,
        snapshot.phase === "ready" && snapshot.ids.length > 0 && visible.length === 0 ? h("div", { style: S.hint }, t("noMatch")) : null,
        h("div", { style: S.list },
          visible.map((id) => h(SessionCard, {
            key: id, id, turns: 0, busy: busyId === id, t, onRestore: restore
          }))
        )
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 注册
    // ─────────────────────────────────────────────────────────────────────

    /**
     * 客户端依赖：这里是 cordis 的**服务名**（短名），不是包名。两套清单别混：
     *   - package.json > dsh.client.inject：写包名，供 client-modules 排加载顺序
     *   - 本文件的 exports.inject：写服务名，供 cordis 做服务注入
     * 把包名写进来，cordis 永远等不到同名服务，插件恒 pending，web boot 失败。
     * 官方参照 dsh-client-ui-plugin-manager：remote 及其子服务写作
     * "remote"、"remote.<name>"。
     */
    const inject = [
      "remote",
      "remote.workspace",
      "slots",
      "locale"
    ];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "archived-sessions: locale");
      const t = ctx.locale.bind(NS);
      const archiveSource = createArchiveSource(ctx);

      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        locale: NS
      }, (props) => ArchivedSessionsPage({ ...props, t, ctx, archiveSource })));

      ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 10,
        label: () => t("panel"),
        locale: NS
      }, ArchivedPanelIcon));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ArchivedSessionsPage = ArchivedSessionsPage;
    exports.ArchivedPanelIcon = ArchivedPanelIcon;
    exports.PANEL_ID = PANEL_ID;
    return module.exports;
  }
});
