"use client";

import { Plus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { addServer, createFolder, getFolders, getOptions, Folder, OptionList } from "@/lib/api";
import { addressError } from "@/lib/address";

// Sentinel <select> value meaning "create a brand-new group from the typed name". Kept distinct
// from "" (Unassigned) and from any real folder id.
const NEW_GROUP = "__new__";

export function AddServerForm({ token, onAdded }: { token: string; onAdded: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<OptionList>({
    environments: ["production", "development", "testing", "qa"],
    server_types: ["application", "database", "web server", "repository", "tools", "other"],
    application_types: ["java", "python", "nodejs", "php", "go", "other"]
  });
  // Groups (folders) the new server can be created into. Hostname uniqueness is scoped to the
  // group, so picking a different group is how you add a second "DEV" without a 409 collision.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [groupChoice, setGroupChoice] = useState("");
  const [newGroupName, setNewGroupName] = useState("");

  useEffect(() => {
    void getOptions(token).then(setOptions).catch(() => undefined);
    void getFolders(token).then(setFolders).catch(() => undefined);
  }, [token]);

  // Turn the group control into a folder id for the payload, creating the folder if the user typed
  // a new name (reusing an existing folder of that name rather than 409ing on a duplicate). Returns
  // "" for Unassigned. Throws with a clear message if folder creation fails.
  async function resolveFolderId(): Promise<string> {
    if (groupChoice !== NEW_GROUP) return groupChoice; // "" (Unassigned) or an existing folder id
    const name = newGroupName.trim();
    if (!name) return "";
    const existing = folders.find((folder) => folder.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const created = await createFolder(token, name);
    setFolders((current) => [...current, created]);
    return created.id;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    // Capture the element before any await: React pools the event and currentTarget is
    // null by the time the request resolves.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const tags = String(form.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    const ipAddress = String(form.get("ip_address") ?? "");
    // Cheap local guard so a mistyped address is caught before a round-trip; the backend
    // re-checks and is the source of truth.
    const badAddress = addressError(ipAddress);
    if (badAddress) {
      setMessage(badAddress);
      setSaving(false);
      return;
    }

    if (groupChoice === NEW_GROUP && !newGroupName.trim()) {
      setMessage("Enter a name for the new group, or pick an existing one.");
      setSaving(false);
      return;
    }

    try {
      // folder_id (a group's id) scopes the hostname-uniqueness check, so the same hostname can
      // live in different groups. Empty string => Unassigned bucket.
      const folderId = await resolveFolderId();
      const payload = {
        hostname: String(form.get("hostname") ?? ""),
        ip_address: ipAddress,
        username: String(form.get("username") ?? ""),
        ssh_port: Number(form.get("ssh_port") ?? 22),
        environment: String(form.get("environment") ?? "production"),
        server_type: String(form.get("server_type") ?? "application"),
        tags,
        os_kind: String(form.get("os_kind") ?? "linux"),
        password: String(form.get("password") ?? ""),
        private_key: String(form.get("private_key") ?? ""),
        folder_id: folderId
      };
      await addServer(token, payload);
      setMessage("Server added. Discovery runs when credentials are provided.");
      onAdded();
      formElement.reset();
      setGroupChoice("");
      setNewGroupName("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add server");
    } finally {
      setSaving(false);
    }
  }

  const fieldClass =
    "h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100";

  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-6">
      <input name="hostname" required placeholder="Hostname" className={fieldClass} />
      <input name="ip_address" required placeholder="IP address" className={fieldClass} />
      <input name="username" required placeholder="SSH user" className={fieldClass} />
      <input name="ssh_port" required type="number" min="1" max="65535" defaultValue="22" className={fieldClass} />
      <select name="environment" className={`${fieldClass} capitalize`}>
        {options.environments.map((environment) => (
          <option key={environment} value={environment}>{environment}</option>
        ))}
      </select>
      <select name="server_type" className={`${fieldClass} capitalize`}>
        {options.server_types.map((serverType) => (
          <option key={serverType} value={serverType}>{serverType}</option>
        ))}
      </select>
      {/* OS kind decides which probe set runs (POSIX vs PowerShell). Not auto-detected. */}
      <select name="os_kind" defaultValue="linux" title="Operating system family" className={fieldClass}>
        <option value="linux">Linux / Unix</option>
        <option value="windows">Windows</option>
      </select>

      {/* Group: which bucket the server is created into. Hostname uniqueness is per-group, so this
          is how you add a second "DEV" — put it in a different (or brand-new) group. */}
      <label className="flex flex-col gap-1 md:col-span-3">
        <span className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Group</span>
        <select
          value={groupChoice}
          onChange={(event) => setGroupChoice(event.target.value)}
          className={fieldClass}
        >
          <option value="">Unassigned</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>{folder.name}</option>
          ))}
          <option value={NEW_GROUP}>＋ New group…</option>
        </select>
      </label>
      {groupChoice === NEW_GROUP ? (
        <input
          value={newGroupName}
          onChange={(event) => setNewGroupName(event.target.value)}
          placeholder="New group name"
          className={`${fieldClass} md:col-span-3`}
        />
      ) : (
        <div className="hidden md:col-span-3 md:block" />
      )}

      <input name="password" type="password" placeholder="SSH password, optional" className={`${fieldClass} md:col-span-3`} />
      <input name="tags" placeholder="Tags, comma separated" className={`${fieldClass} md:col-span-3`} />
      <textarea name="private_key" placeholder="SSH private key, optional" className="min-h-24 rounded-xl border-none bg-slate-100 px-4 py-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100 md:col-span-6" />
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 md:col-span-6">Credentials are used for connection test/discovery and container log operations. Leave them blank to add inventory only.</p>
      <div className="md:col-span-6 flex justify-end">
        <button disabled={saving} className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
          <Plus size={16} />
          {saving ? "Adding..." : "Add Server"}
        </button>
      </div>
      {message ? <p className="text-sm font-medium text-slate-700 dark:text-slate-300 md:col-span-6">{message}</p> : null}
    </form>
  );
}
