"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ClipboardPaste,
  CornerDownLeft,
  Loader2,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  Star,
  Trash2,
  X
} from "lucide-react";
import { ShellFavorite, createShellFavorite, deleteShellFavorite, getShellFavorites, updateShellFavorite } from "@/lib/api";

export type ShellFavoritesProps = {
  token: string;
  // The Server.public_id of the terminal this panel is attached to, when known. Enables the
  // "this server only" scope and makes the list show global + this-server favorites (hiding ones
  // scoped to other servers). Omitted -> only global favorites can be created and all are shown.
  serverId?: string;
  // Insert is the default and never executes: the user presses Enter themselves, so a
  // mis-click cannot run something destructive.
  onInsert: (command: string) => void;
  // Optional explicit run. Rendered as a separate, armed two-step control when supplied.
  onRun?: (command: string) => void;
  // The active terminal's current selection, if the workspace has one. Used only to prefill
  // the form on an explicit click — xterm cannot read the live input line, so there is no
  // way to capture what the user is halfway through typing.
  selection?: string;
  onClose?: () => void;
  className?: string;
};

// Matches the backend cap. The server re-validates; this only stops a doomed request.
const COMMAND_LIMIT = 4000;

type FailureKind = "duplicate" | "toolong" | "auth" | "unknown";

type Failure = { kind: FailureKind; detail: string; name: string };

// FastAPI answers with {"detail": ...}. A 409 must read as a sentence, not as a JSON body,
// so unwrap it first — including the list form Pydantic emits for validation errors.
function detailText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const detail = (parsed as { detail?: unknown })?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          const msg = (item as { msg?: unknown })?.msg;
          return typeof msg === "string" ? msg : "";
        })
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
  } catch {
    // Not JSON after all — fall through and show the body as-is.
  }
  return trimmed;
}

function classify(error: unknown): { kind: FailureKind; detail: string } {
  const detail = detailText(error);
  const probe = detail.toLowerCase();
  const has = (...needles: string[]) => needles.some((needle) => probe.includes(needle));
  // The API client throws Error(responseBodyText) without the status, so 409 has to be
  // recognised from the body text.
  if (has("409", "already exists", "duplicate", "unique", "conflict")) return { kind: "duplicate", detail };
  if (has("at most", "too long", "4000", "max_length", "string_too_long")) return { kind: "toolong", detail };
  if (has("401", "not authenticated", "could not validate credentials", "invalid token", "expired")) {
    return { kind: "auth", detail };
  }
  return { kind: "unknown", detail };
}

function messageFor(failure: Failure): string {
  switch (failure.kind) {
    case "duplicate":
      return `You already have a favorite named “${failure.name}”. Names are unique per user — pick a different name, or delete the existing one first.`;
    case "toolong":
      return `That command is longer than the ${COMMAND_LIMIT}-character limit. Shorten it, or keep it in a script on the host and save the command that runs the script.`;
    case "auth":
      return "Your session has expired. Sign in again to save favorites.";
    default:
      return failure.detail || "Unable to save that favorite.";
  }
}

// Per-user saved commands. Clicking one inserts it into the active terminal; it does not run.
export function ShellFavorites({ token, serverId, onInsert, onRun, selection, onClose, className }: ShellFavoritesProps) {
  const [favorites, setFavorites] = useState<ShellFavorite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  // 0 = the form is creating a new favorite; a non-zero id = editing that favorite in place.
  const [editingId, setEditingId] = useState(0);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(0);
  const [filter, setFilter] = useState("");
  // Both destructive-ish controls are two-step, so a stray click cannot delete a favorite or
  // run a command. 0 means nothing is armed.
  const [armedRun, setArmedRun] = useState(0);
  const [armedDelete, setArmedDelete] = useState(0);
  // Scope for the SAVE form: "global" (every server) or "server" (this server only). Only offered
  // when a serverId is known.
  const [scope, setScope] = useState<"global" | "server">("global");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const rows = await getShellFavorites(token, serverId);
      // Server order is newest first; keep it rather than imposing another sort.
      setFavorites(rows);
    } catch (error) {
      const { kind, detail } = classify(error);
      setLoadError(kind === "auth" ? "Your session has expired. Sign in again to see your saved commands." : detail || "Unable to load your saved commands.");
    } finally {
      setLoading(false);
    }
  }, [token, serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const trimmedSelection = (selection ?? "").trim();

  function useSelection() {
    if (!trimmedSelection) return;
    setCommand(trimmedSelection.slice(0, COMMAND_LIMIT));
    setFormOpen(true);
    setFailure(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Snapshot everything before the await. Controlled inputs mean state is the source of
    // truth, and event.currentTarget is null the moment this handler yields.
    const nextName = name.trim();
    const nextCommand = command;
    if (!nextName || !nextCommand.trim()) {
      setFailure({ kind: "unknown", detail: "Give it a name and a command.", name: nextName });
      return;
    }
    if (nextCommand.length > COMMAND_LIMIT) {
      setFailure({ kind: "toolong", detail: "", name: nextName });
      return;
    }
    setSaving(true);
    setFailure(null);
    setNotice("");
    try {
      // "server" scope is only valid with a known server; fall back to global otherwise.
      const effScope: "global" | "server" = scope === "server" && serverId ? "server" : "global";
      const effServer = effScope === "server" ? (serverId ?? "") : "";
      if (editingId) {
        const updated = await updateShellFavorite(token, editingId, {
          name: nextName, command: nextCommand, scope: effScope, server_public_id: effServer
        });
        // a re-scoped favorite may now belong to a different server; drop it from the list if it no
        // longer matches the current view, else replace it in place.
        setFavorites((current) => {
          const stillVisible = updated.scope === "global" || !serverId || updated.server_public_id === serverId;
          return stillVisible
            ? current.map((row) => (row.id === updated.id ? updated : row))
            : current.filter((row) => row.id !== updated.id);
        });
        setNotice(`Updated “${updated.name}”.`);
      } else {
        const created = await createShellFavorite(token, nextName, nextCommand, effScope, effServer);
        setFavorites((current) => [created, ...current.filter((row) => row.id !== created.id)]);
        setNotice(`Saved “${created.name}”${effScope === "server" ? " for this server" : ""}.`);
      }
      setName("");
      setCommand("");
      setScope("global");
      setFormOpen(false);
      setEditingId(0);
    } catch (error) {
      const { kind, detail } = classify(error);
      setFailure({ kind, detail, name: nextName });
    } finally {
      setSaving(false);
    }
  }

  // Open the form prefilled to edit an existing favorite (rename and/or change its command).
  function edit(favorite: ShellFavorite) {
    setArmedRun(0);
    setArmedDelete(0);
    setFailure(null);
    setNotice("");
    setEditingId(favorite.id);
    setName(favorite.name);
    setCommand(favorite.command);
    setScope(favorite.scope === "server" ? "server" : "global");
    setFormOpen(true);
  }

  async function remove(favorite: ShellFavorite) {
    setFailure(null);
    setNotice("");
    setDeletingId(favorite.id);
    try {
      await deleteShellFavorite(token, favorite.id);
      setFavorites((current) => current.filter((row) => row.id !== favorite.id));
      setArmedDelete(0);
      setNotice(`Deleted “${favorite.name}”.`);
    } catch (error) {
      const { kind, detail } = classify(error);
      setFailure({ kind, detail: detail || `Unable to delete “${favorite.name}”.`, name: favorite.name });
    } finally {
      setDeletingId(0);
    }
  }

  function insert(favorite: ShellFavorite) {
    setArmedRun(0);
    setArmedDelete(0);
    setFailure(null);
    onInsert(favorite.command);
    setNotice(`Inserted “${favorite.name}” into the terminal. Press Enter to run it.`);
  }

  function confirmRun(favorite: ShellFavorite) {
    if (!onRun) return;
    setArmedRun(0);
    setFailure(null);
    onRun(favorite.command);
    setNotice(`Ran “${favorite.name}”.`);
  }

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? favorites.filter((row) => row.name.toLowerCase().includes(needle) || row.command.toLowerCase().includes(needle))
    : favorites;
  const remaining = COMMAND_LIMIT - command.length;

  return (
    // h-full covers a parent with a definite height; flex-1 with min-h-0 covers a flex parent
    // that stretches instead. The shell workspace does both, fullscreen and not.
    <div
      className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel dark:border-slate-700 dark:bg-slate-900 ${className ?? ""}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 dark:border-slate-700">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <Star size={17} className="shrink-0 text-accent" />
          <span className="truncate text-sm text-ink dark:text-slate-100">Saved commands</span>
          {favorites.length > 0 ? (
            <span className="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
              {favorites.length}
            </span>
          ) : null}
          {loading ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {trimmedSelection ? (
            <button
              type="button"
              onClick={useSelection}
              title={`Prefill from the terminal selection: ${trimmedSelection.slice(0, 120)}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              <ClipboardPaste size={14} /> Use selection
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setFormOpen((open) => {
                const next = !open;
                // Opening the toolbar button is always a NEW favorite, so shed any edit-in-progress
                // and clear the fields; closing just cancels.
                if (next) {
                  setEditingId(0);
                  setName("");
                  setCommand("");
                }
                return next;
              });
              setFailure(null);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent/80"
          >
            {formOpen ? <><X size={14} /> Cancel</> : <><Plus size={14} /> Save a command</>}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              title="Close the saved commands pane"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {formOpen ? (
        <form onSubmit={(event) => void save(event)} className="shrink-0 space-y-2 border-b border-line bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/40">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={128}
            spellCheck={false}
            placeholder="Name — e.g. tail catalina.out"
            className="h-9 w-full rounded-xl border-none bg-white px-3 text-xs font-medium text-slate-900 outline-none ring-1 ring-line transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-950 dark:text-slate-100 dark:ring-slate-700"
          />
          <textarea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="Command — typed or pasted here"
            className="w-full resize-y rounded-xl border-none bg-white px-3 py-2 font-mono text-xs text-slate-900 outline-none ring-1 ring-line transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-950 dark:text-slate-100 dark:ring-slate-700"
          />
          {serverId ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Scope</span>
              {(["global", "server"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setScope(opt)}
                  className={`inline-flex h-7 items-center rounded-full px-3 text-[11px] font-semibold transition-colors ${
                    scope === opt
                      ? "bg-accent text-white"
                      : "bg-white text-slate-600 ring-1 ring-line hover:text-accent dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-700"
                  }`}
                >
                  {opt === "global" ? "All servers" : "This server only"}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={saving || !name.trim() || !command.trim() || remaining < 0}
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : editingId ? <Pencil size={14} /> : <Save size={14} />}
              {saving ? "Saving…" : editingId ? "Update" : "Save"}
            </button>
            {remaining < 500 ? (
              <span className={`text-[11px] font-semibold ${remaining < 0 ? "text-danger dark:text-red-400" : "text-warn dark:text-amber-400"}`}>
                {remaining < 0 ? `${-remaining} over the ${COMMAND_LIMIT}-character limit` : `${remaining} characters left`}
              </span>
            ) : null}
            <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Stored verbatim, visible only to you. Type or paste the command — the terminal cannot read your current input
              line.
            </span>
          </div>
        </form>
      ) : null}

      {failure ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/40 bg-danger/5 px-4 py-2.5 dark:border-red-500/40 dark:bg-red-500/10">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-danger dark:text-red-400" />
          <p className="min-w-0 break-words text-xs font-medium text-danger dark:text-red-400">{messageFor(failure)}</p>
          <button
            type="button"
            onClick={() => setFailure(null)}
            className="ml-auto shrink-0 text-slate-400 transition-colors hover:text-ink dark:hover:text-slate-100"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-accent/40 bg-accent/5 px-4 py-2 dark:border-accent/40 dark:bg-accent/10">
          <p className="min-w-0 break-words text-xs font-medium text-slate-700 dark:text-slate-300">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="ml-auto shrink-0 text-slate-400 transition-colors hover:text-ink dark:hover:text-slate-100"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      {favorites.length > 6 ? (
        <label className="relative flex h-9 shrink-0 items-center border-b border-line px-3 dark:border-slate-700">
          <Search size={13} className="absolute left-5 text-slate-400 dark:text-slate-500" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
            placeholder="Filter saved commands"
            className="h-7 w-full rounded-full border-none bg-slate-100 pl-7 pr-3 text-xs font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/60 dark:text-slate-100"
          />
        </label>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loadError ? (
          <div className="space-y-2 px-4 py-4">
            <p className="break-words text-xs font-medium text-danger dark:text-red-400">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex h-7 items-center rounded-full bg-slate-100 px-3 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <p className="px-4 py-6 text-xs font-medium text-slate-500 dark:text-slate-400">Loading your saved commands…</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-xs font-medium text-slate-500 dark:text-slate-400">
            {needle
              ? `Nothing matches “${filter.trim()}”.`
              : "No saved commands yet. Save one to keep a long invocation handy across sessions — they are private to you."}
          </p>
        ) : (
          <ul className="divide-y divide-line dark:divide-slate-800">
            {visible.map((favorite) => (
              <li key={favorite.id} className="px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => insert(favorite)}
                    title="Insert into the active terminal — this does not run it"
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <CornerDownLeft size={12} className="shrink-0 text-accent" />
                      <span className="truncate text-xs font-semibold text-ink dark:text-slate-100">{favorite.name}</span>
                      {favorite.scope === "server" ? (
                        <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-accent" title="Visible only on this server">
                          this server
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block break-all font-mono text-[11px] leading-snug text-slate-500 line-clamp-2 dark:text-slate-400">
                      {favorite.command}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {onRun ? (
                      armedRun === favorite.id ? (
                        <button
                          type="button"
                          onClick={() => confirmRun(favorite)}
                          title="Send the command and a newline to the terminal now"
                          className="inline-flex h-7 items-center gap-1 rounded-full bg-warn px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-warn/80"
                        >
                          <Play size={11} /> Confirm run
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setArmedDelete(0);
                            setArmedRun(favorite.id);
                          }}
                          title="Run it — asks for confirmation first"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-warn/50 text-warn transition-colors hover:bg-warn/10 dark:border-amber-500/40 dark:text-amber-400"
                        >
                          <Play size={11} />
                        </button>
                      )
                    ) : null}
                    <button
                      type="button"
                      onClick={() => edit(favorite)}
                      title="Edit this favorite (rename or change the command)"
                      className={`inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
                        editingId === favorite.id
                          ? "bg-accent/15 text-accent"
                          : "text-slate-400 hover:bg-slate-100 hover:text-accent dark:text-slate-500 dark:hover:bg-slate-800"
                      }`}
                    >
                      <Pencil size={12} />
                    </button>
                    {armedDelete === favorite.id ? (
                      <button
                        type="button"
                        onClick={() => void remove(favorite)}
                        disabled={deletingId === favorite.id}
                        className="inline-flex h-7 items-center gap-1 rounded-full bg-danger px-2.5 text-[11px] font-semibold text-white transition-colors hover:bg-danger/80 disabled:opacity-50"
                      >
                        {deletingId === favorite.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        Confirm
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setArmedRun(0);
                          setArmedDelete(favorite.id);
                        }}
                        title="Delete this favorite"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-danger dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-red-400"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
                {armedRun === favorite.id ? (
                  <p className="mt-1 pl-5 text-[11px] font-medium text-warn dark:text-amber-400">
                    This sends the command and presses Enter for you. Insert it instead if you want to read it first.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="shrink-0 border-t border-line px-4 py-2 text-[11px] font-medium text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Clicking a command inserts it into the active terminal without running it — press Enter yourself.
        {onRun ? " The amber run button executes, and asks first." : ""}
      </p>
    </div>
  );
}
