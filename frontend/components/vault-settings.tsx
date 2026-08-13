"use client";

import { CheckCircle2, KeyRound, Loader2, Lock, Vault, XCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { getVaultConfig, saveVaultConfig, testVault, VaultConfigWrite } from "@/lib/api";

// Admin-only config screen for the HashiCorp Vault secrets backend. Mirrors the card styling of
// the Appearance page (rounded-3xl bg-surface ring-edge). The token is write-only: the field is
// left blank on load and only sent when the admin types a new one, so the value is never shown.
export function VaultSettings({ token }: { token: string }) {
  const [enabled, setEnabled] = useState(false);
  const [address, setAddress] = useState("");
  const [kvMount, setKvMount] = useState("secret");
  const [pathPrefix, setPathPrefix] = useState("inframonitor");
  const [tokenValue, setTokenValue] = useState("");
  const [tokenSet, setTokenSet] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const cfg = await getVaultConfig(token);
      setEnabled(cfg.enabled);
      setAddress(cfg.address);
      setKvMount(cfg.kv_mount);
      setPathPrefix(cfg.path_prefix);
      setTokenSet(cfg.token_set);
      setTokenValue("");
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Failed to load Vault settings" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // The token field carries the new token only when the admin typed one; empty means "unchanged".
  function payload(): VaultConfigWrite {
    return {
      enabled,
      address: address.trim(),
      kv_mount: kvMount.trim() || "secret",
      path_prefix: pathPrefix.trim() || "inframonitor",
      token: tokenValue,
    };
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const cfg = await saveVaultConfig(token, payload());
      setEnabled(cfg.enabled);
      setAddress(cfg.address);
      setKvMount(cfg.kv_mount);
      setPathPrefix(cfg.path_prefix);
      setTokenSet(cfg.token_set);
      setTokenValue("");
      setMessage({ ok: true, text: "Vault settings saved." });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Failed to save Vault settings" });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      const result = await testVault(token, payload());
      setMessage({ ok: result.ok, text: result.message });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Vault test failed" });
    } finally {
      setTesting(false);
    }
  }

  const inputClass =
    "h-12 w-full rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100";
  const labelClass = "mb-1.5 block text-sm font-medium text-muted";

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-3xl bg-surface px-6 py-8 text-sm text-muted shadow-sm ring-1 ring-edge">
        <Loader2 size={16} className="animate-spin" /> Loading Vault settings…
      </div>
    );
  }

  return (
    <form onSubmit={save} className="overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-edge">
      <div className="flex items-center gap-3 border-b border-edge bg-elevated px-6 py-4 font-semibold text-fg">
        <Vault size={18} className="text-accent" /> HashiCorp Vault
      </div>
      <div className="grid gap-6 p-6">
        <p className="text-sm text-muted">
          Store SSH credentials in HashiCorp Vault instead of the local encrypted database. When Vault is
          disabled (the default), credentials stay encrypted locally. Existing credentials keep working either way.
        </p>

        {/* Enable toggle */}
        <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-slate-100 px-4 py-3 dark:bg-slate-800/50">
          <span className="flex items-center gap-2 text-sm font-medium text-fg">
            <Lock size={16} className="text-accent" /> Use Vault as the secrets backend
          </span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-5 w-5 accent-[color:var(--inframonitor-accent)]"
          />
        </label>

        <div>
          <label className={labelClass}>Vault address</label>
          <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://vault.example.com:8200" className={inputClass} />
        </div>

        <div>
          <label className={labelClass}>
            Vault token
            {tokenSet && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                <KeyRound size={12} /> token set
              </span>
            )}
          </label>
          <input
            type="password"
            autoComplete="new-password"
            value={tokenValue}
            onChange={(event) => setTokenValue(event.target.value)}
            placeholder={tokenSet ? "Leave blank to keep the stored token" : "s.xxxxxxxxxxxxxxxxxxxx"}
            className={inputClass}
          />
          <p className="mt-1.5 text-xs text-muted">Write-only. The stored token is never shown; leave this blank to keep it.</p>
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <label className={labelClass}>KV v2 mount</label>
            <input value={kvMount} onChange={(event) => setKvMount(event.target.value)} placeholder="secret" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Path prefix</label>
            <input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} placeholder="inframonitor" className={inputClass} />
          </div>
        </div>

        <p className="text-xs text-muted">
          Secrets are written to <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-slate-800">{(kvMount.trim() || "secret")}/{(pathPrefix.trim() || "inframonitor")}/&lt;server-id&gt;</code> with fields <code className="font-mono">password</code> and <code className="font-mono">private_key</code>.
        </p>

        {message && (
          <div
            className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium ${
              message.ok
                ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300"
                : "bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300"
            }`}
          >
            {message.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
            <span className="break-words">{message.text}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-60"
          >
            {saving && <Loader2 size={16} className="animate-spin" />} Save
          </button>
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-slate-100 px-6 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            {testing && <Loader2 size={16} className="animate-spin" />} Test connection
          </button>
        </div>
      </div>
    </form>
  );
}
