"use client";

import { AppShell } from "@/components/app-shell";
import { SettingsPanel } from "@/components/settings-panel";

export default function EnvironmentsPage() {
  return (
    <AppShell title="Environments" subtitle="Manage environment classification master data">
      {({ token, me }) => me.role === "admin" ? <section className="px-6 py-6"><SettingsPanel token={token} mode="environments" /></section> : <section className="px-6 py-6">Admin role required.</section>}
    </AppShell>
  );
}
