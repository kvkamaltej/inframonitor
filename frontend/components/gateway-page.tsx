"use client";

// Gateway Traffic: which addresses are calling the API gateway, and what any one
// of them called.
//
// Deliberately two screens rather than one dense table. The question an operator
// arrives with is "who is hammering us", and only once they have an answer does
// "what were they hitting" matter. Showing both at once buries the first.
//
// Sorting is a server round trip, not a client-side array sort: the tables show a
// window that can hold hundreds of thousands of requests, so ordering the rows
// already fetched would answer a different question from the one the column
// header implies.

import { AlertTriangle, ArrowLeft, Loader2, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AutoRefreshSelect, useAutoRefresh } from "@/components/auto-refresh";
import {
  GATEWAY_RANGES,
  getGatewayEndpoints,
  getGatewayEvents,
  getGatewaySources,
  type GatewayEndpoint,
  type GatewayEndpointSort,
  type GatewayEvent,
  type GatewayRange,
  type GatewaySource,
  type GatewaySourceSort,
  type SortDir
} from "@/lib/api";

function fmt(n: number): string {
  return n.toLocaleString();
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** A column header that sorts. Shows direction only on the active column. */
function Th({
  label,
  column,
  sort,
  dir,
  onSort,
  numeric = false
}: {
  label: string;
  column: string;
  sort: string;
  dir: SortDir;
  onSort: (column: string) => void;
  numeric?: boolean;
}) {
  const active = sort === column;
  return (
    <th
      scope="col"
      onClick={() => onSort(column)}
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2 text-[11px] font-semibold uppercase tracking-wide ${
        numeric ? "text-right" : "text-left"
      } ${active ? "text-fg" : "text-muted"} hover:text-fg`}
    >
      {label}
      <span className={`ml-1 text-[9px] ${active ? "text-accent" : "opacity-30"}`}>
        {active ? (dir === "desc" ? "▼" : "▲") : "▲▼"}
      </span>
    </th>
  );
}

function TierChip({ tier }: { tier: string }) {
  if (!tier) return <span className="text-muted">—</span>;
  return (
    <span className="rounded-full bg-page px-2 py-0.5 text-[11px] font-semibold text-muted">{tier}</span>
  );
}

function StatusChip({ status }: { status: number }) {
  const throttled = status === 429;
  const bad = status >= 500 || status === 403;
  const tone = throttled
    ? "bg-danger/10 text-danger"
    : bad
      ? "bg-warn/10 text-warn"
      : "bg-accent/10 text-accent";
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{status}</span>;
}

/** Share of a source's traffic that was rejected, as a bar. */
function ShareBar({ share }: { share: number }) {
  const pct = Math.round(share * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-page">
        <div
          className={pct > 0 ? "h-full bg-danger" : "h-full bg-accent"}
          style={{ width: `${Math.max(pct, pct > 0 ? 4 : 0)}%` }}
        />
      </div>
      <span className="tabular-nums text-muted">{pct}%</span>
    </div>
  );
}

function RangePicker({
  value,
  onChange
}: {
  value: GatewayRange;
  onChange: (r: GatewayRange) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-edge bg-surface p-1">
      {GATEWAY_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={`rounded-full px-3 py-1 font-mono text-xs ${
            r === value ? "bg-accent font-semibold text-white" : "text-muted hover:text-fg"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export function GatewayPage({ token }: { token: string }) {
  const [range, setRange] = useState<GatewayRange>("5m");
  const [refreshSeconds, setRefreshSeconds] = useState(30);

  const [sources, setSources] = useState<GatewaySource[]>([]);
  const [sourceSort, setSourceSort] = useState<GatewaySourceSort>("throttled");
  const [sourceDir, setSourceDir] = useState<SortDir>("desc");

  const [selected, setSelected] = useState<string | null>(null);
  const [endpoints, setEndpoints] = useState<GatewayEndpoint[]>([]);
  const [endpointSort, setEndpointSort] = useState<GatewayEndpointSort>("hits");
  const [endpointDir, setEndpointDir] = useState<SortDir>("desc");
  const [events, setEvents] = useState<GatewayEvent[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadSources = useCallback(async () => {
    const rows = await getGatewaySources(token, range, sourceSort, sourceDir);
    setSources(rows);
  }, [token, range, sourceSort, sourceDir]);

  const loadDetail = useCallback(async () => {
    if (!selected) return;
    const [rows, stream] = await Promise.all([
      getGatewayEndpoints(token, selected, range, endpointSort, endpointDir),
      getGatewayEvents(token, selected, range, { limit: 100 })
    ]);
    setEndpoints(rows);
    setEvents(stream);
  }, [token, selected, range, endpointSort, endpointDir]);

  const load = useCallback(async () => {
    setError("");
    try {
      await Promise.all([loadSources(), loadDetail()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load gateway traffic");
    } finally {
      setLoading(false);
    }
  }, [loadSources, loadDetail]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await load();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  useAutoRefresh(refreshSeconds, () => {
    void load();
  });

  function sortSourcesBy(column: string) {
    const next = column as GatewaySourceSort;
    if (next === sourceSort) setSourceDir(sourceDir === "desc" ? "asc" : "desc");
    else {
      setSourceSort(next);
      setSourceDir("desc");
    }
  }

  function sortEndpointsBy(column: string) {
    const next = column as GatewayEndpointSort;
    if (next === endpointSort) setEndpointDir(endpointDir === "desc" ? "asc" : "desc");
    else {
      setEndpointSort(next);
      setEndpointDir("desc");
    }
  }

  const totals = sources.reduce(
    (acc, s) => ({ requests: acc.requests + s.requests, throttled: acc.throttled + s.throttled }),
    { requests: 0, throttled: 0 }
  );
  const detail = sources.find((s) => s.client_ip === selected);

  return (
    <div className="px-6 py-6">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {selected ? (
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
          >
            <ArrowLeft size={15} />
            All addresses
          </button>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted">
            <ShieldAlert size={16} className="text-accent" />
            {fmt(totals.requests)} requests, {fmt(totals.throttled)} throttled in the last {range}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <RangePicker value={range} onChange={setRange} />
          <AutoRefreshSelect value={refreshSeconds} onChange={setRefreshSeconds} />
        </div>
      </div>

      {error ? (
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
          <AlertTriangle size={16} />
          {error}
        </div>
      ) : null}

      {loading && sources.length === 0 ? (
        <div className="flex items-center gap-2 px-6 py-10 text-sm font-medium text-muted">
          <Loader2 size={16} className="animate-spin" />
          Loading gateway traffic…
        </div>
      ) : null}

      {!selected ? (
        <div className="overflow-hidden rounded-2xl border border-edge bg-surface">
          <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">Addresses</h2>
            <span className="ml-auto text-xs text-muted">
              {sources.length} active · click a row for its endpoints
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-edge">
                  <Th label="Address" column="client_ip" sort={sourceSort} dir={sourceDir} onSort={() => undefined} />
                  <Th label="Requests" column="requests" sort={sourceSort} dir={sourceDir} onSort={sortSourcesBy} numeric />
                  <Th label="Throttled" column="throttled" sort={sourceSort} dir={sourceDir} onSort={sortSourcesBy} numeric />
                  <Th label="Rate" column="rate_per_min" sort={sourceSort} dir={sourceDir} onSort={sortSourcesBy} numeric />
                  <Th label="Share" column="throttled_share" sort={sourceSort} dir={sourceDir} onSort={sortSourcesBy} />
                  <Th label="Endpoints" column="endpoints" sort={sourceSort} dir={sourceDir} onSort={sortSourcesBy} numeric />
                  <Th label="Last seen" column="last_seen" sort={sourceSort} dir={sourceDir} onSort={sortSourcesBy} />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr
                    key={s.client_ip}
                    onClick={() => setSelected(s.client_ip)}
                    className="cursor-pointer border-b border-edge/60 last:border-0 hover:bg-page"
                  >
                    <td className="px-3 py-2.5 font-mono">{s.client_ip}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{fmt(s.requests)}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {s.throttled > 0 ? (
                        <span className="font-semibold text-danger">{fmt(s.throttled)}</span>
                      ) : (
                        <span className="text-muted">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{s.rate_per_min}/min</td>
                    <td className="px-3 py-2.5">
                      <ShareBar share={s.throttled_share} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{s.endpoints}</td>
                    <td className="px-3 py-2.5 font-mono text-muted">{ago(s.last_seen)}</td>
                  </tr>
                ))}
                {!loading && sources.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-muted">
                      No gateway traffic in the last {range}. If a gateway has never reached this
                      page, register one under Administration and point Kong&apos;s http-log plugin
                      at <span className="font-mono">/api/gateway/ingest</span>.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-lg font-semibold text-fg">{selected}</span>
            {detail ? (
              <span className="text-sm text-muted">
                {fmt(detail.requests)} requests · {fmt(detail.throttled)} throttled ·{" "}
                {detail.rate_per_min}/min · last seen {ago(detail.last_seen)}
              </span>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-2xl border border-edge bg-surface">
            <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
              <h2 className="text-sm font-semibold text-fg">Endpoints called by this address</h2>
              <span className="ml-auto text-xs text-muted">
                last {range} · {endpoints.length} endpoints
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-edge">
                    <Th label="Endpoint" column="path" sort={endpointSort} dir={endpointDir} onSort={sortEndpointsBy} />
                    <Th label="Tier" column="tier" sort={endpointSort} dir={endpointDir} onSort={() => undefined} />
                    <Th label="Limit" column="limit" sort={endpointSort} dir={endpointDir} onSort={() => undefined} numeric />
                    <Th label="Hits" column="hits" sort={endpointSort} dir={endpointDir} onSort={sortEndpointsBy} numeric />
                    <Th label="Allowed" column="allowed" sort={endpointSort} dir={endpointDir} onSort={sortEndpointsBy} numeric />
                    <Th label="Throttled" column="throttled" sort={endpointSort} dir={endpointDir} onSort={sortEndpointsBy} numeric />
                    <Th label="Last hit" column="last_hit" sort={endpointSort} dir={endpointDir} onSort={sortEndpointsBy} />
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((e) => (
                    <tr key={e.path} className="border-b border-edge/60 last:border-0">
                      <td className="px-3 py-2.5 font-mono">{e.path}</td>
                      <td className="px-3 py-2.5">
                        <TierChip tier={e.tier} />
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted">
                        {e.limit_rule || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold">{fmt(e.hits)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted">{fmt(e.allowed)}</td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                        {e.throttled > 0 ? (
                          <span className="font-semibold text-danger">{fmt(e.throttled)}</span>
                        ) : (
                          <span className="text-muted">0</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-muted">{timeOf(e.last_hit)}</td>
                    </tr>
                  ))}
                  {endpoints.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">
                        Nothing from this address in the last {range}.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-edge bg-surface">
            <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
              <h2 className="text-sm font-semibold text-fg">Requests</h2>
              <span className="ml-auto text-xs text-muted">newest first · up to 100</span>
            </div>
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-edge">
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Time</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Method</th>
                    <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Endpoint</th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted">Status</th>
                    <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-muted">Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e, i) => (
                    <tr key={`${e.ts}-${i}`} className="border-b border-edge/60 last:border-0">
                      <td className="px-3 py-2 font-mono tabular-nums text-muted">{timeOf(e.ts)}</td>
                      <td className="px-3 py-2 font-mono">{e.method}</td>
                      <td className="px-3 py-2 font-mono">{e.path}</td>
                      <td className="px-3 py-2 text-right">
                        <StatusChip status={e.status} />
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-muted">{e.latency_ms} ms</td>
                    </tr>
                  ))}
                  {events.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                        No individual requests retained for this window.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
