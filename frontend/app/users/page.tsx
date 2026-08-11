"use client";

import { AppShell } from "@/components/app-shell";
import { UserManagement } from "@/components/user-management";

export default function UsersPage() {
  return (
    <AppShell title="User Management" subtitle="Create admin, developer, and support users">
      {({ token, me }) => me.role === "admin" ? <section className="px-6 py-6"><UserManagement token={token} /></section> : <section className="px-6 py-6">Admin role required.</section>}
    </AppShell>
  );
}
