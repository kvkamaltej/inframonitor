const styles: Record<string, { pill: string; dot: string }> = {
  healthy: {
    pill: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
    dot: "bg-emerald-500"
  },
  warning: {
    pill: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    dot: "bg-amber-500"
  },
  critical: {
    pill: "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
    dot: "bg-red-500"
  },
  offline: {
    pill: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-600/40 dark:bg-zinc-500/10 dark:text-zinc-300",
    dot: "bg-zinc-400"
  },
  unknown: {
    pill: "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-600/40 dark:bg-slate-500/10 dark:text-slate-300",
    dot: "bg-slate-400"
  }
};

export function StatusPill({ status }: { status: string }) {
  const style = styles[status] ?? styles.unknown;
  // A live host pulses; a settled one does not, so the eye is drawn to what is running.
  const live = status === "healthy";
  return (
    <span className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold capitalize ${style.pill}`}>
      <span className="relative flex h-2 w-2">
        {live ? <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${style.dot}`} /> : null}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${style.dot}`} />
      </span>
      {status}
    </span>
  );
}
