"use client";

import { AppShell } from "@/components/app-shell";
import { AccessControl } from "@/components/access-control";

export default function AccessPage() {
  return (
    <AppShell title="Access Control" subtitle="Configure which sidebar menus each role can see">
      {({ token, me }) =>
        me.role === "admin" && !me.guest ? (
          <AccessControl token={token} />
        ) : (
          <section className="px-6 py-6 text-sm font-medium text-muted">Admin role required.</section>
        )
      }
    </AppShell>
  );
}
