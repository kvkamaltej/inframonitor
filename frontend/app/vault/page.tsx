"use client";

import { AppShell } from "@/components/app-shell";
import { VaultSettings } from "@/components/vault-settings";

export default function VaultPage() {
  return (
    <AppShell title="Vault" subtitle="Store SSH credentials in HashiCorp Vault">
      {({ token, me }) =>
        me.role === "admin" && !me.guest ? (
          <section className="max-w-3xl px-6 py-6">
            <VaultSettings token={token} />
          </section>
        ) : (
          <section className="px-6 py-6">Admin role required.</section>
        )
      }
    </AppShell>
  );
}
