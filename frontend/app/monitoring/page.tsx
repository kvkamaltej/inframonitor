"use client";

import { AppShell } from "@/components/app-shell";
import { MonitoringPage } from "@/components/monitoring-page";

export default function MonitoringRoute() {
  return (
    <AppShell title="Monitoring" subtitle="Metrics, alerts, and logs from the monitoring stack">
      {({ token, me }) => {
        const isAdmin = me?.role === "admin";
        return <MonitoringPage token={token} isAdmin={isAdmin} />;
      }}
    </AppShell>
  );
}
