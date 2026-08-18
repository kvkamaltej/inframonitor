"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  Activity,
  BellRing,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  ServerCog,
  Trash2
} from "lucide-react";
import { LokiLogViewer } from "@/components/loki-logs";
import { OVERVIEW_CHARTS, TARGETS_QUERIES, CHART_ACCENT } from "@/lib/monitoring-queries";
import {
  addAlertRule,
  deleteAlertRule,
  getAlertTemplates,
  getMonitoringAlerts,
  getMonitoringEnabled,
  listAlertRules,
  promQuery,
  promQueryRange,
  type AlertmanagerAlert,
  type AlertRule,
  type AlertTemplate,
  type MonitoringEnabled,
  type PromResponse
} from "@/lib/api";

// --- time ranges ----------------------------------------------------------------------------
// Each range fixes both the window and a step chosen to keep a range to roughly 60-120 points,
// so the charts stay smooth without asking Prometheus for a point per second on a 24h window.
type RangeKey = "15m" | "1h" | "6h" | "24h";
const RANGES: { key: RangeKey; label: string; seconds: number; step: number }[] = [
  { key: "15m", label: "15m", seconds: 15 * 60, step: 15 },
  { key: "1h", label: "1h", seconds: 60 * 60, step: 30 },
  { key: "6h", label: "6h", seconds: 6 * 60 * 60, step: 180 },
  { key: "24h", label: "24h", seconds: 24 * 60 * 60, step: 600 }
];

type TabKey = "metrics" | "alerts" | "logs";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Prometheus range result -> recharts rows. Takes the first series (the queries here all reduce
// to a single series via sum/histogram_quantile) and maps [ts, "val"] pairs to {t, v}. A
// non-finite value (NaN/Inf strings from Prometheus) becomes null so recharts leaves a gap.
function toSeries(resp: PromResponse | null): { t: number; v: number | null }[] {
  const first = resp?.data?.result?.[0];
  if (!first?.values) return [];
  return first.values.map(([ts, raw]) => {
    const num = Number(raw);
    return { t: ts, v: Number.isFinite(num) ? num : null };
  });
}

function formatClock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// "firing since" from an RFC3339 timestamp -> a compact relative string.
function since(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function MonitoringPage({ token, isAdmin }: { token: string; isAdmin?: boolean }) {
  const [enabled, setEnabled] = useState<MonitoringEnabled | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<TabKey>("metrics");
  const [range, setRange] = useState<RangeKey>("1h");
  // Bumped by the Refresh button and on range change; every data panel keys its fetch off it.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const data = await getMonitoringEnabled(token);
        if (cancelled) return;
        setEnabled(data);
        // Land on the first tab whose backend is actually configured.
        if (data.prometheus) setTab("metrics");
        else if (data.alertmanager) setTab("alerts");
        else if (data.loki) setTab("logs");
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unable to load monitoring config");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const activeRange = useMemo(() => RANGES.find((r) => r.key === range) ?? RANGES[1], [range]);

  const tabs = useMemo(() => {
    const list: { key: TabKey; label: string }[] = [];
    if (enabled?.prometheus) list.push({ key: "metrics", label: "Metrics" });
    if (enabled?.alertmanager) list.push({ key: "alerts", label: "Alerts" });
    if (enabled?.loki) list.push({ key: "logs", label: "Logs" });
    return list;
  }, [enabled]);

  if (loading) {
    return (
      <section className="flex items-center gap-2 px-6 py-10 text-sm font-medium text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading monitoring…
      </section>
    );
  }

  if (loadError) {
    return (
      <section className="px-6 py-6">
        <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
          {loadError}
        </div>
      </section>
    );
  }

  // Lite profile: nothing in the stack is wired up. Show a friendly, non-error empty state.
  const anyEnabled = enabled && (enabled.prometheus || enabled.loki || enabled.alertmanager);
  if (!anyEnabled) {
    return (
      <section className="px-6 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-edge bg-surface px-8 py-12 text-center">
          <Activity size={32} className="text-accent" />
          <h2 className="text-lg font-semibold text-fg">Monitoring is available in the full profile</h2>
          <p className="text-sm font-medium text-muted">
            Prometheus, Loki, and Alertmanager are not configured for this deployment. Enable the
            monitoring stack in the full profile to see metrics, alerts, and logs here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="px-6 py-6">
      {/* Header row: tab pills + range selector + Grafana link + Refresh. */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`h-9 rounded-full border px-4 text-sm font-medium transition-colors ${
                tab === key
                  ? "border-accent bg-accent text-white"
                  : "border-edge text-fg hover:bg-surface"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {tab === "metrics" && (
            <div className="flex items-center gap-1 rounded-full border border-edge bg-surface p-1">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => {
                    setRange(r.key);
                    setRefreshKey((k) => k + 1);
                  }}
                  className={`h-7 rounded-full px-3 text-xs font-semibold transition-colors ${
                    range === r.key ? "bg-accent text-white" : "text-muted hover:text-fg"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          {enabled?.grafana_url ? (
            <a
              href={enabled.grafana_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-edge px-4 text-sm font-medium text-fg transition-colors hover:bg-surface"
            >
              <ExternalLink size={15} /> Open in Grafana
            </a>
          ) : null}
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-accent/10 px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent/20"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      {tab === "metrics" && enabled?.prometheus ? (
        <MetricsTab token={token} range={activeRange} refreshKey={refreshKey} />
      ) : null}
      {tab === "alerts" && enabled?.alertmanager ? (
        <AlertsTab token={token} isAdmin={isAdmin} refreshKey={refreshKey} />
      ) : null}
      {tab === "logs" && enabled?.loki ? (
        <LokiLogViewer token={token} title="Logs" />
      ) : null}
    </section>
  );
}

// --- Metrics --------------------------------------------------------------------------------

function MetricsTab({
  token,
  range,
  refreshKey
}: {
  token: string;
  range: { seconds: number; step: number };
  refreshKey: number;
}) {
  const [graphsOpen, setGraphsOpen] = useState(true);
  return (
    <div className="grid gap-3">
      <button
        onClick={() => setGraphsOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-semibold text-fg transition-colors hover:text-accent"
      >
        {graphsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />} Graphs
      </button>
      {graphsOpen ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {OVERVIEW_CHARTS.map((c) => (
            <MetricChart
              key={c.id}
              token={token}
              title={c.title}
              subtitle={c.subtitle}
              query={c.query}
              color={c.color}
              range={range}
              refreshKey={refreshKey}
            />
          ))}
          <TargetsPanel token={token} refreshKey={refreshKey} />
        </div>
      ) : null}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {subtitle ? <span className="text-xs font-medium text-muted">{subtitle}</span> : null}
      </div>
      {children}
    </div>
  );
}

function MetricChart({
  token,
  title,
  subtitle,
  query,
  color,
  range,
  refreshKey
}: {
  token: string;
  title: string;
  subtitle?: string;
  query: string;
  color: string;
  range: { seconds: number; step: number };
  refreshKey: number;
}) {
  const [data, setData] = useState<{ t: number; v: number | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const end = nowSec();
      const start = end - range.seconds;
      const resp = await promQueryRange(token, query, start, end, range.step);
      setData(toSeries(resp));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [token, query, range.seconds, range.step]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <ChartCard title={title} subtitle={subtitle}>
      <div className="h-56">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-2 text-center text-sm font-medium text-danger">{error}</div>
        ) : data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">No data for this range.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="var(--im-edge)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={formatClock}
                stroke="var(--im-muted)"
                tick={{ fontSize: 11 }}
                minTickGap={40}
              />
              <YAxis stroke="var(--im-muted)" tick={{ fontSize: 11 }} width={48} allowDecimals />
              <Tooltip
                contentStyle={{
                  background: "var(--im-elevated)",
                  border: "1px solid var(--im-edge)",
                  borderRadius: 12,
                  fontSize: 12,
                  color: "var(--im-fg)"
                }}
                labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString()}
                formatter={(value: number | string) => [typeof value === "number" ? value.toPrecision(4) : value, title]}
              />
              <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </ChartCard>
  );
}

// "Targets up" — sum(up) as a headline plus each target's up/down status from the per-series
// instant vector.
function TargetsPanel({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [total, setTotal] = useState<number | null>(null);
  const [targets, setTargets] = useState<{ label: string; up: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [sumResp, perResp] = await Promise.all([promQuery(token, TARGETS_QUERIES.total), promQuery(token, TARGETS_QUERIES.perTarget)]);
      const sumVal = Number(sumResp?.data?.result?.[0]?.value?.[1]);
      setTotal(Number.isFinite(sumVal) ? sumVal : null);
      const rows = (perResp?.data?.result ?? []).map((series) => {
        const m = series.metric ?? {};
        const label = m.instance || m.job || Object.values(m)[0] || "target";
        return { label, up: Number(series.value?.[1]) === 1 };
      });
      rows.sort((a, b) => a.label.localeCompare(b.label));
      setTargets(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
      setTargets([]);
      setTotal(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <ChartCard title="Targets up" subtitle={total != null ? `${total} up` : undefined}>
      <div className="h-56 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-2 text-center text-sm font-medium text-danger">{error}</div>
        ) : targets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted">No scrape targets.</div>
        ) : (
          <ul className="grid gap-1">
            {targets.map((t) => (
              <li
                key={t.label}
                className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-sm"
              >
                <ServerCog size={14} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-fg" title={t.label}>
                  {t.label}
                </span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    t.up
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                      : "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${t.up ? "bg-emerald-500" : "bg-red-500"}`} />
                  {t.up ? "up" : "down"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ChartCard>
  );
}

// --- Alerts ---------------------------------------------------------------------------------

function severityTone(severity: string): { dot: string; label: string } {
  const s = (severity || "").toLowerCase();
  if (s === "critical" || s === "error") return { dot: "bg-red-500", label: severity || "critical" };
  if (s === "warning" || s === "warn") return { dot: "bg-amber-500", label: severity || "warning" };
  return { dot: "bg-slate-400", label: severity || "info" };
}

function AlertsTab({ token, isAdmin, refreshKey }: { token: string; isAdmin?: boolean; refreshKey: number }) {
  const [alerts, setAlerts] = useState<AlertmanagerAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAlerts(await getMonitoringAlerts(token));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load alerts");
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div className="grid gap-5">
      <CustomAlertRules token={token} isAdmin={isAdmin} refreshKey={refreshKey} onAlertsChanged={load} />

      <div className="grid gap-3">
        <h3 className="text-sm font-semibold text-fg">Active alerts</h3>
        {loading ? (
          <div className="flex items-center gap-2 py-10 text-sm font-medium text-muted">
            <Loader2 size={16} className="animate-spin" /> Loading alerts…
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm font-medium text-danger">{error}</div>
        ) : alerts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-edge bg-surface px-8 py-12 text-center">
            <BellRing size={28} className="text-accent" />
            <p className="text-sm font-semibold text-fg">No active alerts</p>
            <p className="text-sm font-medium text-muted">Everything is quiet right now.</p>
          </div>
        ) : (
          alerts.map((alert, index) => {
            const labels = alert.labels ?? {};
            const annotations = alert.annotations ?? {};
            const tone = severityTone(labels.severity);
            const name = labels.alertname || "alert";
            return (
              <div key={`${name}-${index}`} className="rounded-2xl border border-edge bg-surface p-4">
                <div className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-fg">{name}</h3>
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                        {tone.label}
                      </span>
                      {labels.job ? (
                        <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] font-medium text-muted">job: {labels.job}</span>
                      ) : null}
                      {labels.instance ? (
                        <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] font-medium text-muted">
                          {labels.instance}
                        </span>
                      ) : null}
                    </div>
                    {annotations.summary ? <p className="mt-1.5 text-sm font-medium text-fg">{annotations.summary}</p> : null}
                    {annotations.description ? <p className="mt-1 text-sm text-muted">{annotations.description}</p> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted">
                      {alert.startsAt ? <span>firing since {since(alert.startsAt)}</span> : null}
                      {alert.status?.state ? <span className="capitalize">state: {alert.status.state}</span> : null}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Custom alert rules: list existing rules, delete them, and add new ones from a template or by
// hand. Sits above the active-alerts list; on any change it also refreshes the active alerts via
// onAlertsChanged so a freshly-created rule shows up once Prometheus evaluates it.
function CustomAlertRules({
  token,
  isAdmin,
  refreshKey,
  onAlertsChanged
}: {
  token: string;
  isAdmin?: boolean;
  refreshKey: number;
  onAlertsChanged: () => void;
}) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [templates, setTemplates] = useState<AlertTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [templateKey, setTemplateKey] = useState("");
  const [name, setName] = useState("");
  const [expr, setExpr] = useState("");
  const [forDuration, setForDuration] = useState("5m");
  const [severity, setSeverity] = useState("warning");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [rulesResp, templatesResp] = await Promise.all([listAlertRules(token), getAlertTemplates(token)]);
      setRules(rulesResp);
      setTemplates(templatesResp);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load alert rules");
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadRules();
  }, [loadRules, refreshKey]);

  const activeTemplate = useMemo(() => templates.find((t) => t.key === templateKey), [templates, templateKey]);

  function applyTemplate(key: string) {
    setTemplateKey(key);
    const tpl = templates.find((t) => t.key === key);
    if (!tpl) return;
    setName(tpl.name);
    setExpr(tpl.expr);
    setForDuration(tpl.for || "5m");
    setSeverity(tpl.severity || "warning");
    setSummary(tpl.summary);
    setDescription(tpl.description);
  }

  function resetForm() {
    setShowForm(false);
    setTemplateKey("");
    setName("");
    setExpr("");
    setForDuration("5m");
    setSeverity("warning");
    setSummary("");
    setDescription("");
    setFormError("");
  }

  async function create() {
    if (!name.trim() || !expr.trim()) {
      setFormError("Name and expression are required.");
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      await addAlertRule(token, {
        name: name.trim(),
        expr: expr.trim(),
        for_duration: forDuration.trim() || "5m",
        severity,
        summary: summary.trim(),
        description: description.trim()
      });
      resetForm();
      await loadRules();
      onAlertsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the alert rule.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(ruleName: string) {
    setDeleting(ruleName);
    setError("");
    try {
      await deleteAlertRule(token, ruleName);
      await loadRules();
      onAlertsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the alert rule.");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">Custom alert rules</h3>
          <p className="mt-0.5 text-xs font-medium text-muted">
            Add a rule from a template or by hand. The <span className="font-mono">InfraMonitorTestAlert</span> template always
            fires — use it to verify the pipeline. New rules take up to ~30s to show as active alerts.
          </p>
        </div>
        {isAdmin && !showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            <Plus size={15} /> Add alert
          </button>
        ) : null}
      </div>

      {!isAdmin ? (
        <p className="mb-3 text-xs font-medium text-muted">Adding or removing alert rules requires an admin.</p>
      ) : null}

      {error ? (
        <div className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-medium text-danger">{error}</div>
      ) : null}

      {isAdmin && showForm ? (
        <div className="mb-4 grid gap-3 rounded-xl border border-edge bg-page p-4">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Template</span>
            <select
              value={templateKey}
              onChange={(e) => applyTemplate(e.target.value)}
              className="h-9 rounded-lg border border-edge bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
            >
              <option value="">Start from scratch…</option>
              {templates.map((tpl) => (
                <option key={tpl.key} value={tpl.key}>
                  {tpl.name}
                </option>
              ))}
            </select>
            {activeTemplate?.requires ? (
              <span className="text-xs font-medium text-amber-600 dark:text-amber-400">Requires: {activeTemplate.requires}</span>
            ) : null}
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                className="h-9 rounded-lg border border-edge bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">For</span>
              <input
                value={forDuration}
                onChange={(e) => setForDuration(e.target.value)}
                placeholder="5m"
                spellCheck={false}
                className="h-9 rounded-lg border border-edge bg-surface px-3 font-mono text-sm text-fg outline-none focus:border-accent"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Expression</span>
            <textarea
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="up == 0"
              className="rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-sm text-fg outline-none focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Severity</span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              className="h-9 rounded-lg border border-edge bg-surface px-2 text-sm text-fg outline-none focus:border-accent"
            >
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="critical">critical</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Summary</span>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              className="h-9 rounded-lg border border-edge bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            />
          </label>

          {formError ? (
            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm font-medium text-danger">{formError}</div>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              onClick={() => void create()}
              disabled={submitting}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {submitting ? <Loader2 size={15} className="animate-spin" /> : null} Create
            </button>
            <button
              onClick={resetForm}
              disabled={submitting}
              className="inline-flex h-9 items-center rounded-full border border-edge px-4 text-sm font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm font-medium text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading rules…
        </div>
      ) : rules.length === 0 ? (
        <p className="py-4 text-sm font-medium text-muted">No custom alert rules yet.</p>
      ) : (
        <ul className="grid gap-2">
          {rules.map((rule) => {
            const tone = severityTone(rule.severity);
            return (
              <li key={rule.name} className="flex items-start gap-3 rounded-xl border border-edge px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-fg">{rule.name}</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-elevated px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
                      <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                      {tone.label}
                    </span>
                    {rule.for ? (
                      <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] font-medium text-muted">for: {rule.for}</span>
                    ) : null}
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-muted">{rule.expr}</p>
                </div>
                {isAdmin ? (
                  <button
                    onClick={() => void remove(rule.name)}
                    disabled={deleting === rule.name}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-danger/40 px-3 text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                  >
                    {deleting === rule.name ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Delete
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
