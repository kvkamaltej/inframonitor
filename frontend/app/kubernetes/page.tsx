"use client";

import { AppShell } from "@/components/app-shell";
import { KubernetesConsole } from "@/components/kubernetes-console";

export default function KubernetesPage() {
  return (
    <AppShell title="Kubernetes" subtitle="Connect a cluster to view nodes, pods, logs and health.">
      {({ token, me }) =>
        // Blocked for desktop guests: the console proxies calls to arbitrary cluster API servers
        // with operator-supplied credentials, so it must be a real signed-in account. The backend
        // enforces this too (require_user_not_guest -> 403); this just hides the UI.
        me.guest ? (
          <section className="px-6 py-6 text-sm font-medium text-muted">
            Kubernetes clusters are not available in guest mode. Sign in to use them.
          </section>
        ) : (
          <KubernetesConsole token={token} />
        )
      }
    </AppShell>
  );
}
