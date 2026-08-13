"use client";

import { AppShell } from "@/components/app-shell";
import { AppDatabaseSettings } from "@/components/app-database-settings";

export default function AppDatabasePage() {
  return (
    <AppShell title="App Database" subtitle="Switch Infra Monitor's own database to PostgreSQL or MySQL">
      {({ token, me }) =>
        me.role === "admin" && !me.guest ? (
          <section className="max-w-3xl px-6 py-6">
            <AppDatabaseSettings token={token} />
          </section>
        ) : (
          <section className="px-6 py-6">Admin role required.</section>
        )
      }
    </AppShell>
  );
}
