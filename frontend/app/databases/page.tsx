"use client";

import { AppShell } from "@/components/app-shell";
import { DatabaseConsole } from "@/components/database-console";

export default function DatabasesPage() {
  return (
    <AppShell title="Database Console" subtitle="Connect to a PostgreSQL or MySQL database and run read-only queries">
      {({ token, me }) =>
        // Blocked for desktop guests: the console connects out to arbitrary databases with
        // operator-supplied credentials, so it must be a real signed-in account. The backend
        // enforces this too (require_user_not_guest -> 403); this just hides the UI.
        me.guest ? (
          <section className="px-6 py-6 text-sm font-medium text-muted">
            The database console is not available in guest mode. Sign in to use it.
          </section>
        ) : (
          <DatabaseConsole token={token} />
        )
      }
    </AppShell>
  );
}
