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
  // When set, the confirm button stays disabled until the operator types this exact phrase
  // (case-sensitive). Used to gate irreversible destructive actions — e.g. deleting a server
  // requires typing its hostname — so a stray Enter or misclick can never trigger them.
  requirePhrase?: string;
};

type Pending = ConfirmOptions & { resolve: (value: boolean) => void };

// Promise-based confirm that replaces window.confirm with an in-app dialog matching the rest
// of the UI. Usage:
//   const { confirm, confirmDialog } = useConfirm();
//   if (!(await confirm({ title: "Restart?", danger: true }))) return;
//   // typed-phrase gate:
//   if (!(await confirm({ title: "Delete host?", danger: true, requirePhrase: server.hostname }))) return;
//   ...render {confirmDialog} once in the tree.
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  // The live text in the typed-confirmation field. Reset every time a new dialog opens so a
  // previously typed phrase can never carry over and pre-satisfy the next gate.
  const [typed, setTyped] = useState("");

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => {
      setTyped("");
      setPending({ ...options, resolve });
    }),
    []
  );

  const settle = useCallback(
    (value: boolean) => {
      setPending((current) => {
        current?.resolve(value);
        return null;
      });
      setTyped("");
    },
    []
  );

  // The typed phrase (if any) must match exactly before a confirm is allowed. With no phrase
  // required this is always satisfied, preserving the plain confirm behaviour.
  const phraseSatisfied = !pending?.requirePhrase || typed === pending.requirePhrase;

  // Escape cancels, Enter confirms — a dialog you cannot dismiss from the keyboard is a poor one.
  // Enter only confirms once the typed-phrase gate (when present) is satisfied.
  useEffect(() => {
    if (!pending) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        settle(false);
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (phraseSatisfied) settle(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, settle, phraseSatisfied]);

  const confirmDialog = pending ? (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={() => settle(false)} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-panel shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-start gap-3 p-5">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${pending.danger ? "bg-danger/10 text-danger dark:bg-red-500/15 dark:text-red-400" : "bg-accent/10 text-accent dark:bg-accent/20"}`}>
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{pending.title}</h2>
            {pending.message ? <p className="mt-1 whitespace-pre-line text-sm text-slate-600 dark:text-slate-300">{pending.message}</p> : null}
            {pending.requirePhrase ? (
              <div className="mt-3">
                <label htmlFor="confirm-phrase" className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Type <span className="font-semibold text-slate-900 dark:text-slate-100">{pending.requirePhrase}</span> to confirm
                </label>
                <input
                  id="confirm-phrase"
                  autoFocus
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={pending.requirePhrase}
                  className="mt-1.5 h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-danger/50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
              </div>
            ) : null}
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
            autoFocus={!pending.requirePhrase}
            disabled={!phraseSatisfied}
            onClick={() => settle(true)}
            className={`h-10 rounded-full px-5 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${pending.danger ? "bg-danger hover:bg-danger/80" : "bg-accent hover:bg-accent/80"}`}
          >
            {pending.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, confirmDialog };
}
