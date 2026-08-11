"use client";

import { AppShell } from "@/components/app-shell";
import { AppearanceSettings } from "@/components/appearance-settings";

export default function AppearancePage() {
  return (
    <AppShell title="Appearance" subtitle="Choose the accent colour">
      {({ me }) => me.role === "admin" ? <section className="max-w-3xl px-6 py-6"><AppearanceSettings /></section> : <section className="px-6 py-6">Admin role required.</section>}
    </AppShell>
  );
}
