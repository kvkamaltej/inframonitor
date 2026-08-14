"use client";

import { AppShell } from "@/components/app-shell";
import { DbWorkspace } from "@/components/db-workspace";

export default function DatabasesPage() {
  return (
    <AppShell title="Database" subtitle="Browse connections, explore schemas, and run SQL">
      {({ token, me }) =>
        // Blocked for desktop guests: the workspace connects out to arbitrary databases with
        // operator-supplied credentials, so it must be a real signed-in account. The backend
        // enforces this too (require_user_not_guest -> 403); this just hides the UI.
        me.guest ? (
          <section className="px-6 py-6 text-sm font-medium text-muted">
            The database workspace is not available in guest mode. Sign in to use it.
          </section>
        ) : (
          <DbWorkspace token={token} />
        )
      }
    </AppShell>
  );
}
