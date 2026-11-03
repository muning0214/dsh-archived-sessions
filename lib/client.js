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
    /** 宿主路由的浏览器相对地址（见宿主半边 lib/index.mjs）。 */
    const LIST_ROUTE = "api/archived-sessions/list";
    const UNARCHIVE_ROUTE = "api/archived-sessions/unarchive";
    const OPEN_ROUTE = "api/archived-sessions/open";
    const CLAIM_ROUTE = "api/archived-sessions/claim";

    const NS = "dsh-archived-sessions";
    const zh = {
      panel: "已归档",
      title: "已归档会话",
      subtitle: "归档只是把会话从列表里藏起来，内容与日志都还在。可以恢复到原工作区，或临时打开看看。",
      search: "搜索标题、首条提问或会话 id…",
      refresh: "刷新",
      restore: "恢复",
      open: "打开",
      restoring: "处理中…",
      noMatch: "没有匹配的归档会话",
      empty: "还没有归档任何会话",
      unavailable: "当前宿主没有暴露 workspaceRegistry，面板暂不可用",
      count: "共 {n} 个归档会话",
      turns: "{n} 轮",
      tokens: "入 {i} / 出 {o} tokens",
      loading: "读取中…",
      failed: "读取失败：{msg}",
      restored: "已恢复：{title}",
      restoreFailed: "恢复失败：{msg}",
      opened: "已临时打开 {title}，20 秒后自动回到归档",
      openFailed: "打开失败：{msg}",
      untitled: "（无标题）"
    };
    const en = {
      panel: "Archived",
      title: "Archived sessions",
      subtitle: "Archiving only hides a session from the lists — content and logs stay on disk. Restore it to its workspace, or open it temporarily.",
      search: "Search title, first prompt or session id…",
      refresh: "Refresh",
      restore: "Restore",
      open: "Open",
      restoring: "Working…",
      noMatch: "No archived session matches",
      empty: "Nothing is archived yet",
      unavailable: "This host does not expose workspaceRegistry",
      count: "{n} archived session(s)",
      turns: "{n} turns",
      tokens: "in {i} / out {o} tokens",
      loading: "Loading…",
      failed: "Load failed: {msg}",
      restored: "Restored {title}",
      restoreFailed: "Restore failed: {msg}",
      opened: "Opened {title} for 20s, then it returns to the archive",
      openFailed: "Open failed: {msg}",
      untitled: "(untitled)"
    };

    // ─────────────────────────────────────────────────────────────────────
    // 工具
    // ─────────────────────────────────────────────────────────────────────

    const format = (template, values) =>
      String(template).replace(/\{(\w+)\}/g, (_all, key) => String(values[key] ?? ""));

    /** `MM-DD HH:mm`；无效时间返回空串。 */
    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return "";
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 统一的请求封装：非 2xx 一律抛 Error，页面只负责展示文案。 */
    async function request(url, init) {
      const response = await fetch(url, init);
      const text = await response.text();
      let body = {};
      if (text !== "") {
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`${response.status} ${text.slice(0, 160)}`);
        }
      }
      if (!response.ok) throw new Error(body?.reason ?? `${response.status}`);
      return body;
    }

    const postJson = (url, payload) =>
      request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

    // ─────────────────────────────────────────────────────────────────────
    // 样式（内联；本插件不引入额外 CSS 资源）
    // ─────────────────────────────────────────────────────────────────────

    const S = {
      root: {
        display: "flex",
        flexDirection: "column",
        gap: 12,
        height: "100%",
        minHeight: 0,
        boxSizing: "border-box",
        padding: "18px 16px",
        font: "inherit",
        color: "inherit"
      },
      head: { display: "flex", flexDirection: "column", gap: 6 },
      headRow: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
      title: { margin: 0, fontSize: 15, fontWeight: 600 },
      count: { fontSize: 11, opacity: 0.5 },
      subtitle: { margin: 0, fontSize: 12, lineHeight: 1.55, opacity: 0.6 },
      bar: { display: "flex", gap: 8, alignItems: "center" },
      input: {
        flex: 1,
        minWidth: 0,
        height: 30,
        padding: "0 10px",
        fontSize: 13,
        borderRadius: 8,
        border: "1px solid rgba(127,127,127,.35)",
        background: "transparent",
        color: "inherit",
        outline: "none"
      },
      list: {
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        overflowY: "auto",
        paddingBottom: 8
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid rgba(127,127,127,.22)",
        background: "rgba(127,127,127,.06)"
      },
      cardHead: { display: "flex", alignItems: "baseline", justifyContent: "baseline", gap: 8 },
      cardTitle: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.45,
        overflow: "hidden",
        textOverflow: "ellipsis"
      },
      id: { fontSize: 10, opacity: 0.42, fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
      meta: { display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, opacity: 0.55 },
      actions: { display: "flex", justifyContent: "flex-end", gap: 8 },
      hint: { fontSize: 12, opacity: 0.55, textAlign: "center", padding: "10px 0" },
      notice: { fontSize: 12, opacity: 0.75, padding: "2px 0" },
      error: { fontSize: 12, color: "#e5484d" }
    };

    /** 统一的按钮样式；primary 表示主操作。 */
    function buttonStyle(primary, disabled) {
      return {
        height: 28,
        padding: "0 12px",
        fontSize: 12,
        lineHeight: "26px",
        borderRadius: 8,
        border: primary ? "1px solid rgba(60,120,255,.55)" : "1px solid rgba(127,127,127,.32)",
        color: primary ? "#3c78ff" : "inherit",
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1
      };
    }

    // ─────────────────────────────────────────────────────────────────────
    // 组件
    // ─────────────────────────────────────────────────────────────────────

    const h = react.createElement;

    /** 侧栏入口图标：归档盒。 */
    function ArchivedPanelIcon({ size = 16 }) {
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true"
      },
        h("path", {
          d: "M2.6 2.8h10.8c.33 0 .6.27.6.6v1.5c0 .33-.27.6-.6.6H2.6a.6.6 0 0 1-.6-.6V3.4c0-.33.27-.6.6-.6Z",
          stroke: "currentColor",
          strokeWidth: 1.25
        }),
        h("path", {
          d: "M3.3 5.5v6.9c0 .6.49 1.1 1.1 1.1h7.2c.6 0 1.1-.5 1.1-1.1V5.5M6.1 8.5h3.8",
          stroke: "currentColor",
          strokeWidth: 1.25,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        })
      );
    }

    /** 单条归档会话。 */
    function SessionCard(props) {
      const { session, t, busy, onRestore, onOpen } = props;
      const title = String(session.title ?? "").trim() !== "" ? String(session.title) : t("untitled");
      const meta = [];
      if (Number(session.turns) > 0) meta.push(format(t("turns"), { n: session.turns }));
      const stamp = formatTime(session.lastPromptAt) || formatTime(session.createdAt);
      if (stamp !== "") meta.push(stamp);
      if (Number(session.inputTokens) > 0 || Number(session.outputTokens) > 0) {
        meta.push(format(t("tokens"), { i: Number(session.inputTokens) || 0, o: Number(session.outputTokens) || 0 }));
      }
      const shortId = String(session.id).replace(/^session-/, "").slice(0, 8);

      return h("div", { style: S.card },
        h("div", { style: S.cardHead },
          h("span", { style: S.cardTitle, title }, title),
          h("code", { style: S.id, title: session.id }, shortId)
        ),
        meta.length > 0 ? h("div", { style: S.meta }, meta.map((text, index) => h("span", { key: index }, text))) : null,
        h("div", { style: S.actions },
          h("button", { type: "button", style: buttonStyle(false, busy), disabled: busy, onClick: () => onOpen(session) }, t("open")),
          h("button", { type: "button", style: buttonStyle(true, busy), disabled: busy, onClick: () => onRestore(session) }, busy ? t("restoring") : t("restore"))
        )
      );
    }

    /** 面板主页面。 */
    function ArchivedSessionsPage(props) {
      const t = props.t;
      const [state, setState] = react.useState({ phase: "loading", sessions: [], available: true, error: "" });
      const [query, setQuery] = react.useState("");
      const [busyId, setBusyId] = react.useState("");
      const [notice, setNotice] = react.useState({ kind: "info", text: "" });
      const alive = react.useRef(true);

      react.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      const load = react.useCallback(async () => {
        setState((previous) => ({ ...previous, phase: "loading", error: "" }));
        try {
          const body = await request(LIST_ROUTE);
          if (!alive.current) return;
          setState({
            phase: "ready",
            available: body.available !== false,
            sessions: Array.isArray(body.sessions) ? body.sessions : [],
            error: ""
          });
        } catch (error) {
          if (!alive.current) return;
          setState({ phase: "error", available: true, sessions: [], error: String(error?.message ?? error) });
        }
      }, []);

      react.useEffect(() => {
        void load();
      }, [load]);

      const restore = async (session) => {
        setBusyId(session.id);
        setNotice({ kind: "info", text: "" });
        try {
          await postJson(UNARCHIVE_ROUTE, { id: session.id });
          const title = String(session.title ?? "").trim() !== "" ? session.title : t("untitled");
          setNotice({ kind: "info", text: format(t("restored"), { title }) });
          await load();
          globalThis.dispatchEvent?.(new CustomEvent("dsh-archived-sessions:changed"));
        } catch (error) {
          setNotice({ kind: "error", text: format(t("restoreFailed"), { msg: String(error?.message ?? error) }) });
        } finally {
          if (alive.current) setBusyId("");
        }
      };

      const open = async (session) => {
        setBusyId(session.id);
        setNotice({ kind: "info", text: "" });
        try {
          const lease = await postJson(OPEN_ROUTE, { id: session.id });
          const title = String(session.title ?? "").trim() !== "" ? session.title : t("untitled");
          setNotice({ kind: "info", text: format(t("opened"), { title }) });
          // 宿主已临时解除归档：交给官方工作区 UI 打开该会话。
          try {
            pageContext?.uiWorkspace?.openSession?.(lease.id ?? session.id);
          } catch {
            /* UI 服务不可用时仅提示，不影响恢复功能 */
          }
          await load();
          globalThis.dispatchEvent?.(new CustomEvent("dsh-archived-sessions:changed"));
          // 交接窗口结束时把会话重新归档，面板再刷新一次。
          window.setTimeout(() => {
            void request(`${CLAIM_ROUTE}?token=${encodeURIComponent(lease.token)}`)
              .catch(() => undefined)
              .then(() => {
                if (alive.current) void load();
              });
          }, 2500);
        } catch (error) {
          setNotice({ kind: "error", text: format(t("openFailed"), { msg: String(error?.message ?? error) }) });
        } finally {
          if (alive.current) setBusyId("");
        }
      };

      const keyword = query.trim().toLowerCase();
      const visible = keyword === ""
        ? state.sessions
        : state.sessions.filter((session) => {
            const haystack = `${session.title ?? ""}\n${session.firstPrompt ?? ""}\n${session.id}`.toLowerCase();
            return haystack.includes(keyword);
          });

      return h("div", { style: S.root, "data-dsh-archived-sessions": "" },
        h("div", { style: S.head },
          h("div", { style: S.headRow },
            h("h2", { style: S.title }, t("title")),
            h("span", { style: S.count }, format(t("count"), { n: state.sessions.length }))
          ),
          h("p", { style: S.subtitle }, t("subtitle"))
        ),
        h("div", { style: S.bar },
          h("input", {
            style: S.input,
            value: query,
            placeholder: t("search"),
            "aria-label": t("search"),
            onChange: (event) => setQuery(event.target.value)
          }),
          h("button", { type: "button", style: buttonStyle(false, false), onClick: () => void load() }, t("refresh"))
        ),
        notice.text !== "" ? h("div", { style: notice.kind === "error" ? S.error : S.notice }, notice.text) : null,
        state.phase === "loading" ? h("div", { style: S.hint }, t("loading")) : null,
        state.phase === "error" ? h("div", { style: S.error }, format(t("failed"), { msg: state.error })) : null,
        state.phase === "ready" && state.available === false ? h("div", { style: S.hint }, t("unavailable")) : null,
        state.phase === "ready" && state.available !== false && state.sessions.length === 0
          ? h("div", { style: S.hint }, t("empty"))
          : null,
        state.phase === "ready" && state.sessions.length > 0 && visible.length === 0
          ? h("div", { style: S.hint }, t("noMatch"))
          : null,
        h("div", { style: S.list },
          visible.map((session) => h(SessionCard, {
            key: session.id,
            session,
            t,
            busy: busyId === session.id,
            onRestore: restore,
            onOpen: open
          }))
        )
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // 注册
    // ─────────────────────────────────────────────────────────────────────

    /** 只声明对侧栏面板清单的依赖；「打开会话」用可选的 uiWorkspace。 */
    const inject = ["@deepseek-ai/dsh-client-ui-sidebar"];

    let pageContext;

    function apply(ctx) {
      pageContext = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "archived-sessions: locale");
      const t = ctx.locale.bind(NS);

      // 主页面：与官方「插件」面板同构（main slot + PANEL_ID 作 key）。
      ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        locale: NS
      }, ArchivedSessionsPage));

      // 侧栏入口：一个带图标的全局面板按钮。
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
