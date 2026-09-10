"use client";

// Redis workspace (feature/redis-view): the database module opens this instead of the SQL
// editor when a connection's engine is "redis". Three panes — a logical-database picker and
// key browser on the left, the selected key's value on the right, and a command console below.
// Redis is key/value, so nothing here is SQL; it talks to the /db/connections/{id}/redis/* API.

import {
  ChevronRight,
  CornerDownLeft,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Terminal,
  X
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  getRedisKey,
  getRedisKeyspaces,
  runRedisCommand,
  scanRedisKeys,
  type DbConnection,
  type RedisKeyDetail,
  type RedisKeyEntry,
  type RedisKeyspace
} from "@/lib/api";

function ttlLabel(ttl: number): string {
  if (ttl === -1) return "no expiry";
  if (ttl === -2) return "expired";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.round(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.round(ttl / 3600)}h`;
  return `${Math.round(ttl / 86400)}d`;
}

function sizeLabel(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TYPE_TONE: Record<string, string> = {
  string: "bg-accent/10 text-accent",
  list: "bg-blue-500/10 text-blue-500",
  set: "bg-purple-500/10 text-purple-500",
  zset: "bg-amber-500/10 text-amber-500",
  hash: "bg-emerald-500/10 text-emerald-500",
  stream: "bg-pink-500/10 text-pink-500"
};

function TypeChip({ type }: { type: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${TYPE_TONE[type] ?? "bg-page text-muted"}`}>
      {type}
    </span>
  );
}

/** The reply of a raw command, or a stored value, rendered as readable text. */
function stringify(value: unknown): string {
  if (value == null) return "(nil)";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

/** Type-aware view of one key's value. */
function ValueView({ detail }: { detail: RedisKeyDetail }) {
  const v = detail.value;
  if (detail.type === "string") {
    return <pre className="whitespace-pre-wrap break-words rounded-lg bg-page p-3 font-mono text-xs text-fg">{String(v)}</pre>;
  }
  if (detail.type === "list" || detail.type === "set") {
    const items = Array.isArray(v) ? (v as unknown[]) : [];
    return (
      <div className="overflow-hidden rounded-lg border border-edge">
        <table className="w-full text-xs">
          <tbody>
            {items.map((item, i) => (
              <tr key={i} className="border-b border-edge/60 last:border-0">
                <td className="w-12 px-2 py-1.5 text-right font-mono text-muted">{detail.type === "list" ? i : ""}</td>
                <td className="px-2 py-1.5 font-mono text-fg">{stringify(item)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (detail.type === "zset" || detail.type === "hash") {
    const rows = Array.isArray(v) ? (v as unknown[][]) : [];
    const [c1, c2] = detail.type === "zset" ? ["Member", "Score"] : ["Field", "Value"];
    return (
      <div className="overflow-hidden rounded-lg border border-edge">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-edge bg-page/50">
              <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-muted">{c1}</th>
              <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-muted">{c2}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((pair, i) => (
              <tr key={i} className="border-b border-edge/60 last:border-0">
                <td className="px-2 py-1.5 font-mono text-fg">{stringify(pair?.[0])}</td>
                <td className="px-2 py-1.5 font-mono text-muted">{stringify(pair?.[1])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  // stream and any unknown type: JSON
  return <pre className="whitespace-pre-wrap break-words rounded-lg bg-page p-3 font-mono text-xs text-fg">{stringify(v)}</pre>;
}

type LogLine = { command: string; ok: boolean; text: string };

export function RedisWorkspace({
  token,
  connection,
  onClose
}: {
  token: string;
  connection: DbConnection;
  onClose: () => void;
}) {
  const initialDb = Number.parseInt(connection.database, 10) || 0;
  const [keyspaces, setKeyspaces] = useState<RedisKeyspace[]>([]);
  const [db, setDb] = useState(initialDb);
  const [pattern, setPattern] = useState("*");
  const [patternDraft, setPatternDraft] = useState("*");

  const [keys, setKeys] = useState<RedisKeyEntry[]>([]);
  const [cursor, setCursor] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [command, setCommand] = useState("");
  const [log, setLog] = useState<LogLine[]>([]);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // The workspace container is calc(100vh-4rem), but a page-level banner can sit above it, so
  // relying on h-full leaves the console pinned below the fold. Measure the actual room from the
  // root's top to the viewport bottom and use it as an explicit height, so the console is always
  // reachable regardless of the banner.
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootH, setRootH] = useState<number>();
  useLayoutEffect(() => {
    function measure() {
      const el = rootRef.current;
      if (!el) return;
      setRootH(Math.max(360, window.innerHeight - el.getBoundingClientRect().top));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const loadKeyspaces = useCallback(async () => {
    try {
      setKeyspaces(await getRedisKeyspaces(token, connection.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to read databases");
    }
  }, [token, connection.id]);

  const scan = useCallback(
    async (reset: boolean) => {
      setScanning(true);
      setError("");
      try {
        const res = await scanRedisKeys(token, connection.id, {
          db,
          pattern,
          cursor: reset ? 0 : cursor
        });
        setKeys((prev) => (reset ? res.keys : [...prev, ...res.keys]));
        setCursor(res.cursor);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to scan keys");
      } finally {
        setScanning(false);
      }
    },
    [token, connection.id, db, pattern, cursor]
  );

  // Load databases once, and reset+rescan whenever the db or pattern changes.
  useEffect(() => {
    void loadKeyspaces();
  }, [loadKeyspaces]);

  useEffect(() => {
    setKeys([]);
    setCursor(0);
    setSelectedKey(null);
    setDetail(null);
    void scan(true);
    // scan intentionally omitted: it depends on cursor, which this effect resets
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, pattern, connection.id]);

  const selectKey = useCallback(
    async (key: string) => {
      setSelectedKey(key);
      setDetailLoading(true);
      setDetail(null);
      try {
        setDetail(await getRedisKey(token, connection.id, db, key));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unable to read key");
      } finally {
        setDetailLoading(false);
      }
    },
    [token, connection.id, db]
  );

  async function submitCommand() {
    const text = command.trim();
    if (!text || running) return;
    setRunning(true);
    try {
      const res = await runRedisCommand(token, connection.id, db, text);
      setLog((prev) => [...prev, { command: text, ok: true, text: stringify(res.reply) }]);
      setCommand("");
      // A write may have changed the keyspace or the open key; refresh both cheaply.
      void loadKeyspaces();
      void scan(true);
      if (selectedKey) void selectKey(selectedKey);
    } catch (e) {
      setLog((prev) => [...prev, { command: text, ok: false, text: e instanceof Error ? e.message : "command failed" }]);
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const totalKeys = keyspaces.find((k) => k.db === db)?.keys ?? null;

  return (
    <div ref={rootRef} style={{ height: rootH }} className="flex h-full min-h-0 flex-col bg-elevated">
      {/* header: connection + database picker + pattern filter */}
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2.5">
        <Database size={16} className="text-accent" />
        <span className="text-sm font-semibold text-fg">{connection.name}</span>
        <span className="text-xs text-muted">{connection.host}:{connection.port}</span>

        <label className="ml-2 flex items-center gap-1.5 text-xs text-muted">
          Database
          <select
            value={db}
            onChange={(e) => setDb(Number(e.target.value))}
            className="h-8 rounded-lg border border-edge bg-surface px-2 text-xs text-fg outline-none focus:ring-2 focus:ring-accent/40"
          >
            {keyspaces.map((k) => (
              <option key={k.db} value={k.db}>
                db{k.db} · {k.keys} keys
              </option>
            ))}
            {keyspaces.length === 0 ? <option value={db}>db{db}</option> : null}
          </select>
        </label>

        <div className="flex items-center gap-1.5">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={patternDraft}
              onChange={(e) => setPatternDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setPattern(patternDraft.trim() || "*")}
              placeholder="pattern e.g. user:*"
              className="h-8 w-52 rounded-lg border border-edge bg-surface pl-7 pr-2 text-xs text-fg outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <button
            type="button"
            onClick={() => setPattern(patternDraft.trim() || "*")}
            className="h-8 rounded-lg bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent/80"
          >
            Scan
          </button>
        </div>

        <button
          type="button"
          onClick={() => { void loadKeyspaces(); void scan(true); }}
          title="Refresh"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:text-fg"
        >
          <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title="Close Redis view"
          className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:text-fg"
        >
          <X size={16} />
        </button>
      </div>

      {error ? (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-xs font-medium text-danger">{error}</div>
      ) : null}

      {/* body: keys | value */}
      <div className="flex min-h-0 flex-1">
        {/* key list */}
        <div className="flex w-80 shrink-0 flex-col border-r border-edge">
          <div className="flex items-center justify-between border-b border-edge px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            <span>Keys{totalKeys != null ? ` · ${totalKeys}` : ""}</span>
            <span className="font-mono lowercase">{keys.length} loaded</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {keys.map((k) => (
              <button
                key={k.key}
                type="button"
                onClick={() => selectKey(k.key)}
                className={`flex w-full items-center gap-2 border-b border-edge/50 px-3 py-1.5 text-left last:border-0 hover:bg-surface ${
                  selectedKey === k.key ? "bg-surface" : ""
                }`}
              >
                <TypeChip type={k.type} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{k.key}</span>
                {k.ttl >= 0 ? <span className="shrink-0 font-mono text-[10px] text-muted">{ttlLabel(k.ttl)}</span> : null}
              </button>
            ))}
            {!scanning && keys.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted">No keys match “{pattern}” in db{db}.</div>
            ) : null}
            {cursor !== 0 ? (
              <button
                type="button"
                onClick={() => scan(false)}
                disabled={scanning}
                className="flex w-full items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold text-accent hover:bg-surface disabled:opacity-50"
              >
                {scanning ? <Loader2 size={13} className="animate-spin" /> : <ChevronRight size={13} />}
                Load more
              </button>
            ) : null}
          </div>
        </div>

        {/* value + console */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {detailLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted"><Loader2 size={15} className="animate-spin" /> Loading…</div>
            ) : detail ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-fg">{detail.key}</span>
                  <TypeChip type={detail.type} />
                  <span className="text-xs text-muted">
                    TTL {ttlLabel(detail.ttl)} · {sizeLabel(detail.size_bytes)}
                    {detail.length != null ? ` · ${detail.length} ${detail.type === "string" ? "bytes" : "elements"}` : ""}
                  </span>
                </div>
                {detail.truncated ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-600">
                    Showing the first part of a large value.
                  </div>
                ) : null}
                <ValueView detail={detail} />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-center text-sm text-muted">
                Select a key to view its value, or use the console below.
              </div>
            )}
          </div>

          {/* command console */}
          <div className="flex flex-col border-t border-edge">
            <div className="flex items-center gap-1.5 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <Terminal size={12} /> Command console
            </div>
            <div ref={logRef} className="max-h-48 overflow-auto px-4 font-mono text-xs">
              {log.map((line, i) => (
                <div key={i} className="border-b border-edge/40 py-1 last:border-0">
                  <div className="text-accent">&gt; {line.command}</div>
                  <pre className={`whitespace-pre-wrap break-words ${line.ok ? "text-fg" : "text-danger"}`}>{line.text}</pre>
                </div>
              ))}
              {log.length === 0 ? (
                <div className="py-2 text-muted">Run any Redis command, e.g. <span className="text-fg">GET key</span>, <span className="text-fg">TTL key</span>, <span className="text-fg">HGETALL key</span>. Writes run against db{db}.</div>
              ) : null}
            </div>
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="font-mono text-xs text-muted">db{db} &gt;</span>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitCommand()}
                placeholder="type a command and press Enter"
                spellCheck={false}
                autoComplete="off"
                className="h-9 flex-1 rounded-lg border border-edge bg-surface px-3 font-mono text-xs text-fg outline-none focus:ring-2 focus:ring-accent/40"
              />
              <button
                type="button"
                onClick={submitCommand}
                disabled={running || !command.trim()}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
              >
                {running ? <Loader2 size={13} className="animate-spin" /> : <CornerDownLeft size={13} />}
                Run
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
