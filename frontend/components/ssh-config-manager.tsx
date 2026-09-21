"use client";

// Master-data manager for reusable "global SSH configs": named jump host / tunnel profiles that a
// server's jump host or a database connection's SSH tunnel can reference by name instead of typing
// the bastion details inline. Create / edit / delete here; the dropdowns elsewhere read this list.

import { FormEvent, useEffect, useState } from "react";
import { KeyRound, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  createSshConfig,
  deleteSshConfig,
  getSshConfigs,
  updateSshConfig,
  type SshConfig,
  type SshConfigInput
} from "@/lib/api";
import { useConfirm } from "@/components/confirm-dialog";

const field =
  "h-11 w-full rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100";
const labelClass = "mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400";

export function SshConfigManager({ token }: { token: string }) {
  const { confirm, confirmDialog } = useConfirm();
  const [rows, setRows] = useState<SshConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SshConfig | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      setRows(await getSshConfigs(token));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load SSH configs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  async function remove(cfg: SshConfig) {
    const ok = await confirm({
      title: "Delete SSH config?",
      message: `“${cfg.name}” will be removed. Any server or database connection that references it falls back to a direct connection.`,
      confirmLabel: "Delete",
      danger: true
    });
    if (!ok) return;
    try {
      await deleteSshConfig(token, cfg.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the SSH config");
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Reusable jump host / tunnel profiles. Reference them from a server&apos;s jump host or a database connection&apos;s SSH tunnel.
        </p>
        <button
          type="button"
          onClick={() => { setCreating(true); setEditing(null); }}
          className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80"
        >
          <Plus size={16} /> New SSH config
        </button>
      </div>

      {error ? <p className="rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300">{error}</p> : null}

      <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
        {loading ? (
          <div className="flex items-center gap-2 px-6 py-8 text-sm text-slate-500 dark:text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="px-6 py-8 text-sm text-slate-500 dark:text-slate-400">
            No SSH configs yet. Create one to reuse a bastion across servers and databases.
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800/60">
            {rows.map((cfg) => (
              <li key={cfg.id} className="flex items-center gap-4 px-6 py-4">
                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <KeyRound size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-slate-900 dark:text-slate-100">{cfg.name}</div>
                  <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                    {cfg.username ? `${cfg.username}@` : ""}{cfg.host}:{cfg.port}
                    {" · "}
                    {cfg.has_private_key ? "key" : cfg.has_password ? "password" : "no stored credentials"}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { setEditing(cfg); setCreating(false); }}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-accent dark:hover:bg-slate-800"
                  aria-label={`Edit ${cfg.name}`}
                >
                  <Pencil size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(cfg)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-500 dark:hover:bg-slate-800"
                  aria-label={`Delete ${cfg.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(creating || editing) ? (
        <SshConfigDialog
          token={token}
          editing={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); void load(); }}
        />
      ) : null}
      {confirmDialog}
    </div>
  );
}

function SshConfigDialog({
  token,
  editing,
  onClose,
  onSaved
}: {
  token: string;
  editing: SshConfig | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState(String(editing?.port ?? 22));
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) return setError("Name cannot be empty.");
    if (!host.trim()) return setError("Host cannot be empty.");
    setSaving(true);
    setError("");
    try {
      const input: SshConfigInput = {
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        // write-only: a non-empty value sets/replaces; blank on an edit keeps the stored one.
        password,
        private_key: privateKey
      };
      if (editing) {
        // don't send empty secret fields on edit, so a blank keeps the stored credential
        const patch: Partial<SshConfigInput> = { name: input.name, host: input.host, port: input.port, username: input.username };
        if (password) patch.password = password;
        if (privateKey) patch.private_key = privateKey;
        await updateSshConfig(token, editing.id, patch);
      } else {
        await createSshConfig(token, input);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the SSH config");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-panel shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-panel px-5 py-4 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            <KeyRound size={18} className="text-accent" /> {editing ? "Edit SSH config" : "New SSH config"}
          </h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="grid gap-4 p-5">
          <div>
            <label className={labelClass}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. EMS bastion" className={field} />
          </div>
          <div className="grid grid-cols-[1fr,7rem] gap-3">
            <div>
              <label className={labelClass}>Host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="bastion.example" className={field} />
            </div>
            <div>
              <label className={labelClass}>Port</label>
              <input value={port} onChange={(e) => setPort(e.target.value)} type="number" min={1} max={65535} className={field} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ops" autoComplete="off" className={field} />
          </div>
          <div>
            <label className={labelClass}>Password <span className="font-normal normal-case text-slate-400">{editing?.has_password ? "(stored — blank keeps it)" : "(optional)"}</span></label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" placeholder={editing?.has_password ? "••••••••" : "optional"} className={field} />
          </div>
          <div>
            <label className={labelClass}>Private key <span className="font-normal normal-case text-slate-400">{editing?.has_private_key ? "(stored — blank keeps it)" : "(optional)"}</span></label>
            <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="optional — paste an OpenSSH private key" className={`${field} min-h-24 py-2`} />
          </div>
          {error ? <p className="text-xs font-medium text-danger dark:text-red-400">{error}</p> : null}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
            <button type="submit" disabled={saving} className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
              {saving ? <Loader2 size={16} className="animate-spin" /> : null}
              {editing ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
