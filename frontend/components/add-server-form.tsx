"use client";

import { Plus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { addServer, getOptions, OptionList } from "@/lib/api";

export function AddServerForm({ token, onAdded }: { token: string; onAdded: () => void }) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [options, setOptions] = useState<OptionList>({
    environments: ["production", "development", "testing", "qa"],
    server_types: ["application", "database", "web server", "repository", "tools", "other"],
    application_types: ["java", "python", "nodejs", "php", "go", "other"]
  });

  useEffect(() => {
    void getOptions(token).then(setOptions).catch(() => undefined);
  }, [token]);

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

    const payload = {
      hostname: String(form.get("hostname") ?? ""),
      ip_address: String(form.get("ip_address") ?? ""),
      username: String(form.get("username") ?? ""),
      ssh_port: Number(form.get("ssh_port") ?? 22),
      environment: String(form.get("environment") ?? "production"),
      server_type: String(form.get("server_type") ?? "application"),
      tags,
      password: String(form.get("password") ?? ""),
      private_key: String(form.get("private_key") ?? "")
    };

    try {
      await addServer(token, payload);
      setMessage("Server added. Discovery runs when credentials are provided.");
      onAdded();
      formElement.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to add server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-6">
      <input name="hostname" required placeholder="Hostname" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
      <input name="ip_address" required placeholder="IP address" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
      <input name="username" required placeholder="SSH user" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
      <input name="ssh_port" required type="number" min="1" max="65535" defaultValue="22" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
      <select name="environment" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100 capitalize">
        {options.environments.map((environment) => (
          <option key={environment} value={environment}>{environment}</option>
        ))}
      </select>
      <select name="server_type" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100 capitalize">
        {options.server_types.map((serverType) => (
          <option key={serverType} value={serverType}>{serverType}</option>
        ))}
      </select>
      <input name="password" type="password" placeholder="SSH password, optional" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100 md:col-span-3" />
      <input name="tags" placeholder="Tags, comma separated" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100 md:col-span-3" />
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
