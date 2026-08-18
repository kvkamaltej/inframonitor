// Monitoring query catalog — the PromQL/LogQL "commands" the monitoring UI issues, as DATA.
//
// Why this file exists: the queries used to live inline inside the React components
// (monitoring-page.tsx, server-detail-app.tsx, loki-logs.tsx), tangled with the JSX. That fused
// "what to fetch" with "how to render it", so a layout change risked the queries and a query
// change meant editing a presentation component. Everything query-shaped now lives here as plain
// data / pure functions; components import and render FROM it. Change a query here without touching
// a component; restyle a component without touching a query.

export const CHART_ACCENT = "var(--inframonitor-accent)";

// --- deployment-wide overview charts (Monitoring page → Metrics tab) ------------------------
export type OverviewChart = {
  id: string;
  title: string;
  subtitle: string;
  query: string;
  color: string;
};

export const OVERVIEW_CHARTS: OverviewChart[] = [
  {
    id: "request-rate",
    title: "Request rate",
    subtitle: "requests/sec",
    query: `sum(rate(inframonitor_http_requests_total[5m]))`,
    color: CHART_ACCENT,
  },
  {
    id: "error-rate",
    title: "Error rate",
    subtitle: "5xx/sec",
    query: `sum(rate(inframonitor_http_requests_total{status=~"5.."}[5m]))`,
    color: "#dc2626",
  },
  {
    id: "p95-latency",
    title: "p95 latency",
    subtitle: "seconds",
    query: `histogram_quantile(0.95, sum by (le) (rate(inframonitor_http_request_duration_seconds_bucket[5m])))`,
    color: "#d97706",
  },
];

// The "Targets up" panel issues two instant queries (a headline sum + a per-target vector).
export const TARGETS_QUERIES = { total: "sum(up)", perTarget: "up" };

// --- per-server drilldown charts (Server detail → Monitoring) --------------------------------
export type ServerChartLine = { key: string; label: string; color: string; query: string };
export type ServerChartDef = { id: string; title: string; subtitle: string; unit: string; lines: ServerChartLine[] };

// Escape a label value so it can never break out of a double-quoted PromQL/LogQL selector. The
// server id is a uuid today, but escape regardless (the old inline `promLabel` did the same).
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Build the four per-server charts with `server_id` pinned to this host. Queries are byte-for-byte
// what the component used inline; only their home moved.
export function serverMetricCharts(serverId: string): ServerChartDef[] {
  const sid = escapeLabelValue(serverId);
  return [
    {
      id: "cpu",
      title: "CPU",
      subtitle: "% used",
      unit: "%",
      lines: [
        {
          key: "v",
          label: "CPU %",
          color: CHART_ACCENT,
          query: `100 - (avg(rate(node_cpu_seconds_total{mode="idle",server_id="${sid}"}[5m])) * 100)`,
        },
      ],
    },
    {
      id: "memory",
      title: "Memory",
      subtitle: "% used",
      unit: "%",
      lines: [
        {
          key: "v",
          label: "Memory %",
          color: "#7c3aed",
          query: `(1 - (node_memory_MemAvailable_bytes{server_id="${sid}"} / node_memory_MemTotal_bytes{server_id="${sid}"})) * 100`,
        },
      ],
    },
    {
      id: "disk",
      title: "Disk (root)",
      subtitle: "% used",
      unit: "%",
      lines: [
        {
          key: "v",
          label: "Disk %",
          color: "#d97706",
          query: `100 - (node_filesystem_avail_bytes{server_id="${sid}",mountpoint="/"} / node_filesystem_size_bytes{server_id="${sid}",mountpoint="/"} * 100)`,
        },
      ],
    },
    {
      id: "network",
      title: "Network",
      subtitle: "bytes/sec",
      unit: "B/s",
      lines: [
        { key: "rx", label: "In", color: CHART_ACCENT, query: `rate(node_network_receive_bytes_total{server_id="${sid}"}[5m])` },
        { key: "tx", label: "Out", color: "#dc2626", query: `rate(node_network_transmit_bytes_total{server_id="${sid}"}[5m])` },
      ],
    },
  ];
}

// --- LogQL selector building (LokiLogViewer) -------------------------------------------------
export type SelectorRow = { label: string; value: string };

// Assemble a LogQL query from selector rows + an optional pinned matcher + a line filter. Pure:
// takes state in, returns the query or a discriminated error the component maps to a message.
export function buildLogqlSelector(
  selectors: SelectorRow[],
  pinnedSelector: string | undefined,
  lineFilter: string
): { logql: string } | { error: "empty" | "incomplete" } {
  const matchers: string[] = [];
  if (pinnedSelector && pinnedSelector.trim()) matchers.push(pinnedSelector.trim());
  const hasRows = selectors.length > 0;
  for (const row of selectors) {
    if (row.label && row.value) matchers.push(`${row.label}="${escapeLabelValue(row.value)}"`);
  }
  if (matchers.length === 0) {
    const anyPartial = selectors.some((row) => row.label || row.value);
    return { error: hasRows && anyPartial ? "incomplete" : "empty" };
  }
  let logql = `{${matchers.join(", ")}}`;
  const filter = lineFilter.trim();
  if (filter) logql += ` ${filter}`;
  return { logql };
}
