"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Database,
  History,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  PlayCircle,
  Plus,
  Sparkles,
  X
} from "lucide-react";
import {
  clearDbQueryHistory,
  generateDbSql,
  getDbConnections,
  getDbQueryHistory,
  runConnectionQuery,
  type DbConnection,
  type DbQueryHistory,
  type DbQueryResult
} from "@/lib/api";
import { DbNavigator, type DbNavigatorCtx } from "@/components/db-navigator";
import { DbSqlEditor } from "@/components/db-sql-editor";
import { DbResultGrid } from "@/components/db-result-grid";
import { DbQueryHistoryPanel } from "@/components/db-query-history";

type QueryTab = {
  id: string;
  title: string;
  connectionId: string;
  connectionName: string;
  engine: string;
  environment: string;
  // resolved DB name, used by the production destructive-query confirmation
  database: string;
  sql: string;
  result: DbQueryResult | null;
  error: string;
  running: boolean;
};

let tabSeq = 0;
let queryCounter = 0;
function newTabId(): string {
  tabSeq += 1;
  return `tab-${tabSeq}-${Date.now()}`;
}

// Quote a schema.table reference per engine (pg double-quote, mysql backtick), doubling any
// embedded quote char so odd identifiers stay valid.
function quoteTableRef(engine: string, schema: string, table: string): string {
  const q =
    engine === "mysql"
      ? (s: string) => "`" + s.replace(/`/g, "``") + "`"
      : (s: string) => '"' + s.replace(/"/g, '""') + '"';
  return schema ? `${q(schema)}.${q(table)}` : q(table);
}

// A very light, dependency-free SQL prettifier: collapse runs of whitespace and start the major
// clauses on their own lines. Deliberately conservative — it never rewrites identifiers or
// literals, so at worst it is a no-op on unusual SQL.
function formatSql(input: string): string {
  const clauses = ["FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "JOIN", "UNION", "VALUES", "SET"];
  let out = input.replace(/\s+/g, " ").trim();
  for (const clause of clauses) {
    const re = new RegExp(`\\s+(${clause.replace(/ /g, "\\s+")})\\b`, "gi");
    out = out.replace(re, (_m, kw) => `\n${String(kw).toUpperCase()}`);
  }
  return out;
}

// Classify a statement as potentially destructive. A simple keyword scan is intentionally
// conservative: it errs toward warning. Returns the reason so the confirmation can say why.
function analyzeDanger(sql: string): { dangerous: boolean; reason: string } {
  const text = sql.toLowerCase();
  if (/\bdrop\s+database\b/.test(text)) return { dangerous: true, reason: "DROP DATABASE" };
  if (/\bdrop\b/.test(text)) return { dangerous: true, reason: "DROP" };
  if (/\btruncate\b/.test(text)) return { dangerous: true, reason: "TRUNCATE" };
  if (/\balter\b/.test(text)) return { dangerous: true, reason: "ALTER" };
  if (/\bdelete\b/.test(text) && !/\bwhere\b/.test(text)) return { dangerous: true, reason: "DELETE without WHERE" };
  if (/\bupdate\b/.test(text) && !/\bwhere\b/.test(text)) return { dangerous: true, reason: "UPDATE without WHERE" };
  return { dangerous: false, reason: "" };
}

const MIN_LEFT = 220;
const MAX_LEFT = 520;
const MIN_EDITOR = 120;
const MAX_EDITOR = 720;

export function DbWorkspace({ token }: { token: string }) {
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [tabs, setTabs] = useState<QueryTab[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [leftWidth, setLeftWidth] = useState(300);
  const [dragging, setDragging] = useState(false);
  // left navigator pane collapsed to a thin strip
  const [navCollapsed, setNavCollapsed] = useState(false);
  // vertical split between the SQL editor and the result grid
  const [editorHeight, setEditorHeight] = useState(260);
  const [vDragging, setVDragging] = useState(false);
  const vDragRef = useRef<{ startY: number; startH: number } | null>(null);
  // fullscreen (focus) mode: the workspace covers the app sidebar + header as a fixed overlay
  const [fullscreen, setFullscreen] = useState(false);
  // bump to force the navigator to reload its connection list (kept in sync when we reload ours)
  const [navRefreshKey] = useState(0);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<DbQueryHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState("");

  // Production destructive-query gate: set when a prod connection runs a dangerous statement. The
  // modal only enables Execute once the operator types the database name exactly.
  const [prodGate, setProdGate] = useState<{ tabId: string; sql: string; database: string } | null>(null);
  const [prodTyped, setProdTyped] = useState("");

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await getDbConnections(token));
    } catch {
      // A failure here only degrades the "+" dropdown and deep-link resolution; the navigator
      // surfaces its own load errors.
    }
  }, [token]);

  const loadHistory = useCallback(
    async (search = historySearch) => {
      setHistoryLoading(true);
      try {
        setHistory(await getDbQueryHistory(token, search ? { search } : undefined));
      } catch {
        setHistory([]);
      } finally {
        setHistoryLoading(false);
      }
    },
    [token, historySearch]
  );

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  // --- tab helpers ---
  const patchTab = useCallback((id: string, patch: Partial<QueryTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const databaseFor = useCallback(
    (connectionId: string) => connections.find((c) => c.id === connectionId)?.database ?? "",
    [connections]
  );

  const addTab = useCallback(
    (tab: Omit<QueryTab, "id" | "result" | "error" | "running">) => {
      const id = newTabId();
      const full: QueryTab = { ...tab, id, result: null, error: "", running: false };
      setTabs((prev) => [...prev, full]);
      setActiveId(id);
      return id;
    },
    []
  );

  // Keep a ref to the latest tabs so execute()/runTab() (stable callbacks) can read current tab
  // state without being torn down and recreated on every keystroke.
  const tabsRef = useRef<QueryTab[]>(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // --- query execution ---
  const execute = useCallback(
    async (tabId: string, sqlText: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || !tab.connectionId) return;
      patchTab(tabId, { running: true, error: "", result: null });
      try {
        const res = await runConnectionQuery(token, tab.connectionId, sqlText);
        patchTab(tabId, { running: false, result: res, error: "", sql: sqlText });
      } catch (e) {
        patchTab(tabId, { running: false, result: null, error: e instanceof Error ? e.message : "Query failed" });
      } finally {
        void loadHistory();
      }
    },
    [token, patchTab, loadHistory]
  );

  // Gatekeeper: production warnings + destructive checks before handing off to execute().
  const runTab = useCallback(
    (tabId: string, sqlText: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || !tab.connectionId || !sqlText.trim()) return;
      const danger = analyzeDanger(sqlText);
      const isProd = tab.environment === "prod";
      if (isProd && danger.dangerous) {
        // Strongest gate: require typing the database name to proceed. Never execute here.
        setProdTyped("");
        setProdGate({ tabId, sql: sqlText, database: tab.database || databaseFor(tab.connectionId) });
        return;
      }
      if (isProd) {
        if (!window.confirm("⚠ PRODUCTION\n\nThis query runs against a PRODUCTION connection and may modify production data. Continue?")) return;
      } else if (danger.dangerous) {
        if (!window.confirm(`This statement looks destructive (${danger.reason}). Run it?`)) return;
      }
      void execute(tabId, sqlText);
    },
    [execute, databaseFor]
  );

  // --- navigator callbacks ---
  const onOpenEditor = useCallback(
    (ctx: DbNavigatorCtx) => {
      queryCounter += 1;
      const seed = ctx.schema ? `-- ${ctx.connectionName} / ${ctx.schema}\n` : "";
      addTab({
        title: `Query ${queryCounter}`,
        connectionId: ctx.connectionId,
        connectionName: ctx.connectionName,
        engine: ctx.engine,
        environment: ctx.environment,
        database: databaseFor(ctx.connectionId),
        sql: seed
      });
    },
    [addTab, databaseFor]
  );

  const onViewData = useCallback(
    (ctx: DbNavigatorCtx) => {
      if (!ctx.schema || !ctx.table) return;
      const sql = `SELECT * FROM ${quoteTableRef(ctx.engine, ctx.schema, ctx.table)} LIMIT 200;`;
      const id = addTab({
        title: ctx.table,
        connectionId: ctx.connectionId,
        connectionName: ctx.connectionName,
        engine: ctx.engine,
        environment: ctx.environment,
        database: databaseFor(ctx.connectionId),
        sql
      });
      // Auto-run: a SELECT ... LIMIT is safe even on prod, so it flows straight through runTab.
      void runTabById(id, sql);
    },
    // runTabById defined below via ref indirection
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addTab, databaseFor]
  );

  const onGenerate = useCallback(
    async (ctx: DbNavigatorCtx, kind: string) => {
      if (!ctx.schema || !ctx.table) return;
      const id = addTab({
        title: `${kind} ${ctx.table}`,
        connectionId: ctx.connectionId,
        connectionName: ctx.connectionName,
        engine: ctx.engine,
        environment: ctx.environment,
        database: databaseFor(ctx.connectionId),
        sql: `-- generating ${kind}…`
      });
      try {
        const { sql } = await generateDbSql(token, ctx.connectionId, {
          schema: ctx.schema,
          table: ctx.table,
          kind,
          // when browsing a non-default database via "Show all databases", target that database
          database: ctx.database
        });
        // Write kinds are never auto-run; the user reviews and runs them by hand.
        patchTab(id, { sql });
      } catch (e) {
        patchTab(id, { sql: `-- Failed to generate ${kind}: ${e instanceof Error ? e.message : "error"}` });
      }
    },
    [addTab, databaseFor, token, patchTab]
  );

  // runTab needs the freshest closure; onViewData's auto-run references it via this stable wrapper.
  const runTabRef = useRef(runTab);
  useEffect(() => {
    runTabRef.current = runTab;
  }, [runTab]);
  function runTabById(id: string, sqlText: string) {
    runTabRef.current(id, sqlText);
  }

  // --- deep link: ?conn=&table= opens+runs a data tab once, after connections load ---
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current || connections.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const connId = params.get("conn");
    const table = params.get("table");
    if (!connId || !table) {
      autoRanRef.current = true;
      return;
    }
    const conn = connections.find((c) => c.id === connId);
    if (!conn) {
      autoRanRef.current = true;
      return;
    }
    autoRanRef.current = true;
    const dot = table.indexOf(".");
    const schema = dot >= 0 ? table.slice(0, dot) : "";
    const name = dot >= 0 ? table.slice(dot + 1) : table;
    onViewData({
      connectionId: conn.id,
      connectionName: conn.name,
      engine: conn.engine,
      environment: conn.environment,
      schema,
      table: name
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  // --- history load on first open ---
  useEffect(() => {
    if (historyOpen) void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen]);

  const onHistoryPick = useCallback(
    (item: DbQueryHistory) => {
      const conn = item.connection_id != null ? connections.find((c) => String(c.id) === String(item.connection_id)) : undefined;
      queryCounter += 1;
      addTab({
        title: `History ${queryCounter}`,
        connectionId: conn?.id ?? "",
        connectionName: conn?.name ?? item.connection_name,
        engine: conn?.engine ?? item.engine,
        environment: conn?.environment ?? "",
        database: conn?.database ?? item.database,
        sql: item.sql
      });
    },
    [connections, addTab]
  );

  const onHistoryClear = useCallback(async () => {
    try {
      await clearDbQueryHistory(token);
      await loadHistory();
    } catch {
      // leave the current list in place on failure
    }
  }, [token, loadHistory]);

  const onHistorySearch = useCallback(
    (q: string) => {
      setHistorySearch(q);
      void loadHistory(q);
    },
    [loadHistory]
  );

  // --- close tab ---
  function closeTab(id: string) {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) {
        const fallback = next[idx] ?? next[idx - 1] ?? next[0] ?? null;
        setActiveId(fallback ? fallback.id : "");
      }
      return next;
    });
  }

  function openBlankTab() {
    queryCounter += 1;
    addTab({
      title: `Query ${queryCounter}`,
      connectionId: "",
      connectionName: "",
      engine: "postgres",
      environment: "",
      database: "",
      sql: ""
    });
  }

  // --- left navigator resize divider ---
  useEffect(() => {
    if (!dragging) return;
    function onMove(e: MouseEvent) {
      setLeftWidth(Math.max(MIN_LEFT, Math.min(MAX_LEFT, e.clientX)));
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // --- editor/result vertical resize divider ---
  useEffect(() => {
    if (!vDragging) return;
    function onMove(e: MouseEvent) {
      const start = vDragRef.current;
      if (!start) return;
      const next = start.startH + (e.clientY - start.startY);
      setEditorHeight(Math.max(MIN_EDITOR, Math.min(MAX_EDITOR, next)));
    }
    function onUp() {
      setVDragging(false);
      vDragRef.current = null;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [vDragging]);

  // Escape leaves fullscreen (focus) mode.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // "Fetch all rows": re-run the active tab's last query at the server's max limit (5000). Keeps the
  // current result visible until the larger set arrives so the grid + footer don't flicker away.
  const fetchAll = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab || !tab.connectionId || !tab.sql.trim()) return;
      patchTab(tabId, { running: true, error: "" });
      try {
        const res = await runConnectionQuery(token, tab.connectionId, tab.sql, 5000);
        patchTab(tabId, { running: false, result: res, error: "" });
      } catch (e) {
        patchTab(tabId, { running: false, error: e instanceof Error ? e.message : "Query failed" });
      } finally {
        void loadHistory();
      }
    },
    [token, patchTab, loadHistory]
  );

  // "Run selection" toolbar button: reads the live DOM selection so it works with CodeMirror
  // without needing a ref into the editor; falls back to the whole buffer when nothing is selected.
  function runSelection() {
    if (!activeTab) return;
    const selected = (typeof window !== "undefined" ? window.getSelection()?.toString() : "") ?? "";
    runTab(activeTab.id, selected.trim() ? selected : activeTab.sql);
  }

  const prodGateValid = prodGate ? prodTyped.trim() === (prodGate.database || "").trim() && !!prodGate.database : false;

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex h-screen w-screen overflow-hidden bg-page"
          : "flex h-[calc(100vh-4rem)] w-full overflow-hidden bg-page"
      }
    >
      {navCollapsed ? (
        /* collapsed: thin strip with an expand affordance */
        <div className="flex h-full w-10 shrink-0 flex-col items-center gap-3 border-r border-edge bg-elevated py-3">
          <button
            type="button"
            onClick={() => setNavCollapsed(false)}
            title="Show connections"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-fg"
          >
            <PanelLeftOpen size={16} />
          </button>
          <Database size={16} className="text-accent" />
        </div>
      ) : (
        <>
          {/* LEFT: navigator */}
          <div style={{ width: leftWidth }} className="relative h-full shrink-0 overflow-hidden bg-elevated">
            <button
              type="button"
              onClick={() => setNavCollapsed(true)}
              title="Collapse connections"
              className="absolute bottom-2 right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-lg bg-surface text-muted ring-1 ring-edge transition-colors hover:text-fg"
            >
              <PanelLeftClose size={15} />
            </button>
            <DbNavigator
              token={token}
              onOpenEditor={onOpenEditor}
              onViewData={onViewData}
              onGenerate={onGenerate}
              refreshKey={navRefreshKey}
            />
          </div>

          {/* divider */}
          <div
            onMouseDown={() => setDragging(true)}
            className={`h-full w-1 shrink-0 cursor-col-resize bg-edge transition-colors hover:bg-accent ${dragging ? "bg-accent" : ""}`}
            title="Drag to resize"
          />
        </>
      )}

      {/* RIGHT: editor + results + history */}
      <div className="flex h-full min-w-0 flex-1">
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {/* tab bar */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-edge bg-elevated px-2 py-1.5">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab.id === activeId ? "bg-surface text-fg ring-1 ring-edge" : "text-muted hover:bg-surface/60"
                }`}
              >
                <span className="max-w-[160px] truncate">{tab.title}</span>
                {tab.environment === "prod" && (
                  <span className="rounded bg-danger/15 px-1 py-0.5 text-[9px] font-bold uppercase leading-none text-danger">prod</span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-muted opacity-60 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={openBlankTab}
              title="New query"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-fg"
            >
              <Plus size={16} />
            </button>
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              title="Toggle query history"
              className={`ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                historyOpen ? "bg-accent text-white" : "text-muted ring-1 ring-edge hover:text-fg"
              }`}
            >
              <History size={14} /> History
            </button>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors ${
                fullscreen ? "bg-accent text-white" : "text-muted ring-1 ring-edge hover:text-fg"
              }`}
            >
              {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {fullscreen ? "Exit" : "Fullscreen"}
            </button>
          </div>

          {!activeTab ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted">
              <p>Open a table or connection from the navigator, or start a blank query.</p>
              <button
                type="button"
                onClick={openBlankTab}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80"
              >
                <Plus size={16} /> New query
              </button>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col p-3">
              {/* toolbar */}
              <div className="flex flex-wrap items-center gap-2 pb-3">
                <button
                  type="button"
                  onClick={() => runTab(activeTab.id, activeTab.sql)}
                  disabled={activeTab.running || !activeTab.connectionId || !activeTab.sql.trim()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
                >
                  <Play size={15} /> Run
                </button>
                <button
                  type="button"
                  onClick={runSelection}
                  disabled={activeTab.running || !activeTab.connectionId}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50"
                >
                  <PlayCircle size={15} /> Run selection
                </button>
                <button
                  type="button"
                  onClick={() => patchTab(activeTab.id, { sql: formatSql(activeTab.sql) })}
                  disabled={!activeTab.sql.trim()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50"
                >
                  <Sparkles size={15} /> Format
                </button>

                {/* connection picker / label */}
                {activeTab.connectionId ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-xs font-semibold text-muted ring-1 ring-edge">
                    {activeTab.connectionName}
                    <span className="text-muted/70">· {activeTab.engine}</span>
                    {activeTab.environment && (
                      <span className={activeTab.environment === "prod" ? "font-bold text-danger" : "text-muted/70"}>· {activeTab.environment}</span>
                    )}
                  </span>
                ) : (
                  <select
                    value=""
                    onChange={(e) => {
                      const conn = connections.find((c) => c.id === e.target.value);
                      if (conn) {
                        patchTab(activeTab.id, {
                          connectionId: conn.id,
                          connectionName: conn.name,
                          engine: conn.engine,
                          environment: conn.environment,
                          database: conn.database
                        });
                      }
                    }}
                    className="h-9 rounded-lg border-none bg-surface px-3 text-sm font-medium text-fg outline-none ring-1 ring-edge focus:ring-2 focus:ring-accent"
                  >
                    <option value="">Pick a connection…</option>
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {c.engine}
                        {c.environment ? ` · ${c.environment}` : ""}
                      </option>
                    ))}
                  </select>
                )}

                {/* status line */}
                <span className="ml-auto text-xs font-medium text-muted">
                  {activeTab.running
                    ? "Running…"
                    : activeTab.result
                    ? `${activeTab.result.row_count} row${activeTab.result.row_count === 1 ? "" : "s"} · ${activeTab.result.elapsed_ms} ms${
                        activeTab.result.truncated ? " · truncated" : ""
                      }`
                    : ""}
                </span>
              </div>

              {/* editor */}
              <div style={{ height: editorHeight }} className="min-h-0 shrink-0 overflow-hidden">
                <DbSqlEditor
                  value={activeTab.sql}
                  onChange={(v) => patchTab(activeTab.id, { sql: v })}
                  onRun={(sqlText) => runTab(activeTab.id, sqlText)}
                  engine={activeTab.engine}
                  height={`${editorHeight}px`}
                />
              </div>

              {/* horizontal divider: drag to grow/shrink the editor vs the results */}
              <div
                onMouseDown={(e) => {
                  vDragRef.current = { startY: e.clientY, startH: editorHeight };
                  setVDragging(true);
                }}
                className={`my-1.5 h-1.5 shrink-0 cursor-row-resize rounded bg-edge transition-colors hover:bg-accent ${
                  vDragging ? "bg-accent" : ""
                }`}
                title="Drag to resize editor / results"
              />

              {/* results */}
              <div className="min-h-0 flex-1 overflow-auto">
                <DbResultGrid
                  result={activeTab.result}
                  error={activeTab.error}
                  onFetchAll={() => fetchAll(activeTab.id)}
                  fetching={activeTab.running}
                />
              </div>
            </div>
          )}
        </div>

        {/* history panel */}
        {historyOpen && (
          <div className="h-full w-80 shrink-0 border-l border-edge bg-elevated p-2">
            <DbQueryHistoryPanel
              items={history}
              loading={historyLoading}
              onPick={onHistoryPick}
              onSearch={onHistorySearch}
              onClear={onHistoryClear}
            />
          </div>
        )}
      </div>

      {/* production destructive-query confirmation */}
      {prodGate && (
        <div className="fixed inset-0 z-[93] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
          <button aria-label="Cancel" onClick={() => setProdGate(null)} className="absolute inset-0 cursor-default" />
          <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl bg-elevated p-6 shadow-xl ring-2 ring-danger">
            <div className="flex items-start gap-3">
              <AlertTriangle size={22} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0">
                <h2 className="text-base font-bold text-danger">Production destructive statement</h2>
                <p className="mt-1 text-sm text-fg">
                  This statement can modify or destroy data on the <span className="font-semibold">PRODUCTION</span> database
                  {prodGate.database ? (
                    <>
                      {" "}
                      <span className="font-mono font-semibold">{prodGate.database}</span>
                    </>
                  ) : null}
                  . To proceed, type the database name below.
                </p>
              </div>
            </div>
            <pre className="mt-3 max-h-32 overflow-auto rounded-xl bg-surface p-3 font-mono text-xs text-fg ring-1 ring-edge">{prodGate.sql}</pre>
            <input
              value={prodTyped}
              onChange={(e) => setProdTyped(e.target.value)}
              placeholder={prodGate.database || "database name"}
              autoFocus
              spellCheck={false}
              className="mt-3 h-11 w-full rounded-xl border-none bg-surface px-4 font-mono text-sm text-fg outline-none ring-1 ring-edge focus:ring-2 focus:ring-danger"
            />
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setProdGate(null)}
                className="h-10 rounded-full px-4 text-sm font-semibold text-muted transition-colors hover:text-fg"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!prodGateValid}
                onClick={() => {
                  const gate = prodGate;
                  setProdGate(null);
                  void execute(gate.tabId, gate.sql);
                }}
                className="h-10 rounded-full bg-danger px-5 text-sm font-semibold text-white transition-colors hover:bg-danger/80 disabled:opacity-50"
              >
                Execute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
