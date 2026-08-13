"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, Loader2, Pencil, Play, Plus, PlugZap, Table2, Trash2, X } from "lucide-react";
import {
  ApiError,
  createDbConnection,
  dbQuery,
  dbTestConnection,
  deleteDbConnection,
  getDbConnections,
  runConnectionQuery,
  testDbConnection,
  testDbConnectionById,
  updateDbConnection,
  type DbConnection,
  type DbConnectionInput,
  type DbConnectionParams,
  type DbEngine,
  type DbQueryResult
} from "@/lib/api";
import { useConfirm } from "@/components/confirm-dialog";

// Per-engine default ports; also used to swap the port field when the engine changes and the
// user has not overridden it, so postgres -> mysql moves 5432 to 3306 without a manual edit.
const DEFAULT_PORTS: Record<DbEngine, number> = { postgres: 5432, mysql: 3306 };

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

type StatusNote = { kind: "ok" | "error"; text: string } | null;

// Quote a "schema.name" table reference per engine so the generated SELECT is valid for either.
// postgres -> "schema"."name"; mysql -> `schema`.`name`. Embedded quote chars are doubled.
function quoteTable(engine: DbEngine, tableParam: string): string {
  const dot = tableParam.indexOf(".");
  const schema = dot >= 0 ? tableParam.slice(0, dot) : "";
  const name = dot >= 0 ? tableParam.slice(dot + 1) : tableParam;
  if (engine === "mysql") {
    const q = (s: string) => "`" + s.replace(/`/g, "``") + "`";
    return schema ? `${q(schema)}.${q(name)}` : q(name);
  }
  const q = (s: string) => '"' + s.replace(/"/g, '""') + '"';
  return schema ? `${q(schema)}.${q(name)}` : q(name);
}

export function DatabaseConsole({ token }: { token: string }) {
  const { confirm, confirmDialog } = useConfirm();

  // --- ad-hoc connection fields (unchanged behaviour) ---
  const [engine, setEngine] = useState<DbEngine>("postgres");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number>(DEFAULT_PORTS.postgres);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [sql, setSql] = useState("");

  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [connNote, setConnNote] = useState<StatusNote>(null);
  const [queryError, setQueryError] = useState("");
  const [result, setResult] = useState<DbQueryResult | null>(null);

  // --- stored connections ---
  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connError, setConnError] = useState("");
  // "" selects the ad-hoc manual fields; a connection id runs against that stored connection.
  const [selectedConnId, setSelectedConnId] = useState("");

  // --- create / edit form for a stored connection ---
  const [showConnForm, setShowConnForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fEngine, setFEngine] = useState<DbEngine>("postgres");
  const [fHost, setFHost] = useState("");
  const [fPort, setFPort] = useState<number>(DEFAULT_PORTS.postgres);
  const [fUsername, setFUsername] = useState("");
  const [fPassword, setFPassword] = useState("");
  const [fDatabase, setFDatabase] = useState("");
  const [fGroup, setFGroup] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formTesting, setFormTesting] = useState(false);
  const [formNote, setFormNote] = useState<StatusNote>(null);
  const [formError, setFormError] = useState("");

  const selectedConn = connections.find((c) => c.id === selectedConnId) ?? null;

  async function loadConnections() {
    try {
      setConnections(await getDbConnections(token));
      setConnError("");
    } catch (error) {
      setConnError(error instanceof Error ? error.message : "Unable to load connections");
    } finally {
      setConnectionsLoaded(true);
    }
  }

  useEffect(() => {
    void loadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Deep-link support: /databases?conn=<id>&table=<schema.name> preselects the connection, fills a
  // safe SELECT ... LIMIT 200 quoted for that engine, and auto-runs it. Read the params from
  // window.location INSIDE an effect (not next/navigation useSearchParams — this is a static export,
  // where that hook forces a Suspense boundary and can break the build). Runs once, after the
  // connection list is loaded so the engine is known for quoting.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current || !connectionsLoaded) return;
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
    setSelectedConnId(connId);
    const generated = `SELECT * FROM ${quoteTable(conn.engine, table)} LIMIT 200`;
    setSql(generated);
    void executeQuery(connId, generated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionsLoaded, connections]);

  function changeEngine(next: DbEngine) {
    setPort((current) => (current === DEFAULT_PORTS[engine] ? DEFAULT_PORTS[next] : current));
    setEngine(next);
    setConnNote(null);
  }

  function params(): DbConnectionParams {
    return { engine, host: host.trim(), port: Number(port) || DEFAULT_PORTS[engine], username, password, database: database.trim() };
  }

  async function test() {
    setTesting(true);
    setConnNote(null);
    try {
      const res = selectedConnId ? await testDbConnectionById(token, selectedConnId) : await dbTestConnection(token, params());
      setConnNote({ kind: res.ok ? "ok" : "error", text: res.message });
    } catch (error) {
      setConnNote({ kind: "error", text: error instanceof Error ? error.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  // Shared query runner: a stored connection goes through runConnectionQuery (backend defaults to
  // 200 rows unless the SQL carries its own LIMIT); ad-hoc keeps using dbQuery with the manual params.
  async function executeQuery(useConnId: string, sqlText: string) {
    setRunning(true);
    setQueryError("");
    setResult(null);
    try {
      const res = useConnId
        ? await runConnectionQuery(token, useConnId, sqlText)
        : await dbQuery(token, { ...params(), sql: sqlText });
      setResult(res);
    } catch (error) {
      // A bad query or unreachable host comes back as an ApiError (HTTP 400) carrying the DB
      // error text; anything else is surfaced with its message too.
      setQueryError(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Query failed");
    } finally {
      setRunning(false);
    }
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sql.trim()) {
      setQueryError("Enter a SQL statement to run.");
      return;
    }
    await executeQuery(selectedConnId, sql);
  }

  // --- stored-connection form helpers ---
  function openAdd() {
    setEditingId(null);
    setFName("");
    setFEngine("postgres");
    setFHost("");
    setFPort(DEFAULT_PORTS.postgres);
    setFUsername("");
    setFPassword("");
    setFDatabase("");
    setFGroup("");
    setFormNote(null);
    setFormError("");
    setShowConnForm(true);
  }

  function openEdit(conn: DbConnection) {
    setEditingId(conn.id);
    setFName(conn.name);
    setFEngine(conn.engine);
    setFHost(conn.host);
    setFPort(conn.port);
    setFUsername(conn.username);
    // Password is write-only: leave blank to keep the stored one.
    setFPassword("");
    setFDatabase(conn.database);
    setFGroup(conn.group ?? "");
    setFormNote(null);
    setFormError("");
    setShowConnForm(true);
  }

  function changeFormEngine(next: DbEngine) {
    setFPort((current) => (current === DEFAULT_PORTS[fEngine] ? DEFAULT_PORTS[next] : current));
    setFEngine(next);
    setFormNote(null);
  }

  function formInput(): DbConnectionInput {
    return {
      name: fName.trim(),
      engine: fEngine,
      host: fHost.trim(),
      port: Number(fPort) || DEFAULT_PORTS[fEngine],
      username: fUsername,
      database: fDatabase.trim(),
      group: fGroup.trim() ? fGroup.trim() : null
    };
  }

  async function testForm() {
    setFormTesting(true);
    setFormNote(null);
    try {
      const res = await testDbConnection(token, { ...formInput(), password: fPassword });
      setFormNote({ kind: res.ok ? "ok" : "error", text: res.message });
    } catch (error) {
      setFormNote({ kind: "error", text: error instanceof Error ? error.message : "Connection test failed" });
    } finally {
      setFormTesting(false);
    }
  }

  async function saveForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormSaving(true);
    setFormError("");
    try {
      if (editingId) {
        const payload: Partial<DbConnectionInput> = { ...formInput() };
        // A blank password on edit keeps whatever is stored; only send it when the user typed one.
        if (fPassword) payload.password = fPassword;
        await updateDbConnection(token, editingId, payload);
      } else {
        await createDbConnection(token, { ...formInput(), password: fPassword });
      }
      await loadConnections();
      setShowConnForm(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to save connection");
    } finally {
      setFormSaving(false);
    }
  }

  async function removeConn(conn: DbConnection) {
    if (
      !(await confirm({
        title: `Delete ${conn.name}?`,
        message: "The stored connection and its credentials are removed. This cannot be undone.",
        confirmLabel: "Delete connection",
        danger: true
      }))
    )
      return;
    try {
      await deleteDbConnection(token, conn.id);
      if (selectedConnId === conn.id) setSelectedConnId("");
      await loadConnections();
    } catch (error) {
      setConnError(error instanceof Error ? error.message : "Unable to delete connection");
    }
  }

  // shared button style for the small segmented engine toggle in the form
  function engineButton(value: DbEngine, label: string) {
    const active = fEngine === value;
    return (
      <button
        type="button"
        onClick={() => changeFormEngine(value)}
        className={`h-11 flex-1 rounded-xl px-4 text-sm font-semibold transition-colors ${
          active ? "bg-accent text-white" : "bg-surface text-muted ring-1 ring-edge hover:text-fg"
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="space-y-6 px-6 py-6">
      {confirmDialog}

      {/* Connections manager */}
      <div className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
        <div className="flex items-center justify-between border-b border-edge px-6 py-5">
          <div className="flex items-center gap-3">
            <Database size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-fg">Connections</h2>
          </div>
          <button
            type="button"
            onClick={() => (showConnForm ? setShowConnForm(false) : openAdd())}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80"
          >
            {showConnForm ? (
              <>
                <X size={16} /> Cancel
              </>
            ) : (
              <>
                <Plus size={16} /> Add connection
              </>
            )}
          </button>
        </div>

        {showConnForm && (
          <form onSubmit={saveForm} className="grid gap-4 border-b border-edge bg-surface/40 p-6 md:grid-cols-3">
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Name
              <input value={fName} onChange={(e) => setFName(e.target.value)} required placeholder="Reporting replica" className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Engine
              <div className="flex gap-2">
                {engineButton("postgres", "PostgreSQL")}
                {engineButton("mysql", "MySQL")}
              </div>
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Group
              <input value={fGroup} onChange={(e) => setFGroup(e.target.value)} placeholder="Optional" className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
              Host
              <input value={fHost} onChange={(e) => setFHost(e.target.value)} placeholder="db.example.internal" className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Port
              <input type="number" min={1} max={65535} value={fPort} onChange={(e) => setFPort(Number(e.target.value))} className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Database
              <input value={fDatabase} onChange={(e) => setFDatabase(e.target.value)} placeholder="app" className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Username
              <input value={fUsername} onChange={(e) => setFUsername(e.target.value)} autoComplete="off" placeholder="reader" className={inputClass} />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Password
              <input
                type="password"
                value={fPassword}
                onChange={(e) => setFPassword(e.target.value)}
                autoComplete="new-password"
                placeholder={editingId ? "•••••••• (unchanged)" : "••••••••"}
                className={inputClass}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3 md:col-span-3">
              <button
                type="submit"
                disabled={formSaving || !fName.trim() || !fHost.trim()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
              >
                {formSaving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                {editingId ? "Save changes" : "Save connection"}
              </button>
              <button
                type="button"
                onClick={() => void testForm()}
                disabled={formTesting || !fHost.trim()}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-surface px-5 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50"
              >
                {formTesting ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
                Test
              </button>
            </div>
            {formNote && (
              <div
                className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium md:col-span-3 ${
                  formNote.kind === "ok" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-danger/10 text-danger dark:text-red-300"
                }`}
              >
                {formNote.kind === "ok" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
                <span className="break-words">{formNote.text}</span>
              </div>
            )}
            {formError && (
              <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300 md:col-span-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span className="break-words">{formError}</span>
              </div>
            )}
          </form>
        )}

        <div className="p-6">
          {connError && (
            <div className="mb-4 flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{connError}</span>
            </div>
          )}
          {!connectionsLoaded ? (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" /> Loading connections…
            </div>
          ) : connections.length === 0 ? (
            <p className="text-sm font-medium text-muted">No stored connections yet. Add one to reuse its credentials, or run an ad-hoc query below.</p>
          ) : (
            <div className="grid gap-2">
              {connections.map((conn) => (
                <div key={conn.id} className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3 ring-1 ring-edge">
                  <Database size={16} className="shrink-0 text-accent" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-fg">{conn.name}</span>
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{conn.engine}</span>
                      {conn.group && <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-medium text-muted">{conn.group}</span>}
                    </div>
                    <p className="truncate text-xs text-muted">
                      {conn.username ? `${conn.username}@` : ""}
                      {conn.host}:{conn.port}
                      {conn.database ? `/${conn.database}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openEdit(conn)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-muted transition-colors hover:text-accent"
                  >
                    <Pencil size={14} /> Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void removeConn(conn)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-danger transition-colors hover:text-danger/80"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Connection selection + ad-hoc fields */}
      <div className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge px-6 py-5">
          <PlugZap size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-fg">Connection</h2>
        </div>
        <div className="grid gap-4 p-6 md:grid-cols-3">
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-3">
            Use connection
            <select
              value={selectedConnId}
              onChange={(e) => {
                setSelectedConnId(e.target.value);
                setConnNote(null);
              }}
              className={inputClass}
            >
              <option value="">Ad-hoc (enter details below)</option>
              {connections.map((conn) => (
                <option key={conn.id} value={conn.id}>
                  {conn.name} — {conn.engine} · {conn.host}
                </option>
              ))}
            </select>
          </label>

          {selectedConnId ? (
            <p className="text-sm font-medium text-muted md:col-span-3">
              Running against <span className="font-semibold text-fg">{selectedConn?.name}</span> ({selectedConn?.engine}) at {selectedConn?.host}:{selectedConn?.port}
              {selectedConn?.database ? `/${selectedConn.database}` : ""}.
            </p>
          ) : (
            <>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Engine
                <select value={engine} onChange={(e) => changeEngine(e.target.value as DbEngine)} className={inputClass}>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
                Host
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.example.internal" className={inputClass} />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Port
                <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputClass} />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Database
                <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="app" className={inputClass} />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="reader" className={inputClass} />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="••••••••"
                  className={inputClass}
                />
              </label>
            </>
          )}

          <div className="flex items-end md:col-span-3">
            <button
              type="button"
              onClick={() => void test()}
              disabled={testing || (!selectedConnId && !host.trim())}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              {testing ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
              Test connection
            </button>
          </div>
          {connNote && (
            <div
              className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium md:col-span-3 ${
                connNote.kind === "ok" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-danger/10 text-danger dark:text-red-300"
              }`}
            >
              {connNote.kind === "ok" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
              <span className="break-words">{connNote.text}</span>
            </div>
          )}
        </div>
      </div>

      {/* Query card */}
      <form onSubmit={run} className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge px-6 py-5">
          <Database size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-fg">Query</h2>
          <span className="ml-2 text-xs font-medium text-muted">Read-only. One statement at a time.</span>
        </div>
        <div className="space-y-4 p-6">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder="SELECT * FROM information_schema.tables LIMIT 50"
            className="w-full resize-y rounded-xl border-none bg-surface px-4 py-3 font-mono text-sm text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent"
          />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={running || (!selectedConnId && !host.trim())}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
              Run
            </button>
            {result && !queryError && (
              <span className="text-sm font-medium text-muted">
                {result.row_count} row{result.row_count === 1 ? "" : "s"} in {result.elapsed_ms} ms
                {result.truncated ? ` — showing the first ${result.row_count}` : ""}
              </span>
            )}
          </div>
          {queryError && (
            <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{queryError}</span>
            </div>
          )}
        </div>
      </form>

      {/* Results */}
      {result && !queryError && (
        <div className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
          <div className="flex items-center gap-3 border-b border-edge px-6 py-5">
            <Table2 size={18} className="text-accent" />
            <h2 className="text-base font-semibold text-fg">Results</h2>
            <span className="ml-2 text-xs font-medium text-muted">Showing up to 200 rows — add a LIMIT clause to change.</span>
          </div>
          {result.columns.length === 0 ? (
            <p className="px-6 py-6 text-sm font-medium text-muted">Statement completed. It returned no result set.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
                  <tr>
                    {result.columns.map((col, index) => (
                      <th key={`${col}-${index}`} className="whitespace-nowrap px-4 py-3 font-semibold">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {result.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="align-top transition-colors hover:bg-surface/60">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className="max-w-md truncate px-4 py-2.5 font-mono text-xs text-fg" title={cell === null ? "NULL" : String(cell)}>
                          {cell === null ? <span className="text-muted italic">NULL</span> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
