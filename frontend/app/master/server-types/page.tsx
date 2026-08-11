"use client";

import { AppShell } from "@/components/app-shell";
import { SettingsPanel } from "@/components/settings-panel";

export default function ServerTypesPage() {
  return (
    <AppShell title="Server Types" subtitle="Manage server type master data">
      {({ token, me }) => me.role === "admin" ? <section className="px-6 py-6"><SettingsPanel token={token} mode="server-types" /></section> : <section className="px-6 py-6">Admin role required.</section>}
    </AppShell>
  );
}
