"use client";

// Admin dialog opened from the /gateway ⋮ menu → "Configured routes". Lists a gateway's configured
// routes with their rate limits and how many live counter keys each has right now, and lets an admin
// RESET (clear) the live rate-limit counter for selected routes — deleting `ratelimit:<route_id>:*`
// in Kong's Redis so throttled clients can hit those routes again immediately.
//
// Credential-free by design: the route list comes from a managed snapshot the server already holds
// (seeded out-of-band from Kong), so the operator never has to supply Kong Admin API credentials to
// see or reset routes. The optional "Control channel" panel only sets the rate-limit Redis (for the
// resets + live counts) and, if ever wanted, a live Admin API source instead of the snapshot.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, PlugZap, RefreshCw, RotateCcw, Save, Settings, X } from "lucide-react";
import {
  getGatewayRoutes,
  listGateways,
  resetGatewayRoutes,
  setGatewayAdminConfig,
  testGatewayAdmin,
  type GatewaySummary,
  type KongRoute
} from "@/lib/api";

const inputClass =
  "h-10 w-full rounded-xl border-none bg-surface px-3 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";
const labelClass = "grid gap-1 text-xs font-semibold uppercase tracking-wider text-muted";

export function GatewayRoutesDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [gatewayId, setGatewayId] = useState<number | null>(null);
  const [routes, setRoutes] = useState<KongRoute[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [configuring, setConfiguring] = useState(false);

  // control-channel form
  const [adminUrl, setAdminUrl] = useState("");
  const [adminCreds, setAdminCreds] = useState("");
  const [verifyTls, setVerifyTls] = useState(false);
  const [redisHost, setRedisHost] = useState("");
  const [redisPort, setRedisPort] = useState(6379);
  const [redisDb, setRedisDb] = useState(0);
  const [redisPassword, setRedisPassword] = useState("");

  const gateway = gateways.find((g) => g.id === gatewayId) ?? null;

  const loadGateways = useCallback(async () => {
    try {
      const rows = await listGateways(token);
      setGateways(rows);
      setGatewayId((cur) => cur ?? rows.find((g) => g.can_manage_routes)?.id ?? rows[0]?.id ?? null);
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : "Could not load gateways" });
    }
  }, [token]);

  useEffect(() => { void loadGateways(); }, [loadGateways]);

  // prime the config form + load routes whenever the selected gateway changes
  useEffect(() => {
    if (!gateway) return;
    setAdminUrl(gateway.admin_url || "");
    setAdminCreds("");
    setVerifyTls(gateway.admin_verify_tls);
    setRedisHost(gateway.ratelimit_redis_host || "");
    setRedisPort(gateway.ratelimit_redis_port || 6379);
    setRedisDb(gateway.ratelimit_redis_db || 0);
    setRedisPassword("");
    setRoutes([]);
    setSelected(new Set());
    setNote(null);
    setConfiguring(!gateway.can_manage_routes);
    if (gateway.can_manage_routes) void loadRoutes(gateway.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatewayId]);

  async function loadRoutes(id: number) {
    setLoading(true);
    setNote(null);
    try {
      setRoutes(await getGatewayRoutes(token, id));
      setSelected(new Set());
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : "Could not load routes" });
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    if (gatewayId == null) return;
    setBusy("save");
    setNote(null);
    try {
      const updated = await setGatewayAdminConfig(token, gatewayId, {
        admin_url: adminUrl.trim(),
        admin_credentials: adminCreds,
        admin_verify_tls: verifyTls,
        ratelimit_redis_host: redisHost.trim(),
        ratelimit_redis_port: Number(redisPort) || 6379,
        ratelimit_redis_db: Number(redisDb) || 0,
        ratelimit_redis_password: redisPassword
      });
      setGateways((rows) => rows.map((g) => (g.id === updated.id ? updated : g)));
      setConfiguring(false);
      if (updated.can_manage_routes) void loadRoutes(updated.id);
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : "Could not save the control channel" });
    } finally {
      setBusy("");
    }
  }

  async function testAdmin() {
    if (gatewayId == null) return;
    setBusy("test");
    setNote(null);
    try {
      const res = await testGatewayAdmin(token, gatewayId);
      setNote({ kind: res.ok ? "ok" : "error", text: res.message });
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setBusy("");
    }
  }

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const resettable = routes.filter((r) => r.has_rate_limit);
  const allSelected = resettable.length > 0 && resettable.every((r) => selected.has(r.id));

  async function resetSelected() {
    if (gatewayId == null || selected.size === 0) return;
    if (!gateway?.ratelimit_redis_host) {
      setNote({ kind: "error", text: "Configure the rate-limit Redis first to reset counters." });
      return;
    }
    const names = routes.filter((r) => selected.has(r.id)).map((r) => r.name || r.paths[0] || r.id);
    if (!window.confirm(`Reset the LIVE rate-limit counters on the gateway for ${selected.size} route(s)?\n\n${names.slice(0, 10).join("\n")}${names.length > 10 ? "\n…" : ""}\n\nThrottled clients will be able to call these routes again immediately.`)) return;
    setBusy("reset");
    setNote(null);
    try {
      const res = await resetGatewayRoutes(token, gatewayId, [...selected]);
      setNote({ kind: res.ok ? "ok" : "error", text: res.message });
      if (res.ok) setSelected(new Set());
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : "Reset failed" });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="fixed inset-0 z-[92] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-elevated shadow-xl ring-1 ring-edge">
        <div className="flex items-center justify-between border-b border-edge px-6 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-fg"><RotateCcw size={18} className="text-accent" /> Configured routes &amp; rate limits</h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface"><X size={16} /></button>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-edge px-6 py-3">
          <label className={`${labelClass} min-w-[14rem] flex-1`}>
            Gateway
            <select value={gatewayId ?? ""} onChange={(e) => setGatewayId(Number(e.target.value))} className={inputClass}>
              {gateways.map((g) => <option key={g.id} value={g.id}>{g.name}{g.environment ? ` · ${g.environment}` : ""}</option>)}
            </select>
          </label>
          {gateway?.can_manage_routes && !configuring ? (
            <>
              <button type="button" onClick={() => gateway && void loadRoutes(gateway.id)} disabled={loading} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-surface px-3 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50">
                {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Reload
              </button>
              <button type="button" onClick={() => setConfiguring(true)} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-surface px-3 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent">
                <Settings size={15} /> Control channel
              </button>
            </>
          ) : null}
        </div>

        {note ? (
          <div className={`mx-6 mt-3 flex items-start gap-2 rounded-xl px-4 py-2.5 text-sm font-medium ${note.kind === "ok" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-danger/10 text-danger dark:text-red-300"}`}>
            {note.kind === "ok" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <span className="break-words">{note.text}</span>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {configuring || !gateway?.can_manage_routes ? (
            <div className="grid gap-3">
              <p className="text-sm text-muted">
                The route list comes from a managed snapshot — no Kong Admin credentials are needed to view or reset routes.
                Resets act through the gateway&apos;s <span className="font-semibold text-fg">rate-limit Redis</span>, so only that has to be set here.
                The <span className="font-semibold text-fg">Kong Admin API</span> below is optional: configure it only if you want routes pulled live instead of from the snapshot. Secrets are stored encrypted and never shown again.
              </p>
              <label className={labelClass}>Kong Admin API URL <span className="font-normal normal-case text-muted">(optional)</span>
                <input value={adminUrl} onChange={(e) => setAdminUrl(e.target.value)} placeholder="https://192.168.1.46:8445" className={inputClass} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={labelClass}>Admin credentials <span className="font-normal normal-case text-muted">{gateway?.has_admin_credentials ? "(stored — blank keeps)" : "user:pass (basic auth)"}</span>
                  <input value={adminCreds} onChange={(e) => setAdminCreds(e.target.value)} type="password" autoComplete="new-password" placeholder={gateway?.has_admin_credentials ? "••••••••" : "admin:password"} className={inputClass} />
                </label>
                <label className="flex items-center gap-2.5 pt-5">
                  <input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} className="h-4 w-4 rounded border-edge text-accent focus:ring-accent" />
                  <span className="text-sm font-medium text-fg">Verify TLS <span className="font-normal text-muted">(off for a self-signed proxy)</span></span>
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <label className={`${labelClass} sm:col-span-2`}>Rate-limit Redis host
                  <input value={redisHost} onChange={(e) => setRedisHost(e.target.value)} placeholder="192.168.1.46" className={inputClass} />
                </label>
                <label className={labelClass}>Port
                  <input type="number" min={1} max={65535} value={redisPort} onChange={(e) => setRedisPort(Number(e.target.value))} className={inputClass} />
                </label>
                <label className={labelClass}>DB
                  <input type="number" min={0} max={15} value={redisDb} onChange={(e) => setRedisDb(Number(e.target.value))} className={inputClass} />
                </label>
              </div>
              <label className={labelClass}>Redis password <span className="font-normal normal-case text-muted">{gateway?.has_ratelimit_redis_password ? "(stored — blank keeps)" : "(optional)"}</span>
                <input value={redisPassword} onChange={(e) => setRedisPassword(e.target.value)} type="password" autoComplete="new-password" placeholder={gateway?.has_ratelimit_redis_password ? "••••••••" : "optional"} className={inputClass} />
              </label>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => void saveConfig()} disabled={busy !== "" || (!adminUrl.trim() && !redisHost.trim())} className="inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
                  {busy === "save" ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save
                </button>
                <button type="button" onClick={() => void testAdmin()} disabled={busy !== "" || !gateway?.admin_url} className="inline-flex h-10 items-center gap-2 rounded-xl bg-surface px-4 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50">
                  {busy === "test" ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />} Test Admin API
                </button>
                {gateway?.can_manage_routes ? (
                  <button type="button" onClick={() => { setConfiguring(false); if (gateway) void loadRoutes(gateway.id); }} className="ml-auto inline-flex h-10 items-center rounded-xl px-3 text-sm font-semibold text-muted transition-colors hover:text-fg">Back to routes</button>
                ) : null}
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Loading routes…</div>
          ) : routes.length === 0 ? (
            <p className="py-8 text-sm text-muted">No routes available for this gateway yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-3 py-2">
                    <input type="checkbox" checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(resettable.map((r) => r.id)) : new Set())} className="h-4 w-4 rounded border-edge text-accent focus:ring-accent" title="Select all rate-limited routes" />
                  </th>
                  {["Route", "Rate limit", "By", "Active now", "Methods"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {routes.map((r) => (
                  <tr key={r.id} className={r.has_rate_limit ? "" : "opacity-50"}>
                    <td className="px-3 py-2 align-top">
                      <input type="checkbox" disabled={!r.has_rate_limit} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4 rounded border-edge text-accent focus:ring-accent disabled:opacity-40" />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="font-medium text-fg">{r.name || "(unnamed)"}</div>
                      <div className="truncate font-mono text-[11px] text-muted" title={r.paths.join(", ")}>{r.paths.join(", ") || "—"}{r.service ? ` · ${r.service}` : ""}</div>
                    </td>
                    <td className="px-3 py-2 align-top font-mono text-xs">{r.rate_limit || <span className="text-muted">none</span>}</td>
                    <td className="px-3 py-2 align-top text-xs">{r.limit_by || "—"}</td>
                    <td className="px-3 py-2 align-top text-xs">
                      {r.active_counters > 0
                        ? <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-700 dark:text-amber-300" title="live rate-limit counter keys in Redis for this route">{r.active_counters}</span>
                        : <span className="text-muted">0</span>}
                    </td>
                    <td className="px-3 py-2 align-top text-xs">{r.methods.join(", ") || "any"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {!configuring && gateway?.can_manage_routes ? (
          <div className="flex items-center gap-3 border-t border-edge px-6 py-3">
            <span className="text-xs text-muted">{selected.size} selected · reset clears the live counter so throttled clients can call again.</span>
            <button type="button" onClick={() => void resetSelected()} disabled={busy !== "" || selected.size === 0} className="ml-auto inline-flex h-10 items-center gap-2 rounded-full bg-danger px-5 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-50">
              {busy === "reset" ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />} Reset selected
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
