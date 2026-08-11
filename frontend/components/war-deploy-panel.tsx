"use client";

import { ChangeEvent, FormEvent, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Lock, PackageCheck, Upload } from "lucide-react";
import { deployWar, tomcatAction, TomcatInstance, WarDeployResult } from "@/lib/api";

export type WarDeployPanelProps = {
  token: string;
  serverId: string;
  instances: TomcatInstance[];
  onDeployed?: () => void | Promise<void>;
};

// Which operation the open sudo prompt will retry. The distinction matters: a deploy retry
// re-sends the WAR body, a restart retry must not, because the WAR is already on the host.
type PendingSudo = { kind: "deploy" } | { kind: "restart"; instance: string };

type Busy = "" | "deploy" | "restart";

function formatBytes(value: string | number | undefined) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

// Mirrors the backend's mandatory checks so an obviously bad name fails before we spend
// minutes uploading. The backend re-validates; this is convenience, not the security gate.
function filenameProblem(name: string) {
  if (!name) return "Choose a .war file, or type a target filename.";
  if (name.includes("/") || name.includes("\\")) return "The target filename must be a bare filename with no path separators.";
  if (name.includes("..")) return "The target filename may not contain '..'.";
  if (name.indexOf(String.fromCharCode(0)) !== -1) return "The target filename contains a null byte.";
  if (!name.toLowerCase().endsWith(".war")) return "The target filename must end in .war.";
  return "";
}

export function WarDeployPanel({ token, serverId, instances, onDeployed }: WarDeployPanelProps) {
  const [instanceName, setInstanceName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [filenameOverride, setFilenameOverride] = useState("");
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState<Busy>("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState<WarDeployResult | null>(null);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [pendingSudo, setPendingSudo] = useState<PendingSudo | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const selected = instances.find((instance) => instance.name === instanceName) ?? null;
  const webapps = selected?.webapps ?? [];
  const targetName = (filenameOverride.trim() || file?.name || "").trim();
  const targetBase = targetName.toLowerCase().endsWith(".war") ? targetName.slice(0, -4) : targetName;
  const collision = targetName ? webapps.find((webapp) => webapp.name === targetName) ?? null : null;
  const explodedDir = targetBase ? webapps.find((webapp) => webapp.type === "dir" && webapp.name === targetBase) ?? null : null;
  const targetDir = selected?.catalina_base ? `${selected.catalina_base}/webapps` : "";

  // Keep the selector pointed at a real instance as the probe results come and go.
  useEffect(() => {
    if (instances.length === 0) {
      if (instanceName) setInstanceName("");
      return;
    }
    if (!instances.some((instance) => instance.name === instanceName)) setInstanceName(instances[0].name);
  }, [instances, instanceName]);

  // A multi-hundred-megabyte WAR takes a while and fetch() gives no upload progress
  // events, so show honest elapsed time rather than a fabricated percentage.
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  function resetChoice() {
    if (fileInput.current) fileInput.current.value = "";
    setFile(null);
    setFilenameOverride("");
    setAwaitingConfirm(false);
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>) {
    // Read the input synchronously: this handler must never await before touching the event.
    const next = event.currentTarget.files?.[0] ?? null;
    setFile(next);
    setResult(null);
    setError("");
    setAwaitingConfirm(false);
    setPendingSudo(null);
  }

  function begin() {
    setError("");
    setResult(null);
    setPendingSudo(null);
    if (!selected) {
      setError("Select a Tomcat instance first.");
      return;
    }
    if (!file) {
      setError("Choose a .war file to upload.");
      return;
    }
    const problem = filenameProblem(targetName);
    if (problem) {
      setError(problem);
      return;
    }
    if ((collision || explodedDir) && !awaitingConfirm) {
      setAwaitingConfirm(true);
      return;
    }
    setAwaitingConfirm(false);
    void runDeploy("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    begin();
  }

  async function runDeploy(sudoPasswordValue: string) {
    // Snapshot every field before the await so nothing is re-read from state or the DOM
    // once the promise yields.
    const instance = instanceName;
    const warFile = file;
    const override = filenameOverride.trim();
    const wantRestart = restart;
    if (!instance || !warFile) return;
    setBusy("deploy");
    setError("");
    // The user has committed; drop the confirmation box so it cannot sit next to an error
    // or a sudo prompt afterwards.
    setAwaitingConfirm(false);
    try {
      const outcome = await deployWar(token, serverId, {
        instance,
        file: warFile,
        filename: override || undefined,
        restart: wantRestart,
        sudo_password: sudoPasswordValue || undefined
      });
      // The backend answers HTTP 200 with ok:false on an SSH-level failure, so the body
      // is the only thing that says whether this worked.
      if (!outcome.ok && outcome.needs_sudo_password) {
        // Nothing landed on the host: the retry has to send the file again.
        setResult(null);
        setPendingSudo({ kind: "deploy" });
        setError(outcome.message || `Sudo password required to write into ${targetDir || "the webapps directory"}.`);
        return;
      }
      if (!outcome.ok) {
        setResult(null);
        setPendingSudo(null);
        setError(outcome.message || "Deployment failed.");
        return;
      }
      setResult(outcome);
      if (wantRestart && !outcome.restarted && outcome.needs_sudo_password) {
        // The WAR is in place. Retry the restart alone — re-uploading would be pointless
        // and would re-run the backup.
        setPendingSudo({ kind: "restart", instance });
        setError(outcome.message || `The WAR deployed. A sudo password is required to restart ${instance}.`);
        return;
      }
      setPendingSudo(null);
      resetChoice();
      if (onDeployed) await onDeployed();
    } catch (caught) {
      setResult(null);
      setPendingSudo(null);
      setError(caught instanceof Error ? caught.message : "Deployment failed.");
    } finally {
      setBusy("");
    }
  }

  // Restart-only path. Never touches `file`.
  async function runRestart(sudoPasswordValue: string) {
    const instance = pendingSudo?.kind === "restart" ? pendingSudo.instance : instanceName;
    if (!instance) return;
    setBusy("restart");
    setError("");
    try {
      const outcome = await tomcatAction(token, serverId, { instance, action: "restart", sudo_password: sudoPasswordValue });
      if (outcome.needs_sudo_password) {
        setPendingSudo({ kind: "restart", instance });
        setError(outcome.message || `Sudo password required to restart ${instance}.`);
        return;
      }
      if (!outcome.ok) {
        setPendingSudo(null);
        setError(outcome.message || outcome.output || `Unable to restart ${instance}.`);
        return;
      }
      setPendingSudo(null);
      setResult((current) => (current ? { ...current, restarted: true, needs_sudo_password: false } : current));
      resetChoice();
      if (onDeployed) await onDeployed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to restart ${instance}.`);
    } finally {
      setBusy("");
    }
  }

  async function submitSudo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pending = pendingSudo;
    const password = sudoPassword;
    if (!pending || !password) return;
    setSudoPassword("");
    if (pending.kind === "deploy") await runDeploy(password);
    else await runRestart(password);
  }

  function cancelSudo() {
    setPendingSudo(null);
    setSudoPassword("");
  }

  const disabled = busy !== "" || !selected || !file;

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Instance
          <select
            value={instanceName}
            onChange={(event) => {
              setInstanceName(event.target.value);
              setAwaitingConfirm(false);
              setResult(null);
              setError("");
              setPendingSudo(null);
            }}
            disabled={busy !== "" || instances.length === 0}
            className="h-10 cursor-pointer rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent disabled:opacity-50 dark:bg-slate-800/50 dark:text-slate-100"
          >
            {instances.length === 0 ? <option value="">No instances discovered</option> : null}
            {instances.map((instance) => (
              <option key={instance.name} value={instance.name}>{instance.name}</option>
            ))}
          </select>
        </label>

        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Target filename (optional)
          <input
            value={filenameOverride}
            onChange={(event) => {
              setFilenameOverride(event.target.value);
              setAwaitingConfirm(false);
              setError("");
            }}
            disabled={busy !== ""}
            spellCheck={false}
            placeholder={file?.name || "myapp.war"}
            className="h-10 rounded-xl border-none bg-slate-100 px-4 font-mono text-sm text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent disabled:opacity-50 dark:bg-slate-800/50 dark:text-slate-100"
          />
        </label>

        <div className="md:col-span-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold text-ink transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
            <Upload size={16} />
            Choose WAR file
            <input ref={fileInput} type="file" accept=".war" onChange={pickFile} disabled={busy !== ""} className="hidden" />
          </label>
          {file ? (
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              <span className="font-mono font-semibold text-ink dark:text-slate-200">{file.name}</span>
              {formatBytes(file.size) ? ` · ${formatBytes(file.size)}` : ""}
            </span>
          ) : (
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">No file chosen</span>
          )}
        </div>

        <label className="md:col-span-2 inline-flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={restart}
            onChange={(event) => setRestart(event.target.checked)}
            disabled={busy !== ""}
            className="h-4 w-4 accent-accent"
          />
          Restart the instance after deploy
        </label>

        {targetDir ? (
          <p className="md:col-span-2 break-all text-xs font-medium text-slate-500 dark:text-slate-400">
            Target: <code className="font-mono font-semibold text-ink dark:text-slate-200">{targetDir}/{targetName || "…"}</code>
          </p>
        ) : null}

        <div className="md:col-span-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={disabled}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            <PackageCheck size={16} />
            {busy === "deploy" ? "Uploading…" : busy === "restart" ? "Restarting…" : awaitingConfirm ? "Review the overwrite below" : "Deploy WAR"}
          </button>
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Uploaded over SFTP. Any existing file at the target is backed up first.
          </span>
        </div>
      </form>

      {busy ? (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 dark:border-accent/40 dark:bg-accent/10">
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p className="text-sm font-semibold text-ink dark:text-slate-100">
              {busy === "deploy"
                ? `Uploading ${file?.name ?? "WAR"}${formatBytes(file?.size) ? ` (${formatBytes(file?.size)})` : ""} to ${instanceName}…`
                : `Restarting ${instanceName}…`}
            </p>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-accent/20">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
          <p className="mt-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            {elapsed}s elapsed. Do not close this page — a large WAR can take several minutes and the browser reports no
            byte-level progress for the upload.
          </p>
        </div>
      ) : null}

      {awaitingConfirm && !busy ? (
        <div className="rounded-2xl border border-warn/50 bg-warn/5 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn dark:text-amber-400" />
            <div className="space-y-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              <p className="text-sm font-semibold text-warn dark:text-amber-400">
                {collision ? `${targetName} already exists in ${instanceName}` : `An exploded ${targetBase} directory already exists in ${instanceName}`}
              </p>
              {collision ? (
                <p>
                  The existing file (<span className="font-mono">{collision.path || `${targetDir}/${collision.name}`}</span>
                  {formatBytes(collision.size_bytes) ? `, ${formatBytes(collision.size_bytes)}` : ""}
                  {collision.modified ? `, modified ${collision.modified}` : ""}) will be renamed to{" "}
                  <span className="font-mono">{collision.name}.bak-&lt;timestamp&gt;</span> before the new WAR is moved into
                  place. Roll back by moving that file back.
                </p>
              ) : null}
              {explodedDir ? (
                <p>
                  Tomcat&apos;s exploded directory <span className="font-mono">{explodedDir.path || `${targetDir}/${explodedDir.name}`}</span>{" "}
                  is <strong className="font-semibold">not</strong> backed up or removed by this upload. Tomcat replaces it on
                  redeploy only if it is configured to unpack WARs; otherwise delete it yourself.
                </p>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runDeploy("")}
              className="inline-flex h-10 items-center justify-center rounded-full bg-warn px-5 text-sm font-semibold text-white transition-colors hover:bg-warn/80"
            >
              Overwrite and deploy
            </button>
            <button
              type="button"
              onClick={() => setAwaitingConfirm(false)}
              className="inline-flex h-10 items-center justify-center rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-danger/40 bg-danger/5 p-4 dark:border-red-500/40 dark:bg-red-500/10">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger dark:text-red-400" />
          <p className="break-words text-sm font-medium text-danger dark:text-red-400">{error}</p>
        </div>
      ) : null}

      {pendingSudo && !busy ? (
        <form onSubmit={(event) => void submitSudo(event)} className="rounded-2xl border border-line bg-panel p-4 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex items-center gap-2 font-semibold text-accent">
            <Lock size={18} />
            <span className="text-slate-900 dark:text-slate-100">Sudo password required</span>
          </div>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {pendingSudo.kind === "deploy"
              ? `The SSH user cannot write into ${targetDir || "the webapps directory"}. Confirm to upload ${targetName} again with sudo.`
              : `${targetName || "The WAR"} is already deployed. Confirm to restart ${pendingSudo.instance} only — the file will not be uploaded again.`}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={sudoPassword}
              onChange={(event) => setSudoPassword(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Sudo password"
              className="h-10 min-w-[14rem] flex-1 border border-line px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={!sudoPassword}
              className="h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              {pendingSudo.kind === "deploy" ? "Authenticate and re-upload" : "Authenticate and restart"}
            </button>
            <button
              type="button"
              onClick={cancelSudo}
              className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Sent once with this request over SSH stdin, then discarded. Never stored in the browser.
          </p>
        </form>
      ) : null}

      {result && result.ok ? (
        <div className="rounded-2xl border border-accent/40 bg-accent/5 p-4 dark:border-accent/40 dark:bg-accent/10">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent" />
            <div className="space-y-1 text-xs font-medium text-slate-700 dark:text-slate-300">
              <p className="text-sm font-semibold text-ink dark:text-slate-100">{result.message || "WAR deployed"}</p>
              <p className="break-all">Deployed to <span className="font-mono">{result.target_path}</span></p>
              <p>Wrote {formatBytes(result.bytes_written) || `${result.bytes_written} bytes`}</p>
              {result.backup_path ? (
                <p className="break-all">
                  Previous file backed up to <span className="font-mono">{result.backup_path}</span> — move it back to roll
                  back.
                </p>
              ) : (
                <p>No existing file at the target, so nothing was backed up.</p>
              )}
              <p>{result.restarted ? "The instance was restarted." : "The instance was not restarted."}</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
