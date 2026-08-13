"use client";

import { AlertTriangle, CheckCircle2, Database, DatabaseZap, HardDrive, Loader2, RotateCcw, XCircle } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  AppDbConfig,
  AppDbConnectionRequest,
  getAppDatabase,
  migrateAppDatabase,
  resetAppDatabase,
  testAppDatabase,
  useAppDatabase,
} from "@/lib/api";
import { useConfirm } from "@/components/confirm-dialog";

// Admin-only config screen to switch Infra Monitor's OWN backing database from the built-in
// SQLite to an external PostgreSQL/MySQL. The switch is never live: "Migrate & switch" COPIES all
// data into the target and stores an override the app reads on its NEXT start. Card styling mirrors
// the Vault / Appearance pages (rounded-3xl bg-surface ring-edge). The password is write-only.
const DEFAULT_PORTS: Record<string, number> = { postgres: 5432, mysql: 3306 };

export function AppDatabaseSettings({ token }: { token: string }) {
  const [config, setConfig] = useState<AppDbConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [engine, setEngine] = useState<"postgres" | "mysql">("postgres");
  const [host, setHost] = useState("");
  const [port, setPort] = useState<string>("5432");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");

  const [testing, setTesting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [using, setUsing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Set after a successful migrate/reset: the running process keeps the old engine until restart.
  const [restartNotice, setRestartNotice] = useState<string | null>(null);

  const { confirm, confirmDialog } = useConfirm();

  async function load() {
    setLoading(true);
    try {
      setConfig(await getAppDatabase(token));
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Failed to load database settings" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Keep the port in step with the engine while the admin has not typed a custom one.
  function onEngineChange(next: "postgres" | "mysql") {
    setPort((current) => (current === "" || current === String(DEFAULT_PORTS[engine]) ? String(DEFAULT_PORTS[next]) : current));
    setEngine(next);
  }

  function payload(): AppDbConnectionRequest {
    return {
      engine,
      host: host.trim(),
      port: port.trim() ? Number(port) : DEFAULT_PORTS[engine],
      username: username.trim(),
      password,
      database: database.trim(),
    };
  }

  async function test() {
    setTesting(true);
    setMessage(null);
    try {
      const result = await testAppDatabase(token, payload());
      setMessage({ ok: result.ok, text: result.message });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function migrate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!host.trim()) {
      setMessage({ ok: false, text: "Host is required." });
      return;
    }
    const target = engine === "postgres" ? "PostgreSQL" : "MySQL";
    const ok = await confirm({
      title: `Migrate to ${target} and switch?`,
      message:
        `This copies ALL data — inventory, users, and encrypted credentials — into the target ${target} database ` +
        `at ${host.trim()}:${port.trim() || DEFAULT_PORTS[engine]}.\n\n` +
        "Your existing SQLite data is copied, not moved, so nothing is deleted. After the copy succeeds, the app " +
        "switches to the new database — but only on the NEXT restart. Restart the app to apply.",
      confirmLabel: "Migrate & switch",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    setMigrating(true);
    setMessage(null);
    setRestartNotice(null);
    try {
      const result = await migrateAppDatabase(token, payload());
      const copied = Object.values(result.tables ?? {}).reduce((sum, n) => sum + n, 0);
      setMessage({ ok: true, text: `${result.message} (${copied} rows total)` });
      setRestartNotice("Migration complete. Restart the app to start using the new database.");
      setPassword("");
      await load();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Migration failed" });
    } finally {
      setMigrating(false);
    }
  }

  async function useExisting() {
    if (!host.trim()) {
      setMessage({ ok: false, text: "Host is required." });
      return;
    }
    const target = engine === "postgres" ? "PostgreSQL" : "MySQL";
    const ok = await confirm({
      title: `Use the existing ${target} database?`,
      message:
        `Point the app at ${host.trim()}:${port.trim() || DEFAULT_PORTS[engine]} WITHOUT copying anything.\n\n` +
        "Use this when the target already holds Infra Monitor's data (a previous migration or a shared database). " +
        "Its existing data is kept; nothing is overwritten. Takes effect on the NEXT restart.",
      confirmLabel: "Use this database",
      cancelLabel: "Cancel",
    });
    if (!ok) return;
    setUsing(true);
    setMessage(null);
    setRestartNotice(null);
    try {
      const result = await useAppDatabase(token, payload());
      setMessage({ ok: true, text: result.message });
      setRestartNotice("Configured. Restart the app to start using this database.");
      setPassword("");
      await load();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Unable to switch database" });
    } finally {
      setUsing(false);
    }
  }

  async function reset() {
    const ok = await confirm({
      title: "Revert to built-in SQLite?",
      message:
        "This removes the external-database override so the app uses its built-in SQLite database again on the " +
        "NEXT restart. No data is copied back — anything written to the external database since the switch will " +
        "not be in the SQLite file.",
      confirmLabel: "Revert to SQLite",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;

    setResetting(true);
    setMessage(null);
    setRestartNotice(null);
    try {
      const result = await resetAppDatabase(token);
      setMessage({ ok: true, text: result.message });
      if (result.restart_required) setRestartNotice("Reverted to SQLite. Restart the app to apply.");
      await load();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : "Reset failed" });
    } finally {
      setResetting(false);
    }
  }

  const inputClass =
    "h-12 w-full rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100";
  const labelClass = "mb-1.5 block text-sm font-medium text-muted";
  const busy = testing || migrating || using || resetting;

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-3xl bg-surface px-6 py-8 text-sm text-muted shadow-sm ring-1 ring-edge">
        <Loader2 size={16} className="animate-spin" /> Loading database settings…
      </div>
    );
  }

  const isExternal = config ? config.is_override : false;

  return (
    <div className="grid gap-6">
      {/* Current backend card */}
      <div className="overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge bg-elevated px-6 py-4 font-semibold text-fg">
          <HardDrive size={18} className="text-accent" /> Current backing database
        </div>
        <div className="grid gap-2 p-6">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
                isExternal
                  ? "bg-accent/10 text-accent dark:bg-accent/20"
                  : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              }`}
            >
              <Database size={13} /> {config?.backend ?? "Unknown"}
              {isExternal ? " (override active)" : " (built-in)"}
            </span>
          </div>
          <code className="mt-1 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {config?.url_masked}
          </code>
          {isExternal ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void reset()}
                disabled={busy}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-slate-100 px-5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {resetting ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />} Revert to built-in SQLite
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Migrate form */}
      <form onSubmit={migrate} className="overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge bg-elevated px-6 py-4 font-semibold text-fg">
          <DatabaseZap size={18} className="text-accent" /> Switch to an external database
        </div>
        <div className="grid gap-6 p-6">
          <p className="text-sm text-muted">
            Move Infra Monitor&apos;s own data onto an external PostgreSQL or MySQL server. The migration copies
            everything — inventory, users, and encrypted credentials — into the target and switches the app to it on the
            next restart. Your SQLite data is copied, never deleted.
          </p>

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <label className={labelClass}>Engine</label>
              <select value={engine} onChange={(event) => onEngineChange(event.target.value as "postgres" | "mysql")} className={inputClass}>
                <option value="postgres">PostgreSQL</option>
                <option value="mysql">MySQL</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Port</label>
              <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder={String(DEFAULT_PORTS[engine])} className={inputClass} />
            </div>
          </div>

          <div>
            <label className={labelClass}>Host</label>
            <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="db.example.com" className={inputClass} />
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <label className={labelClass}>Username</label>
              <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="inframonitor" autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="••••••••" className={inputClass} />
            </div>
          </div>

          <div>
            <label className={labelClass}>Database name</label>
            <input value={database} onChange={(event) => setDatabase(event.target.value)} placeholder="inframonitor" className={inputClass} />
          </div>

          {restartNotice && (
            <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{restartNotice}</span>
            </div>
          )}

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
              disabled={busy}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-60"
            >
              {migrating ? <Loader2 size={16} className="animate-spin" /> : <DatabaseZap size={16} />} Migrate &amp; switch
            </button>
            <button
              type="button"
              onClick={() => void useExisting()}
              disabled={busy}
              title="Point at a database that already holds Infra Monitor's data — no copy"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-accent px-6 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-60"
            >
              {using ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />} Use existing (no migrate)
            </button>
            <button
              type="button"
              onClick={() => void test()}
              disabled={busy}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-slate-100 px-6 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-60 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {testing && <Loader2 size={16} className="animate-spin" />} Test connection
            </button>
          </div>
        </div>
      </form>
      {confirmDialog}
    </div>
  );
}
