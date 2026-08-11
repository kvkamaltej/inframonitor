"use client";

import Link from "next/link";
import { AppShell } from "@/components/app-shell";

export default function MasterPage() {
  return (
    <AppShell title="Master Data" subtitle="Manage reusable classifications">
      {({ me }) => me.role === "admin" ? (
        <section className="grid gap-4 px-6 py-6 md:grid-cols-2">
          <Link href="/master/server-types" className="border border-line bg-panel p-5 dark:border-slate-700 dark:bg-slate-900"><div className="font-semibold">Server Types</div><p className="mt-2 text-sm text-slate-500">application, database, web server, repository, tools, other</p></Link>
          <Link href="/master/application-types" className="border border-line bg-panel p-5 dark:border-slate-700 dark:bg-slate-900"><div className="font-semibold">Application Types</div><p className="mt-2 text-sm text-slate-500">Use this for app classifications that differ from server types.</p></Link>
        </section>
      ) : <section className="px-6 py-6">Admin role required.</section>}
    </AppShell>
  );
}
