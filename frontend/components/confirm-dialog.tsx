"use client";

import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // red confirm button for destructive actions
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (value: boolean) => void };

// Promise-based confirm that replaces window.confirm with an in-app dialog matching the rest
// of the UI. Usage:
//   const { confirm, confirmDialog } = useConfirm();
//   if (!(await confirm({ title: "Restart?", danger: true }))) return;
//   ...render {confirmDialog} once in the tree.
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    []
  );

  const settle = useCallback(
    (value: boolean) => {
      setPending((current) => {
        current?.resolve(value);
        return null;
      });
    },
    []
  );

  // Escape cancels, Enter confirms — a dialog you cannot dismiss from the keyboard is a poor one.
  useEffect(() => {
    if (!pending) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        settle(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, settle]);

  const confirmDialog = pending ? (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={() => settle(false)} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-panel shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start gap-3 p-5">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${pending.danger ? "bg-danger/10 text-danger dark:bg-red-500/15 dark:text-red-400" : "bg-accent/10 text-accent dark:bg-accent/20"}`}>
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{pending.title}</h2>
            {pending.message ? <p className="mt-1 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">{pending.message}</p> : null}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3 dark:border-slate-700">
          <button
            type="button"
            onClick={() => settle(false)}
            className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {pending.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => settle(true)}
            className={`h-10 rounded-full px-5 text-sm font-semibold text-white transition-colors ${pending.danger ? "bg-danger hover:bg-danger/80" : "bg-accent hover:bg-accent/80"}`}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmDialog };
}
