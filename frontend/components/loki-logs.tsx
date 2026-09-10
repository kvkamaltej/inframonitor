"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Loader2, Maximize2, Minimize2, Play, Plus, ScrollText, X } from "lucide-react";
import { lokiLabelValues, lokiLabels, lokiQueryRange, type LokiStream } from "@/lib/api";
import { buildLogqlSelector, type SelectorRow } from "@/lib/monitoring-queries";

// A single flattened log line. `identity` is the most specific container/source label chosen for
// display (see identityOf); `server` is a coarser host label shown as a secondary chip when it
// differs from the identity.
type LogRow = { ns: string; line: string; stderr: boolean; labels: Record<string, string> };

// Relative-window presets. Kept local to this component (the monitoring page defines its own set).
const RELATIVE_PRESETS: { key: string; label: string; seconds: number }[] = [
  { key: "5m", label: "5m", seconds: 5 * 60 },
  { key: "15m", label: "15m", seconds: 15 * 60 },
  { key: "1h", label: "1h", seconds: 60 * 60 },
  { key: "6h", label: "6h", seconds: 6 * 60 * 60 },
  { key: "24h", label: "24h", seconds: 24 * 60 * 60 }
];

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Lines Loki returns per query. A wide window over a busy stream has far more than this, so the
// viewer pages backward ("Load older") and Export walks every page rather than stopping at the cap.
const PAGE_LIMIT = 2000;
// A hard ceiling on a full-range export so a runaway query cannot try to pull an unbounded stream
// into the browser. Reaching it exports what was gathered and says so.
const EXPORT_MAX_LINES = 200_000;

// nanosecond epoch string -> HH:MM:SS. Slicing off the last 6 digits yields milliseconds without
// losing precision to a float.
function nsToClock(ns: string): string {
  const ms = Number(ns.slice(0, -6));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// The most specific identity available for a stream: which container/service the line belongs to.
function identityOf(labels: Record<string, string>): string {
  return labels.container || labels.source || labels.service || labels.pod || labels.job || "";
}

// Flatten Loki streams into individual lines and sort newest-first. Nanosecond strings are
// compared as BigInt for correctness, falling back to a string compare if they are not numeric.
function flattenStreams(streams: LokiStream[]): LogRow[] {
  const rows: LogRow[] = [];
  for (const stream of streams) {
    const labels = stream.stream ?? {};
    const stderr = labels.stream === "stderr";
    for (const [ns, line] of stream.values ?? []) {
      rows.push({ ns, line, stderr, labels });
    }
  }
  rows.sort((a, b) => {
    try {
      const diff = BigInt(b.ns) - BigInt(a.ns);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    } catch {
      return b.ns.localeCompare(a.ns);
    }
  });
  return rows;
}

// Trigger a client-side download of a plain-text file from an in-memory string.
function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function LokiLogViewer({
  token,
  pinnedSelector,
  title
}: {
  token: string;
  // a raw label matcher WITHOUT braces, e.g. `server_id="abc-123"`. Always prepended to the built
  // selector and shown as a locked, non-removable chip.
  pinnedSelector?: string;
  title?: string;
}) {
  const heading = title || "Logs";

  const [selectors, setSelectors] = useState<SelectorRow[]>([{ label: "", value: "" }]);
  const [lineFilter, setLineFilter] = useState("");
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ran, setRan] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Pagination: one query returns at most PAGE_LIMIT newest lines, so a wide window over a busy
  // stream would otherwise stop at "today" and never reach older days. queryCtx remembers the
  // active query + its window start so "Load older" can page backward from the oldest loaded row.
  const [queryCtx, setQueryCtx] = useState<{ logql: string; startSec: number; endSec: number } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Time-window mode: relative presets or an explicit absolute From/To window.
  const [rangeMode, setRangeMode] = useState<"relative" | "absolute">("relative");
  const [relSeconds, setRelSeconds] = useState<number>(RELATIVE_PRESETS[2].seconds); // default 1h
  const [absFrom, setAbsFrom] = useState("");
  const [absTo, setAbsTo] = useState("");

  // Available label names (loaded once) and a cache of values per label name for the value pickers.
  const [labelNames, setLabelNames] = useState<string[]>([]);
  const [valueCache, setValueCache] = useState<Record<string, string[]>>({});

  // Load the available label names once. The picker is a convenience; a failure just leaves the
  // dropdown empty and the user can still free-type values.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await lokiLabels(token);
        if (!cancelled) setLabelNames(resp.data ?? []);
      } catch {
        // ignore — free-typed selectors still work
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Fetch (and cache) the values for a label name, for its value dropdown.
  const loadValues = useCallback(
    async (label: string) => {
      if (!label || valueCache[label]) return;
      try {
        const resp = await lokiLabelValues(token, label);
        setValueCache((prev) => ({ ...prev, [label]: resp.data ?? [] }));
      } catch {
        setValueCache((prev) => ({ ...prev, [label]: [] }));
      }
    },
    [token, valueCache]
  );

  function setSelectorLabel(index: number, label: string) {
    setSelectors((prev) => prev.map((row, i) => (i === index ? { ...row, label } : row)));
    void loadValues(label);
  }

  function setSelectorValue(index: number, value: string) {
    setSelectors((prev) => prev.map((row, i) => (i === index ? { ...row, value } : row)));
  }

  function addSelector() {
    setSelectors((prev) => [...prev, { label: "", value: "" }]);
  }

  function removeSelector(index: number) {
    setSelectors((prev) => prev.filter((_, i) => i !== index));
  }

  // Build the effective LogQL from the pinned selector + non-empty rows + line filter.
  // Thin wrapper over the shared builder in the query catalog; behavior is unchanged.
  const buildLogql = () => buildLogqlSelector(selectors, pinnedSelector, lineFilter);

  const run = useCallback(
    async (overrideLogql?: string) => {
      let logql: string;
      if (overrideLogql) {
        logql = overrideLogql;
      } else {
        const built = buildLogql();
        if ("error" in built) {
          setError(
            built.error === "incomplete"
              ? "Fill in both label and value for each selector"
              : "Add at least one selector"
          );
          return;
        }
        logql = built.logql;
      }
      let start: number, end: number;
      if (rangeMode === "absolute") {
        if (!absFrom || !absTo) {
          setError("Pick both From and To dates.");
          return;
        }
        start = Math.floor(new Date(absFrom).getTime() / 1000);
        end = Math.floor(new Date(absTo).getTime() / 1000);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
          setError("From must be before To.");
          return;
        }
      } else {
        end = nowSec();
        start = end - relSeconds;
      }
      setLoading(true);
      setError("");
      setRan(true);
      try {
        const resp = await lokiQueryRange(token, logql, start, end, { limit: PAGE_LIMIT, direction: "backward" });
        const streams = resp?.data?.result ?? [];
        const page = flattenStreams(streams);
        setRows(page);
        // A full page means Loki likely had more to give before the window start -> allow paging back.
        setQueryCtx({ logql, startSec: start, endSec: end });
        setHasMore(page.length >= PAGE_LIMIT);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Query failed");
        setRows([]);
        setHasMore(false);
        setQueryCtx(null);
      } finally {
        setLoading(false);
      }
    },
    // buildLogql reads selectors/lineFilter/pinnedSelector from state, all captured here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, selectors, lineFilter, pinnedSelector, rangeMode, relSeconds, absFrom, absTo]
  );

  // Fetch the next older page and append it. Anchors on the oldest loaded row's exact nanosecond
  // (Loki's `end` is exclusive) so pages join with no overlap or gap, letting the operator walk the
  // whole history back to the window start rather than being capped at the newest PAGE_LIMIT lines.
  const loadOlder = useCallback(async () => {
    if (!queryCtx || rows.length === 0 || loadingMore) return;
    const oldestNs = rows[rows.length - 1].ns;
    setLoadingMore(true);
    setError("");
    try {
      const resp = await lokiQueryRange(token, queryCtx.logql, queryCtx.startSec, 0, {
        limit: PAGE_LIMIT,
        direction: "backward",
        endNs: oldestNs
      });
      const page = flattenStreams(resp?.data?.result ?? []);
      // Dedupe on ns+line in case an identical entry sits exactly on the boundary.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => `${r.ns} ${r.line}`));
        const fresh = page.filter((r) => !seen.has(`${r.ns} ${r.line}`));
        return [...prev, ...fresh];
      });
      setHasMore(page.length >= PAGE_LIMIT);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
    } finally {
      setLoadingMore(false);
    }
  }, [token, queryCtx, rows, loadingMore]);

  // When pinned to a selector, auto-run once on mount and re-run whenever the pin changes.
  useEffect(() => {
    if (pinnedSelector && pinnedSelector.trim()) {
      const filter = lineFilter.trim();
      void run(`{${pinnedSelector.trim()}}${filter ? ` ${filter}` : ""}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedSelector]);

  // While the fullscreen overlay is open, allow Escape to exit it and lock scrolling of the page
  // behind it. Cleanup restores both when it closes.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [fullscreen]);

  // Export the WHOLE window, oldest-first -- not just what is on screen. A single query is capped at
  // PAGE_LIMIT, so this pages backward from the window end to its start (each page anchored on the
  // previous page's oldest nanosecond, Loki's `end` being exclusive) and concatenates every line, up
  // to a safety ceiling. This is why the file can hold far more than the loaded rows.
  const exportLogs = useCallback(async () => {
    if (!queryCtx || exporting) return;
    setExporting(true);
    setError("");
    try {
      const all: LogRow[] = [];
      const seen = new Set<string>();
      let endNs: string | undefined;
      // Guard against a pathological stream that never returns a short page.
      for (let pages = 0; pages < Math.ceil(EXPORT_MAX_LINES / PAGE_LIMIT) + 1; pages++) {
        const resp = await lokiQueryRange(token, queryCtx.logql, queryCtx.startSec, queryCtx.endSec, {
          limit: PAGE_LIMIT,
          direction: "backward",
          endNs
        });
        const page = flattenStreams(resp?.data?.result ?? []);
        let added = 0;
        for (const r of page) {
          const key = `${r.ns} ${r.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(r);
          added++;
        }
        if (page.length < PAGE_LIMIT || all.length >= EXPORT_MAX_LINES || added === 0) break;
        endNs = page[page.length - 1].ns; // page backward from this page's oldest line
      }
      if (all.length === 0) return;
      // `all` is newest-first across pages; reverse for a chronological file.
      const text = [...all]
        .reverse()
        .map((row) => {
          const iso = new Date(Number(row.ns.slice(0, -6))).toISOString();
          return `${iso}\t[${identityOf(row.labels)}]\t${row.line}`;
        })
        .join("\n");
      const note = all.length >= EXPORT_MAX_LINES ? `\n# truncated at ${EXPORT_MAX_LINES} lines` : "";
      downloadTextFile(`loki-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.log`, text + note);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [token, queryCtx, exporting]);

  // --- controls (query builder + time window) ----------------------------------------------
  const controls = (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      {/* Selector builder */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Selectors</span>

        {pinnedSelector && pinnedSelector.trim() ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 font-mono text-xs text-accent">
              <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                pinned
              </span>
              {pinnedSelector.trim()}
            </span>
          </div>
        ) : null}

        {selectors.map((row, index) => {
          const values = valueCache[row.label] ?? [];
          return (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <select
                value={row.label}
                onChange={(e) => setSelectorLabel(index, e.target.value)}
                className="h-9 min-w-[150px] rounded-lg border border-edge bg-page px-2 text-sm text-fg outline-none focus:border-accent"
              >
                <option value="">Label…</option>
                {labelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {/* keep a selected label visible even if it's not in the fetched list */}
                {row.label && !labelNames.includes(row.label) ? (
                  <option value={row.label}>{row.label}</option>
                ) : null}
              </select>
              <span className="select-none text-sm text-muted">=</span>
              <input
                value={row.value}
                onChange={(e) => setSelectorValue(index, e.target.value)}
                list={`loki-values-${index}`}
                disabled={!row.label}
                placeholder="value"
                spellCheck={false}
                className="h-9 min-w-[160px] flex-1 rounded-lg border border-edge bg-page px-2 font-mono text-sm text-fg outline-none focus:border-accent disabled:opacity-50"
              />
              <datalist id={`loki-values-${index}`}>
                {values.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <button
                onClick={() => removeSelector(index)}
                title="Remove selector"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-edge text-muted transition-colors hover:bg-elevated hover:text-fg"
              >
                <X size={15} />
              </button>
            </div>
          );
        })}

        <div>
          <button
            onClick={addSelector}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge px-3 text-xs font-medium text-fg transition-colors hover:bg-elevated"
          >
            <Plus size={14} /> Add selector
          </button>
        </div>
      </div>

      {/* Line filter */}
      <label className="mt-3 flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Line filter (optional)</span>
        <input
          value={lineFilter}
          onChange={(e) => setLineFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
          }}
          placeholder='|= "error"'
          spellCheck={false}
          className="h-9 rounded-lg border border-edge bg-page px-3 font-mono text-sm text-fg outline-none focus:border-accent"
        />
      </label>

      {/* Time window + run/export actions */}
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Time window</span>
          <div className="flex items-center gap-1 rounded-full border border-edge p-1">
            {(["relative", "absolute"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setRangeMode(mode)}
                className={`h-7 rounded-full px-3 text-xs font-semibold capitalize transition-colors ${
                  rangeMode === mode ? "bg-accent text-white" : "text-muted hover:text-fg"
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {rangeMode === "relative" ? (
          <div className="flex items-center gap-1 rounded-full border border-edge p-1">
            {RELATIVE_PRESETS.map((preset) => (
              <button
                key={preset.key}
                onClick={() => setRelSeconds(preset.seconds)}
                className={`h-7 rounded-full px-3 text-xs font-semibold transition-colors ${
                  relSeconds === preset.seconds ? "bg-accent text-white" : "text-muted hover:text-fg"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">From</span>
              <input
                type="datetime-local"
                value={absFrom}
                onChange={(e) => setAbsFrom(e.target.value)}
                className="h-9 rounded-lg border border-edge bg-page px-2 text-sm text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">To</span>
              <input
                type="datetime-local"
                value={absTo}
                onChange={(e) => setAbsTo(e.target.value)}
                className="h-9 rounded-lg border border-edge bg-page px-2 text-sm text-fg outline-none focus:border-accent"
              />
            </label>
          </>
        )}

        <button
          onClick={() => void run()}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} Run
        </button>
        <button
          onClick={exportLogs}
          disabled={!queryCtx || exporting}
          title="Export the whole window (pages through the full range, not just the loaded lines)"
          className="inline-flex h-9 items-center gap-2 rounded-full border border-edge px-4 text-sm font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50"
        >
          {exporting ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} {exporting ? "Exporting…" : "Export"}
        </button>
      </div>
    </div>
  );

  // --- results pane -------------------------------------------------------------------------
  const results = (
    <div className="rounded-2xl border border-edge bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <ScrollText size={14} /> {heading} {rows.length > 0 ? `(${rows.length}${hasMore ? "+, load older for more" : ""})` : ""}
      </div>
      <div
        className={`overflow-auto p-2 font-mono text-xs leading-relaxed ${
          fullscreen ? "max-h-[calc(100vh-13rem)]" : "max-h-[480px]"
        }`}
      >
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-6 text-muted">
            <Loader2 size={14} className="animate-spin" /> Running query…
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 px-2 py-6 font-sans text-sm font-medium text-danger">
            <AlertTriangle size={15} /> {error}
          </div>
        ) : !ran ? (
          <div className="px-2 py-6 font-sans text-sm text-muted">Run a query to see log lines.</div>
        ) : rows.length === 0 ? (
          <div className="px-2 py-6 font-sans text-sm text-muted">No log lines for this selector and range.</div>
        ) : (
          rows.map((row, index) => {
            const identity = identityOf(row.labels);
            const server = row.labels.server;
            const showServer = Boolean(server && server !== identity);
            return (
              <div
                key={`${row.ns}-${index}`}
                className={`flex gap-3 whitespace-pre-wrap break-all rounded px-2 py-0.5 ${
                  row.stderr ? "text-red-600 dark:text-red-400" : "text-fg"
                }`}
              >
                <span className="shrink-0 select-none text-muted">{nsToClock(row.ns)}</span>
                {identity ? (
                  <span className="shrink-0 select-none rounded bg-elevated px-1.5 text-[11px] text-muted">
                    {identity}
                  </span>
                ) : null}
                {showServer ? (
                  <span className="shrink-0 select-none rounded bg-elevated px-1.5 text-[11px] text-muted/60">
                    {server}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1">{row.line}</span>
              </div>
            );
          })
        )}
        {ran && !loading && !error && hasMore ? (
          <div className="flex justify-center py-2">
            <button
              onClick={loadOlder}
              disabled={loadingMore}
              className="inline-flex h-8 items-center gap-2 rounded-full border border-edge px-4 font-sans text-xs font-semibold text-fg transition-colors hover:bg-elevated disabled:opacity-50"
            >
              {loadingMore ? <Loader2 size={14} className="animate-spin" /> : null}
              {loadingMore ? "Loading…" : "Load older entries"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );

  const fullscreenToggle = (
    <button
      onClick={() => setFullscreen((v) => !v)}
      className="inline-flex h-9 items-center gap-2 rounded-full border border-edge px-4 text-sm font-medium text-fg transition-colors hover:bg-elevated"
    >
      {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      {fullscreen ? "Exit fullscreen" : "Fullscreen"}
    </button>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[100] flex flex-col gap-4 overflow-auto bg-page p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
            <ScrollText size={18} /> {heading}
          </h2>
          {fullscreenToggle}
        </div>
        {controls}
        {results}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-fg">
          <ScrollText size={16} /> {heading}
          {rows.length > 0 ? <span className="text-sm font-normal text-muted">({rows.length})</span> : null}
        </h2>
        {fullscreenToggle}
      </div>
      {controls}
      {results}
    </div>
  );
}
