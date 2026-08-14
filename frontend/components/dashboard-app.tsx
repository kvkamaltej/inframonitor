"use client";

import Link from "next/link";
import { Activity, AlertTriangle, Database, Gauge, Server as ServerIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { StatusPill } from "@/components/status-pill";
import { getIntegrations, getServers, getSummary, Integration, Server, Summary } from "@/lib/api";

function Metric({ label, value, icon, caption }: { label: string; value: string | number; icon: React.ReactNode; caption?: string }) {
  return (
    <div className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200 transition-shadow hover:shadow-md dark:bg-[#1e1e1e] dark:ring-slate-800">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">{label}</span>
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">{icon}</span>
      </div>
      <div className="mt-4 text-4xl font-bold tracking-tight text-slate-900 dark:text-white">{value}</div>
      {caption ? <div className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">{caption}</div> : null}
    </div>
  );
}

export function DashboardApp() {
  return (
    <AppShell title="Infrastructure Dashboard" subtitle="Health, inventory, and observability overview">
      {({ token }) => <DashboardContent token={token} />}
    </AppShell>
  );
}

function DashboardContent({ token }: { token: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const [nextSummary, nextServers, nextIntegrations] = await Promise.all([getSummary(token), getServers(token), getIntegrations(token)]);
        setSummary(nextSummary);
        setServers(nextServers);
        setIntegrations(nextIntegrations);
        setLoadError("");
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "Unable to load dashboard data");
      }
    }
    void load();
  }, [token]);

  return (
    <section className="space-y-6 px-6 py-6">
      {loadError ? (
        <div className="flex items-start gap-3 rounded-2xl bg-rose-50 p-4 text-sm font-medium text-rose-700 ring-1 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span>Unable to load dashboard data: {loadError}</span>
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-4">
        {/* The health score is an average over *measured* servers only, so the caption says how
            many that is — a bare "50" over a fleet where half the hosts were never probed is
            what made this tile untrustworthy. */}
        <Metric
          label="Health Score"
          value={summary && summary.measured_servers > 0 ? summary.average_health_score : "—"}
          caption={
            summary
              ? summary.measured_servers === 0
                ? "nothing measured yet"
                : `over ${summary.measured_servers} of ${summary.server_count} measured`
              : ""
          }
          icon={<Gauge size={20} />}
        />
        <Metric
          label="Servers"
          value={summary?.server_count ?? 0}
          caption={summary && summary.unknown_servers > 0 ? `${summary.unknown_servers} not yet measured` : ""}
          icon={<ServerIcon size={20} />}
        />
        <Metric
          label="Needs attention"
          value={(summary?.warning_servers ?? 0) + (summary?.critical_servers ?? 0)}
          caption={summary ? `${summary.critical_servers} critical, ${summary.warning_servers} warning` : ""}
          icon={<AlertTriangle size={20} />}
        />
        <Metric label="Database services" value={summary?.databases ?? 0} icon={<Database size={20} />} />
      </div>

      <div className={`grid gap-6 ${integrations.length > 0 ? "lg:grid-cols-[1.3fr_1fr]" : ""}`}>
        <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
          <div className="border-b border-slate-100 bg-white px-6 py-5 font-semibold text-slate-900 dark:border-slate-800 dark:bg-[#1e1e1e] dark:text-slate-100">Recent Servers</div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
            {servers.slice(0, 8).map((server) => (
              <Link key={server.id} href={`/server/?id=${encodeURIComponent(server.id)}`} className="flex items-center justify-between px-6 py-4 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <div>
                  <div className="font-semibold text-slate-900 dark:text-slate-200">{server.hostname}</div>
                  <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{server.ip_address} / {server.server_type}</div>
                </div>
                <StatusPill status={server.status} />
              </Link>
            ))}
          </div>
        </div>

        {integrations.length > 0 && (
          <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
            <div className="flex items-center gap-3 border-b border-slate-100 bg-white px-6 py-5 font-semibold text-slate-900 dark:border-slate-800 dark:bg-[#1e1e1e] dark:text-slate-100"><Activity size={18} className="text-indigo-600 dark:text-indigo-400" /> Monitoring Stack</div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {integrations.map((integration) => (
                <div key={integration.name} className="flex items-center justify-between px-6 py-4 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <div>
                    <div className="font-semibold capitalize text-slate-900 dark:text-slate-200">{integration.name}</div>
                    <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{integration.url}</div>
                  </div>
                  <StatusPill status={integration.status} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
