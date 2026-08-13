"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, Boxes } from "lucide-react";
import { ClusterDetailApp } from "@/components/cluster-detail-app";

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
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Loading cluster…</p>
    </CenteredCard>
  );
}

function NoClusterSelected() {
  return (
    <CenteredCard>
      <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <Boxes size={24} />
      </span>
      <h1 className="mt-4 text-lg font-semibold text-slate-900 dark:text-slate-100">No cluster selected</h1>
      <p className="mt-2 text-sm font-medium text-slate-500 dark:text-slate-400">
        This page needs a cluster id in the URL, for example <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">/cluster/?id=&lt;cluster-id&gt;</code>. Pick a cluster from the list to open its detail view.
      </p>
      <Link href="/kubernetes" className="mt-6 inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80">
        <ArrowLeft size={16} /> Kubernetes Clusters
      </Link>
    </CenteredCard>
  );
}

// useSearchParams() must live inside a <Suspense> boundary or `output: "export"`
// fails the build with "useSearchParams() should be wrapped in a suspense boundary".
function ClusterDetailFromQuery() {
  const searchParams = useSearchParams();
  const id = (searchParams.get("id") ?? "").trim();
  if (!id) return <NoClusterSelected />;
  return <ClusterDetailApp clusterId={id} />;
}

export default function ClusterPage() {
  return (
    <Suspense fallback={<Fallback />}>
      <ClusterDetailFromQuery />
    </Suspense>
  );
}
