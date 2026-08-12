"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, ServerOff } from "lucide-react";
import { ServerDetailApp } from "@/components/server-detail-app";

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6 py-12">
      <div className="w-full max-w-md rounded-3xl bg-surface p-8 text-center shadow-sm ring-1 ring-edge">{children}</div>
    </main>
  );
}

function Fallback() {
  return (
    <CenteredCard>
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Loading server…</p>
    </CenteredCard>
  );
}

function NoServerSelected() {
  return (
    <CenteredCard>
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <ServerOff size={24} />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">No server selected</h1>
      <p className="mt-2 text-sm font-medium text-slate-500 dark:text-slate-400">
        This page needs a server id in the URL, for example <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">/server/?id=&lt;server-id&gt;</code>. Pick a host from the inventory to open its detail view.
      </p>
      <Link href="/servers" className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80">
        <ArrowLeft size={16} /> Server List
      </Link>
    </CenteredCard>
  );
}

// useSearchParams() must live inside a <Suspense> boundary or `output: "export"`
// fails the build with "useSearchParams() should be wrapped in a suspense boundary".
function ServerDetailFromQuery() {
  const searchParams = useSearchParams();
  const id = (searchParams.get("id") ?? "").trim();
  if (!id) return <NoServerSelected />;
  return <ServerDetailApp serverId={id} />;
}

export default function ServerPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <ServerDetailFromQuery />
    </Suspense>
  );
}
