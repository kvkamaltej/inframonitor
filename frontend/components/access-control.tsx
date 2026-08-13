"use client";

import { useEffect, useMemo, useState } from "react";
import { Info, ShieldCheck } from "lucide-react";
import { getRoleMenus, updateRoleMenus, RoleMenus } from "@/lib/api";

// Human-friendly labels for the fixed key vocabularies. Any key without an entry falls back to
// the raw key, so adding a new menu item on the backend never leaves a blank header.
const ITEM_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  servers: "Server Management",
  shell: "Shell",
  users: "Users",
  policies: "Server Policies",
  administration: "Administration",
  access: "Access Control",
  appearance: "Appearance",
  profile: "Profile",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  developer: "Developer",
  support: "Support",
  guest: "Guest",
};

function labelFor(map: Record<string, string>, key: string): string {
  return map[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

export function AccessControl({ token }: { token: string }) {
  const [data, setData] = useState<RoleMenus | null>(null);
  // The working copy the checkboxes edit: role -> Set of enabled item keys. Kept separate from
  // `data` so we can diff for the dirty flag and reset without a refetch.
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  function toDraft(matrix: Record<string, string[]>, roles: string[]): Record<string, Set<string>> {
    const next: Record<string, Set<string>> = {};
    for (const role of roles) next[role] = new Set(matrix[role] ?? []);
    return next;
  }

  async function load() {
    setLoading(true);
    try {
      const next = await getRoleMenus(token);
      setData(next);
      setDraft(toDraft(next.menus, next.roles));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load the access matrix");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const dirty = useMemo(() => {
    if (!data) return false;
    return data.roles.some((role) => {
      const saved = new Set(data.menus[role] ?? []);
      const current = draft[role] ?? new Set<string>();
      if (saved.size !== current.size) return true;
      for (const item of current) if (!saved.has(item)) return true;
      return false;
    });
  }, [data, draft]);

  function toggle(role: string, item: string) {
    setDraft((current) => {
      const next: Record<string, Set<string>> = {};
      for (const [key, value] of Object.entries(current)) next[key] = new Set(value);
      const set = next[role] ?? (next[role] = new Set<string>());
      if (set.has(item)) set.delete(item);
      else set.add(item);
      return next;
    });
    setMessage("");
  }

  async function save() {
    if (!data) return;
    setSaving(true);
    setMessage("");
    // Serialise in the fixed item order so the stored matrix stays tidy and deterministic.
    const payload: Record<string, string[]> = {};
    for (const role of data.roles) {
      const set = draft[role] ?? new Set<string>();
      payload[role] = data.items.filter((item) => set.has(item));
    }
    try {
      const next = await updateRoleMenus(token, payload);
      setData(next);
      setDraft(toDraft(next.menus, next.roles));
      setMessage("Saved. Users see the change the next time their session loads.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save the access matrix");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="px-6 py-6 text-sm font-medium text-muted">Loading access matrix…</div>;
  }
  if (!data) {
    return <div className="px-6 py-6 text-sm font-medium text-danger">{message || "Unable to load the access matrix."}</div>;
  }

  return (
    <div className="space-y-6 px-6 py-6">
      <div className="overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-edge">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge px-6 py-5">
          <div className="flex items-center gap-3">
            <ShieldCheck size={18} className="text-accent" />
            <div>
              <h2 className="text-base font-semibold text-fg">Menu Access by Role</h2>
              <p className="text-xs font-medium text-muted">Choose which sidebar entries each role sees.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDraft(toDraft(data.menus, data.roles))}
              disabled={!dirty || saving}
              className="inline-flex h-9 items-center justify-center rounded-full border border-edge px-4 text-sm font-semibold text-fg transition-colors hover:bg-page disabled:opacity-40"
            >
              Reset
            </button>
            <button
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="inline-flex h-9 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2 border-b border-edge bg-page/60 px-6 py-3 text-xs font-medium text-muted">
          <Info size={14} className="mt-0.5 shrink-0 text-accent" />
          <p>
            This controls sidebar visibility only. Access to each page is still enforced on the server by role, so a
            role shown an item it may not use will get an error on that page. Guest is the local desktop session.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-page text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-6 py-4 font-semibold">Menu item</th>
                {data.roles.map((role) => (
                  <th key={role} className="px-4 py-4 text-center font-semibold">{labelFor(ROLE_LABELS, role)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {data.items.map((item) => (
                <tr key={item} className="transition-colors hover:bg-page/60">
                  <td className="px-6 py-3 font-medium text-fg">{labelFor(ITEM_LABELS, item)}</td>
                  {data.roles.map((role) => {
                    const checked = draft[role]?.has(item) ?? false;
                    return (
                      <td key={role} className="px-4 py-3 text-center">
                        <label className="inline-flex cursor-pointer items-center justify-center">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(role, item)}
                            aria-label={`${labelFor(ROLE_LABELS, role)} can see ${labelFor(ITEM_LABELS, item)}`}
                            className="h-4 w-4 cursor-pointer accent-accent"
                          />
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {message ? <div className="border-t border-edge px-6 py-3 text-sm font-medium text-fg">{message}</div> : null}
      </div>
    </div>
  );
}
