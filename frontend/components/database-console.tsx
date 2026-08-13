"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, Loader2, Play, PlugZap, Table2 } from "lucide-react";
import { ApiError, dbQuery, dbTestConnection, type DbConnectionParams, type DbEngine, type DbQueryResult } from "@/lib/api";

// Per-engine default ports; also used to swap the port field when the engine changes and the
// user has not overridden it, so postgres -> mysql moves 5432 to 3306 without a manual edit.
const DEFAULT_PORTS: Record<DbEngine, number> = { postgres: 5432, mysql: 3306 };

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

type StatusNote = { kind: "ok" | "error"; text: string } | null;

export function DatabaseConsole({ token }: { token: string }) {
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

  function changeEngine(next: DbEngine) {
    // only follow the engine's default when the port still equals the *other* engine's default,
    // i.e. the user has not typed a custom port
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
      const res = await dbTestConnection(token, params());
      setConnNote({ kind: res.ok ? "ok" : "error", text: res.message });
    } catch (error) {
      setConnNote({ kind: "error", text: error instanceof Error ? error.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sql.trim()) {
      setQueryError("Enter a SQL statement to run.");
      return;
    }
    setRunning(true);
    setQueryError("");
    setResult(null);
    try {
      const res = await dbQuery(token, { ...params(), sql });
      setResult(res);
    } catch (error) {
      // A bad query or unreachable host comes back as an ApiError (HTTP 400) carrying the DB
      // error text; anything else is surfaced with its message too.
      setQueryError(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Query failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6 px-6 py-6">
      {/* Connection card */}
      <div className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge px-6 py-5">
          <PlugZap size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-fg">Connection</h2>
        </div>
        <div className="grid gap-4 p-6 md:grid-cols-3">
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
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className={inputClass}
            />
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
          <div className="flex items-end md:col-span-3">
            <button
              type="button"
              onClick={() => void test()}
              disabled={testing || !host.trim()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              {testing ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
              Test connection
            </button>
          </div>
          {connNote && (
            <div
              className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium md:col-span-3 ${
                connNote.kind === "ok"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-danger/10 text-danger dark:text-red-300"
              }`}
            >
              {connNote.kind === "ok" ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              )}
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
              disabled={running || !host.trim()}
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
          </div>
          {result.columns.length === 0 ? (
            <p className="px-6 py-6 text-sm font-medium text-muted">
              Statement completed. It returned no result set.
            </p>
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
