"use client";

import { AppShell } from "@/components/app-shell";
import { SshConfigManager } from "@/components/ssh-config-manager";

export default function SshConfigsPage() {
  return (
    <AppShell title="SSH Configs" subtitle="Reusable jump host / tunnel profiles">
      {({ token, me }) => me.role === "admin" ? (
        <section className="px-6 py-6"><SshConfigManager token={token} /></section>
      ) : (
        <section className="px-6 py-6">Admin role required.</section>
      )}
    </AppShell>
  );
}
