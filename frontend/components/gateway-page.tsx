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

import { AlertTriangle, ArrowLeft, Check, Copy, Loader2, Plus, Server, ShieldAlert, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { AutoRefreshSelect, useAutoRefresh } from "@/components/auto-refresh";
import {
  GATEWAY_RANGES,
  createGateway,
  getGatewayEndpoints,
  getGatewayEvents,
  getGatewaySources,
  listGateways,
  type GatewayEndpoint,
  type GatewayEndpointSort,
  type GatewayEvent,
  type GatewayRange,
  type GatewaySource,
  type GatewaySourceSort,
  type GatewaySummary,
  type Me,
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

/** Value with a copy-to-clipboard button, for the ingest URL and the one-time token. */
function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied (insecure origin, permission). The value is on screen to
      // select by hand, so a failed copy is not worth surfacing as an error.
    }
  }
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className={`flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-page px-3 py-2 text-xs text-fg ${mono ? "font-mono" : ""}`}>
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge text-muted transition-colors hover:text-fg"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check size={14} className="text-accent" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

/**
 * Admin-only: register a gateway and read back its ingest token. The token is returned
 * exactly once by the API (it is what Kong presents on every ingest call), so this is the
 * only place an operator can capture it — hence it is shown here in full, with the Kong
 * http-log endpoint pre-filled, rather than being hidden behind a reveal.
 */
function ManageGatewaysDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState("");
  const [creating, setCreating] = useState(false);
  // The freshly minted token, surfaced once. Null until a gateway is created this session.
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);

  // window is undefined during static export, so the ingest URL is resolved in the browser.
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const ingestUrl = `${origin}/api/gateway/ingest`;

  const reload = useCallback(async () => {
    setError("");
    try {
      setGateways(await listGateways(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load gateways");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function register() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError("");
    try {
      const result = await createGateway(token, trimmed, environment.trim());
      setCreated({ name: result.name, token: result.token });
      setName("");
      setEnvironment("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to register gateway");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-xl">
        <div className="flex items-center gap-2 border-b border-edge px-5 py-4">
          <Server size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-fg">Gateways</h2>
          <span className="text-xs text-muted">register a gateway to get its ingest token</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:text-fg"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {error ? (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-medium text-danger">
              <AlertTriangle size={15} />
              {error}
            </div>
          ) : null}

          {created ? (
            <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-4">
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-fg">
                <Check size={15} className="text-accent" />
                {created.name} registered
              </div>
              <p className="mb-3 text-xs text-muted">
                This token is shown once and cannot be recovered. Point Kong&apos;s stock http-log
                plugin at the endpoint below, sending the token as the{" "}
                <span className="font-mono">X-Gateway-Token</span> header.
              </p>
              <div className="flex flex-col gap-3">
                <CopyField label="Ingest token" value={created.token} />
                <CopyField label="Endpoint (config.http_endpoint)" value={ingestUrl} />
                <CopyField label="Header (config.headers)" value={`X-Gateway-Token: ${created.token}`} />
              </div>
            </div>
          ) : null}

          <div className="mb-5 rounded-xl border border-edge bg-page/40 p-4">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted">Register a gateway</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[10rem]">
                <span className="mb-1 block text-xs text-muted">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && register()}
                  placeholder="vapt-kong"
                  autoFocus
                  className="h-10 w-full rounded-xl border border-edge bg-surface px-3 text-sm text-fg outline-none transition-colors focus:ring-2 focus:ring-accent/40"
                />
              </label>
              <label className="flex-1 min-w-[10rem]">
                <span className="mb-1 block text-xs text-muted">Environment</span>
                <input
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && register()}
                  placeholder="vapt"
                  className="h-10 w-full rounded-xl border border-edge bg-surface px-3 text-sm text-fg outline-none transition-colors focus:ring-2 focus:ring-accent/40"
                />
              </label>
              <button
                type="button"
                onClick={register}
                disabled={!name.trim() || creating}
                className="flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Register
              </button>
            </div>
          </div>

          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Registered</div>
          <div className="mt-2 overflow-hidden rounded-xl border border-edge">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-edge bg-page/40">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Name</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Environment</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">State</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">Last event</th>
                </tr>
              </thead>
              <tbody>
                {gateways.map((g) => (
                  <tr key={g.id} className="border-b border-edge/60 last:border-0">
                    <td className="px-3 py-2 font-mono text-fg">{g.name}</td>
                    <td className="px-3 py-2 text-muted">{g.environment || "—"}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${g.enabled ? "bg-accent/10 text-accent" : "bg-page text-muted"}`}>
                        {g.enabled ? "enabled" : "disabled"}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-muted">{g.last_event_at ? ago(g.last_event_at) : "never"}</td>
                  </tr>
                ))}
                {!loading && gateways.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted">
                      No gateways registered yet.
                    </td>
                  </tr>
                ) : null}
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted">
                      <Loader2 size={14} className="mr-1 inline animate-spin" /> Loading…
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GatewayPage({ token, me }: { token: string; me: Me }) {
  const isAdmin = me.role === "admin";
  const [manageOpen, setManageOpen] = useState(false);
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
          {isAdmin ? (
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="flex h-8 items-center gap-1.5 rounded-full border border-edge bg-surface px-3 text-xs font-medium text-muted transition-colors hover:text-fg"
            >
              <Server size={14} />
              Manage gateways
            </button>
          ) : null}
          <RangePicker value={range} onChange={setRange} />
          <AutoRefreshSelect value={refreshSeconds} onChange={setRefreshSeconds} />
        </div>
      </div>

      {manageOpen ? <ManageGatewaysDialog token={token} onClose={() => setManageOpen(false)} /> : null}

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
                      No gateway traffic in the last {range}.{" "}
                      {isAdmin ? (
                        <>
                          If a gateway has never reached this page, use{" "}
                          <button
                            type="button"
                            onClick={() => setManageOpen(true)}
                            className="font-medium text-accent hover:underline"
                          >
                            Manage gateways
                          </button>{" "}
                          to register one, then point Kong&apos;s http-log plugin at{" "}
                          <span className="font-mono">/api/gateway/ingest</span>.
                        </>
                      ) : (
                        <>Ask an administrator to register a gateway and point Kong&apos;s http-log
                        plugin at <span className="font-mono">/api/gateway/ingest</span>.</>
                      )}
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
