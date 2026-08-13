"use client";

import Link from "next/link";
import { Activity, AlertTriangle, ArrowLeft, Boxes, Check, Clock, Coffee, Copy, Cpu, Database, FileText, Folder as FolderIcon, Gauge, HardDrive, Info as InfoIcon, KeyRound, LayoutGrid, ListChecks, Loader2, Lock, MemoryStick, MonitorCog, MoreVertical, Network, Package, Pencil, RefreshCw, ServerCog, Terminal, Trash2, Upload, X } from "lucide-react";
import { Fragment, FormEvent, useEffect, useRef, useState } from "react";
import {
  assignServerFolder,
  ContainerInfo,
  deleteServer,
  discoverServer,
  refreshVitals,
  Folder,
  getContainerEnv,
  getContainerLogs,
  getContainers,
  getFolders,
  getMe,
  getServer,
  getServiceLogs,
  getTomcatInstances,
  getTomcatLogs,
  Me,
  PrivilegedResult,
  restartContainer,
  restartService,
  saveCredentials,
  Server,
  tomcatAction,
  TomcatInstance,
  TomcatLogFile,
  TomcatPrerequisite,
  TomcatWebapp,
  updateServer,
  ServerUpdate
} from "@/lib/api";
import { addressError } from "@/lib/address";
import { DefaultPasswordBanner } from "@/components/app-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { LoginPanel } from "@/components/login-panel";
import { ShellPanel } from "@/components/shell-panel";
import { StatusPill } from "@/components/status-pill";
import { StorageChart } from "@/components/storage-chart";
import { Sidebar } from "@/components/sidebar";
import { WarDeployPanel } from "@/components/war-deploy-panel";

type Tab = "overview" | "storage" | "services" | "tomcat" | "containers" | "databaseLogs" | "logs";
type Credentials = { password: string; private_key: string; tail?: number };
type Tone = "info" | "error";
type PendingSudo = { kind: "tomcat"; instance: string; action: string } | { kind: "service"; name: string };

export function ServerDetailApp({ serverId }: { serverId: string }) {
  const [token, setToken] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [server, setServer] = useState<Server | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [credentials, setCredentials] = useState<Credentials>({ password: "", private_key: "" });
  const [runtime, setRuntime] = useState("docker");
  const [tail, setTail] = useState(200);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [tomcat, setTomcat] = useState<TomcatInstance[] | null>(null);
  const [logPicker, setLogPicker] = useState("");
  const [detailPicker, setDetailPicker] = useState("");
  const [pendingSudo, setPendingSudo] = useState<PendingSudo | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");
  const [selected, setSelected] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<Tone>("info");
  // Which action is in flight ("" = idle). `loading` stays derived so every existing
  // `disabled={loading}` still serialises SSH ops, while a spinner can show on the one
  // button the operator actually clicked.
  const [busy, setBusy] = useState("");
  const loading = busy !== "";
  const [initializing, setInitializing] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [logsCopied, setLogsCopied] = useState(false);
  // Admin actions moved from a persistent sidebar into a "…" menu in the header, so the tab
  // content gets the full width and the occasional admin action is one click away.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Container name whose interactive shell is open ("" = none). Opens a host PTY that auto-runs
  // `<runtime> exec -it <name> sh` so the operator lands inside the container.
  const [containerShellFor, setContainerShellFor] = useState("");
  // Whether the host shell workspace (a plain PTY on this server) is open, and whether it should
  // open in fullscreen (true only when launched via the ?shell=1 deep-link, e.g. the sidebar).
  const [hostShellOpen, setHostShellOpen] = useState(false);
  const [hostShellFullscreen, setHostShellFullscreen] = useState(false);
  // EXPERIMENTAL (feature/server-folders): folders offered in the admin folder-assignment select.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderBusy, setFolderBusy] = useState(false);

  const { confirm, confirmDialog } = useConfirm();
  const isAdmin = me?.role === "admin";
  const canRestartContainer = me?.role === "admin" || me?.role === "developer";
  const tomcatRows = tomcat ?? server?.tomcat ?? [];

  // Capability detection drives which tabs exist. Each falls back to the discovered
  // service list, so a host with the software installed but no log file / no live probe
  // yet still gets its tab.
  const discovered = server?.discovered_services ?? [];
  const hasTomcat = tomcatRows.length > 0 || discovered.some((s) => (s.name ?? "").toLowerCase().startsWith("tomcat"));
  const hasContainerRuntime = Boolean(server?.docker_version || server?.podman_version) || discovered.some((s) => s.type === "container");
  const hasDatabase = (server?.database_logs?.length ?? 0) > 0 || discovered.some((s) => s.type === "database");

  // A tab that disappears (e.g. discovery finds no database) must not stay selected,
  // or the panel area renders empty with no way back.
  useEffect(() => {
    if (tab === "tomcat" && !hasTomcat) setTab("overview");
    if (tab === "containers" && !hasContainerRuntime) setTab("overview");
    if (tab === "databaseLogs" && !hasDatabase) setTab("overview");
  }, [tab, hasTomcat, hasContainerRuntime, hasDatabase]);

  // Load containers the moment the tab is opened rather than making the operator press Load —
  // opening the tab is the request. Guarded so it fires once per server: a load returning zero
  // containers must not re-fire, and switching away and back should not re-probe over SSH.
  const [containersAutoLoaded, setContainersAutoLoaded] = useState(false);
  useEffect(() => setContainersAutoLoaded(false), [serverId]);
  useEffect(() => {
    if (tab === "containers" && !containersAutoLoaded && server?.has_credentials) {
      setContainersAutoLoaded(true);
      void loadContainers();
    }
  }, [tab, containersAutoLoaded, server?.has_credentials]);

  // Toast auto-dismiss. Info messages fade on their own after a few seconds so a routine
  // "restart requested" does not sit on screen forever; errors stay until the next action or
  // a manual close, because an operator must not miss a failure that scrolled away.
  const toastTimer = useRef<number | null>(null);
  function notify(text: string, nextTone: Tone = "info") {
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
      toastTimer.current = null;
    }
    setMessage(text);
    setTone(nextTone);
    if (text && nextTone === "info") {
      toastTimer.current = window.setTimeout(() => {
        setMessage("");
        toastTimer.current = null;
      }, 4000);
    }
  }
  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  function report(result: { ok: boolean; message: string }, fallback: string) {
    notify(result.message || fallback, result.ok ? "info" : "error");
  }

  function reportPrivileged(result: PrivilegedResult, fallback: string) {
    notify(result.message || result.output || fallback, result.ok ? "info" : "error");
  }

  async function load(activeToken = token) {
    // An empty token is a guest attempt: the desktop backend returns data from loopback; the
    // server backend 401s (caught below) and the login gate is shown.
    try {
      const [nextServer, nextMe] = await Promise.all([getServer(activeToken, serverId), getMe(activeToken)]);
      setServer(nextServer);
      setMe(nextMe);
    } catch (error) {
      if (activeToken) notify(error instanceof Error ? error.message : "Unable to load server", "error");
      setMe(null);
    }
  }

  useEffect(() => {
    const saved = window.localStorage.getItem("inframonitor-token") ?? "";
    setToken(saved);
    // Always attempt a load (even with no token) so desktop guest mode is entered automatically.
    void load(saved).finally(() => setInitializing(false));
  }, [serverId]);

  // Deep-links fired once after server + me load:
  //   ?shell=1 → open the host shell (fullscreen, since the sidebar launcher lands here with no
  //              gesture); admin + stored credentials only.
  //   ?edit=1  → open the Edit details dialog (admin only); used by the inventory row menu.
  const autoLinkHandled = useRef(false);
  useEffect(() => {
    if (autoLinkHandled.current || !server || !me) return;
    autoLinkHandled.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get("shell") === "1" && me.role === "admin" && server.has_credentials) {
      setHostShellFullscreen(true);
      setHostShellOpen(true);
    }
    if (params.get("edit") === "1" && me.role === "admin") setEditOpen(true);
  }, [server, me]);

  // EXPERIMENTAL (feature/server-folders): folders are only needed for the admin assignment
  // select, so fetch them once the role is known. A failure is non-fatal — the select simply
  // offers "Unassigned" only.
  useEffect(() => {
    // role, not token: a desktop guest is admin with an empty token, and getFolders("") is
    // served from loopback.
    if (me?.role !== "admin") return;
    getFolders(token).then(setFolders).catch(() => undefined);
  }, [token, me?.role]);

  if (initializing) return <div className="flex min-h-screen items-center justify-center bg-page"><div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" /></div>;
  // Guest mode sets `me` with an empty token; only fall to the login gate when there's no session.
  if (!me) return <LoginPanel onLogin={(nextToken) => { setToken(nextToken); void load(nextToken); }} />;

  async function copyLogs() {
    if (logs.length === 0) return;
    const text = logs.join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // clipboard API can be blocked (insecure origin, permissions); fall back to a hidden
      // textarea + execCommand so the button still works over plain http on a LAN
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(area);
      }
    }
    setLogsCopied(true);
    window.setTimeout(() => setLogsCopied(false), 2000);
  }

  async function refreshServerVitals() {
    setBusy("vitals");
    try {
      const updated = await refreshVitals(token, serverId);
      setServer(updated);
      notify("Vitals refreshed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to refresh vitals", "error");
    } finally {
      setBusy("");
    }
  }

  // EXPERIMENTAL (feature/server-folders): move this server into a folder, or "" to unassign.
  // Optional and non-breaking — the select just reflects and updates server.folder_id.
  async function assignFolder(folderId: string) {
    setFolderBusy(true);
    try {
      const updated = await assignServerFolder(token, serverId, folderId || null);
      setServer(updated);
      notify(folderId ? "Server moved to folder." : "Server removed from folder.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to update folder", "error");
    } finally {
      setFolderBusy(false);
    }
  }

  async function runDiscovery() {
    setBusy("discovery");
    try {
      const result = await discoverServer(token, serverId, credentials);
      report(result, "Discovery finished");
      setTomcat(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Discovery failed", "error");
    } finally {
      setBusy("");
    }
  }

  async function loadContainers() {
    setBusy("busy");
    notify("");
    try {
      const next = await getContainers(token, serverId, effectiveRuntime, { tail });
      setContainers(next);
      setSelected(next[0]?.name ?? "");
      setLogs([]);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load containers", "error");
    } finally {
      setBusy("");
    }
  }

  async function loadContainerLogs(containerName = selected) {
    if (!containerName) return;
    setBusy("busy");
    try {
      setSelected(containerName);
      setLogs(await getContainerLogs(token, serverId, effectiveRuntime, containerName, { tail }));
      setTab("logs");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load logs", "error");
    } finally {
      setBusy("");
    }
  }

  async function loadContainerEnv(containerName: string) {
    if (!containerName) return;
    setBusy(`env:${containerName}`);
    try {
      setSelected(`${containerName} · .env`);
      setLogs(await getContainerEnv(token, serverId, effectiveRuntime, containerName, { tail }));
      setTab("logs");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to read container .env", "error");
    } finally {
      setBusy("");
    }
  }

  async function restartSelectedContainer(containerName: string) {
    // A restart drops every connection the container is serving, so confirm first — naming the
    // container and host so a mis-click on the wrong row is obvious before it happens.
    if (!(await confirm({
      title: `Restart container "${containerName}"?`,
      message: `On ${server?.hostname ?? "this server"} (${effectiveRuntime}). This stops and starts it, dropping any active connections.`,
      confirmLabel: "Restart",
      danger: true
    }))) return;
    setBusy(`container:${containerName}`);
    try {
      const result = await restartContainer(token, serverId, { runtime: effectiveRuntime, name: containerName });
      report(result, `Restart requested for ${containerName}`);
      await loadContainers();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to restart container", "error");
    } finally {
      setBusy("");
    }
  }

  async function restartSelectedService(name: string, password = "") {
    // Confirm only on the first click; the sudo-password retry passes a password and must not
    // ask again.
    if (!password && !(await confirm({
      title: `Restart service "${name}"?`,
      message: `On ${server?.hostname ?? "this server"}.`,
      confirmLabel: "Restart",
      danger: true
    }))) return;
    setBusy(`service:${name}`);
    try {
      const result = await restartService(token, serverId, name, password);
      if (result.needs_sudo_password) {
        setPendingSudo({ kind: "service", name });
        notify(result.message || `Sudo password required to restart ${name}`, "error");
        return;
      }
      setPendingSudo(null);
      reportPrivileged(result, `Restart requested for ${name}`);
      if (result.ok) await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to restart service", "error");
    } finally {
      setBusy("");
    }
  }

  async function loadTomcat(quiet = false) {
    setBusy("busy");
    if (!quiet) notify("");
    try {
      const next = await getTomcatInstances(token, serverId, credentials);
      setTomcat(next);
      setLogPicker("");
      setDetailPicker("");
      if (!quiet && next.length === 0) notify("No Tomcat instances detected on this host.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load Tomcat instances", "error");
    } finally {
      setBusy("");
    }
  }

  async function runTomcatAction(instance: string, action: string, password = "") {
    // Confirm the disruptive actions on first click only (start is harmless; the sudo retry
    // passes a password and skips this).
    if (!password && (action === "restart" || action === "stop") && !(await confirm({
      title: `${action === "stop" ? "Stop" : "Restart"} Tomcat "${instance}"?`,
      message: `On ${server?.hostname ?? "this server"}.`,
      confirmLabel: action === "stop" ? "Stop" : "Restart",
      danger: true
    }))) return;
    setBusy(`tomcat:${instance}:${action}`);
    try {
      const payload = { instance, action, sudo_password: password };
      const result = await tomcatAction(token, serverId, payload);
      if (result.needs_sudo_password) {
        setPendingSudo({ kind: "tomcat", instance, action });
        notify(result.message || `Sudo password required to ${action} ${instance}`, "error");
        return;
      }
      setPendingSudo(null);
      reportPrivileged(result, `${action} requested for ${instance}`);
      if (result.ok) await loadTomcat(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : `Unable to ${action} ${instance}`, "error");
    } finally {
      setBusy("");
    }
  }

  async function submitSudoPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pending = pendingSudo;
    const password = sudoPassword;
    if (!pending || !password) return;
    try {
      if (pending.kind === "tomcat") await runTomcatAction(pending.instance, pending.action, password);
      else await restartSelectedService(pending.name, password);
    } finally {
      setSudoPassword("");
    }
  }

  function cancelSudo() {
    setPendingSudo(null);
    setSudoPassword("");
  }

  async function loadTomcatLog(instance: TomcatInstance, file: TomcatLogFile) {
    setBusy("busy");
    try {
      const payload = { instance: instance.name, log_file: file.path, tail };
      const lines = await getTomcatLogs(token, serverId, payload);
      setSelected(`${instance.name} - ${file.name}`);
      setLogs(lines);
      setTab("logs");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load Tomcat logs", "error");
    } finally {
      setBusy("");
    }
  }

  async function loadServiceUnitLogs(row: Record<string, string>) {
    const unit = row.name ?? "";
    if (!unit) return;
    setBusy("busy");
    try {
      const payload = { source: "journal", name_or_path: unit, tail };
      const lines = await getServiceLogs(token, serverId, payload);
      setSelected(`journal: ${unit}`);
      setLogs(lines);
      setTab("logs");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load service logs", "error");
    } finally {
      setBusy("");
    }
  }

  async function loadDbLogs(item: Record<string, string>) {
    setBusy("busy");
    try {
      setSelected(item.path ?? item.database ?? "database");
      setLogs(await getServiceLogs(token, serverId, { source: item.source ?? "file", name_or_path: item.path, tail }));
      setTab("logs");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load database logs", "error");
    } finally {
      setBusy("");
    }
  }

  async function removeServer() {
    if (!(await confirm({
      title: `Delete ${server?.hostname ?? "this server"}?`,
      message: "It is removed from Infra Monitor along with its stored credentials and access grants. This cannot be undone.",
      confirmLabel: "Delete server",
      danger: true
    }))) return;
    await deleteServer(token, serverId);
    window.location.href = "/";
  }

  const runtimeOptions = [
    server?.docker_version ? "docker" : "",
    server?.podman_version ? "podman" : ""
  ].filter(Boolean);

  // Pick the runtime for the host instead of asking: almost every server runs one or the
  // other, so a two-item dropdown was a choice with only one valid answer. The selector is
  // kept only when a host genuinely has both, otherwise its podman containers would become
  // unreachable from the UI.
  const detectedRuntime = runtimeOptions[0] ?? "docker";
  const bothRuntimes = runtimeOptions.length > 1;
  const effectiveRuntime = bothRuntimes ? runtime : detectedRuntime;

  return (
    <main className="flex min-h-screen">
      {confirmDialog}
      <Sidebar role={me?.role} guest={me?.guest} menus={me?.menus} />
      <div className="min-w-0 flex-1">
      <header className="border-b border-edge bg-elevated">
        <div className="flex items-center justify-between px-6 pl-16 py-5">
          <div>
            <Link href="/servers" className="mb-2 inline-flex items-center gap-2 text-sm text-accent"><ArrowLeft size={16} /> Server List</Link>
            <h1 className="text-2xl font-semibold tracking-normal">{server?.hostname ?? "Server"}</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{server?.ip_address}:{server?.ssh_port} as {server?.username}</p>
          </div>
          <div className="flex items-center gap-3 text-sm font-medium text-slate-700 dark:text-slate-200">
            {server ? <StatusPill status={server.status} /> : null}
            {isAdmin && server?.has_credentials ? (
              <button
                type="button"
                onClick={() => setHostShellOpen((open) => !open)}
                aria-pressed={hostShellOpen}
                title={`Open an interactive shell on ${server.hostname}`}
                className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors ${hostShellOpen ? "bg-accent/10 text-accent hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"}`}
              >
                <Terminal size={16} /> Shell
              </button>
            ) : null}
            {isAdmin ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setActionsOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={actionsOpen}
                  title="Server actions"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  <MoreVertical size={18} />
                </button>
                {actionsOpen ? (
                  <>
                    <button aria-label="Dismiss actions" onClick={() => setActionsOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                    <div role="menu" className="absolute right-0 top-full z-50 mt-1 w-60 overflow-hidden rounded-2xl border border-line bg-panel py-1 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900">
                      <button role="menuitem" disabled={loading} onClick={() => { setActionsOpen(false); void runDiscovery(); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800">
                        <RefreshCw size={15} className="text-accent" /> Discover services &amp; storage
                      </button>
                      <button role="menuitem" onClick={() => { setActionsOpen(false); setEditOpen(true); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
                        <Pencil size={15} className="text-accent" /> Edit server details
                      </button>
                      <button role="menuitem" onClick={() => { setActionsOpen(false); setCredentialsOpen(true); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
                        <KeyRound size={15} className="text-accent" /> Manage SSH credentials
                      </button>
                      <div className="my-1 border-t border-line dark:border-slate-700" />
                      <button role="menuitem" onClick={() => { setActionsOpen(false); void removeServer(); }} className="flex w-full items-center gap-2 px-4 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10 dark:text-red-400 dark:hover:bg-red-500/10">
                        <Trash2 size={15} /> Delete server
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <DefaultPasswordBanner me={me} />

      {editOpen && server ? (
        <EditServerDialog
          server={server}
          onClose={() => setEditOpen(false)}
          onSave={async (changes) => {
            const updated = await updateServer(token, serverId, changes);
            setServer(updated);
            setEditOpen(false);
            notify("Server details updated.");
          }}
        />
      ) : null}

      {credentialsOpen ? (
        <CredentialsDialog
          hasCredentials={Boolean(server?.has_credentials)}
          busy={loading}
          onClose={() => setCredentialsOpen(false)}
          onSave={async (password, privateKey) => {
            setCredentials({ password, private_key: privateKey });
            const result = await saveCredentials(token, serverId, { password, private_key: privateKey });
            report(result, "Credentials saved");
            await load();
            setCredentialsOpen(false);
          }}
        />
      ) : null}

      <section className="px-6 py-6">
        <section className="space-y-6">
          {message ? (
            // Floating toast rather than an inline banner: it no longer pushes the tab content
            // down when a message appears, and errors carry a close button since they persist.
            <div className={`fixed bottom-5 right-5 z-[70] flex max-w-sm items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-lg ${tone === "error" ? "border-danger/30 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-950 dark:text-red-100" : "border-accent/30 bg-white text-slate-700 dark:border-accent/40 dark:bg-slate-900 dark:text-slate-100"}`}>
              {tone === "error" ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger dark:text-red-400" /> : <InfoIcon size={16} className="mt-0.5 shrink-0 text-accent" />}
              <span className="min-w-0 flex-1 break-words font-medium">{message}</span>
              <button type="button" onClick={() => notify("")} aria-label="Dismiss" className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"><X size={14} /></button>
            </div>
          ) : null}

          {pendingSudo ? (
            <form onSubmit={(event) => void submitSudoPassword(event)} className="border border-line bg-panel p-4 dark:border-slate-700 dark:bg-slate-900">
              <div className="flex items-center gap-2 font-semibold text-accent"><Lock size={18} /><span className="text-slate-900 dark:text-slate-100">Sudo password required</span></div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {pendingSudo.kind === "tomcat" ? `Confirm to ${pendingSudo.action} Tomcat instance ${pendingSudo.instance}.` : `Confirm to restart service ${pendingSudo.name}.`}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input value={sudoPassword} onChange={(event) => setSudoPassword(event.target.value)} type="password" autoComplete="off" placeholder="Sudo password" className="h-10 min-w-[14rem] flex-1 border border-line px-3 text-sm dark:border-slate-700 dark:bg-slate-950" />
                <button type="submit" disabled={loading || !sudoPassword} className="h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">Authenticate and retry</button>
                <button type="button" onClick={cancelSudo} className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
              </div>
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Sent once with this request over SSH stdin, then discarded. Never stored in the browser.</p>
            </form>
          ) : null}

          {hostShellOpen && server ? (
            <ShellPanel
              // one workspace per host; not keyed on tab so it survives tab switches
              token={token}
              serverId={serverId}
              hostname={server.hostname}
              username={server.username}
              onClose={() => { setHostShellOpen(false); setHostShellFullscreen(false); }}
              initialFullscreen={hostShellFullscreen}
            />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {([
              ["overview", "Overview", true],
              ["storage", "Storage", true],
              ["services", "Services", true],
              // only offer these when the host actually has them, so the tab strip
              // reflects the server rather than the product's full feature list
              ["tomcat", "Tomcat", hasTomcat],
              ["containers", "Containers", hasContainerRuntime],
              ["databaseLogs", "Database Logs", hasDatabase],
              ["logs", "Log Window", true]
            ] as Array<[Tab, string, boolean]>).filter(([, , visible]) => visible).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key as Tab)} className={`h-9 rounded-full border px-4 text-sm font-medium transition-colors ${tab === key ? "border-accent bg-accent text-white" : "border-line text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"}`}>{label}</button>
            ))}
          </div>

          {tab === "overview" ? (
            <div className="space-y-6">
              {/* Live vitals, refreshable in place. cpu_percent === -1 and ram_used === 0 mean
                  "never sampled", rendered as "—" rather than a misleading 0. */}
              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    <LayoutGrid size={16} className="text-accent" /> System vitals
                    <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
                      {server?.vitals_checked_at ? `as of ${agoText(server.vitals_checked_at)}` : "not sampled yet"}
                    </span>
                  </div>
                  <button
                    disabled={loading || !server?.has_credentials}
                    onClick={() => void refreshServerVitals()}
                    title={server?.has_credentials ? "Re-probe this host over SSH" : "No stored credentials"}
                    className="inline-flex h-9 items-center gap-2 rounded-full bg-accent/10 px-4 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:hover:bg-accent/30"
                  >
                    {busy === "vitals" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Refresh vitals
                  </button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Info
                    icon={<Activity size={16} />}
                    title="Health"
                    value={server ? (server.status === "unknown" ? "Not measured" : `${server.health_score}/100`) : "-"}
                    hint={server ? server.status : ""}
                    tone={server ? usageTone(server.status === "unknown" ? -1 : 100 - server.health_score) : ""}
                  />
                  <Info
                    icon={<Cpu size={16} />}
                    title="CPU"
                    value={(server?.cpu_percent ?? -1) < 0 ? "—" : `${server?.cpu_percent}%`}
                    hint={server?.cpu ? `${server.cpu} cores` : ""}
                    tone={usageTone(server?.cpu_percent ?? -1)}
                  />
                  <Info
                    icon={<MemoryStick size={16} />}
                    title="Memory"
                    value={server?.ram_used_mb ? `${gbText(server.ram_used_mb)} / ${gbText(server.ram_mb)}` : gbText(server?.ram_mb ?? 0)}
                    hint={server && server.ram_mb > 0 && server.ram_used_mb > 0 ? `${Math.round((server.ram_used_mb / server.ram_mb) * 100)}% used` : "total installed"}
                    tone={usageTone(server && server.ram_mb > 0 && server.ram_used_mb > 0 ? Math.round((server.ram_used_mb / server.ram_mb) * 100) : -1)}
                  />
                  <Info icon={<Gauge size={16} />} title="Load average" value={server?.load_average || "—"} hint="1 / 5 / 15 min" />
                  <Info icon={<Clock size={16} />} title="Uptime" value={uptimeText(server?.uptime_seconds ?? 0)} />
                  <Info icon={<ListChecks size={16} />} title="Processes" value={server?.process_count ? String(server.process_count) : "—"} />
                </div>
              </div>

              <div>
                <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                  <InfoIcon size={16} className="text-accent" /> System information
                  <span className="text-xs font-medium text-slate-400 dark:text-slate-500">
                    {server?.last_discovery ? `discovered ${agoText(server.last_discovery)}` : "not discovered yet"}
                  </span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Info icon={<MonitorCog size={16} />} title="Distribution" value={osFlavour(server)} />
                  <Info icon={<MonitorCog size={16} />} title="OS" value={server?.operating_system || "Unknown"} />
                  <Info icon={<Terminal size={16} />} title="Kernel" value={server?.kernel || "Unknown"} />
                  <Info icon={<Cpu size={16} />} title="Architecture" value={server?.architecture || "Unknown"} />
                  <Info icon={<Package size={16} />} title="Package Manager" value={packageManagerLabel(server)} />
                  <Info icon={<HardDrive size={16} />} title="Root disk" value={server?.disk_gb ? `${server.disk_gb} GB` : "Unknown"} />
                  <Info icon={<Boxes size={16} />} title="Docker" value={server?.docker_version || "Not detected"} />
                  <Info icon={<Boxes size={16} />} title="Podman" value={server?.podman_version || "Not detected"} />
                  <Info icon={<Network size={16} />} title="Environment" value={server?.environment || "-"} />
                </div>
              </div>

              {/* EXPERIMENTAL (feature/server-folders): optional folder assignment. Admin-only and
                  non-breaking — a plain select bound to the server's folder_id, saved immediately.
                  Non-admins see the folder as a read-only line instead. */}
              {isAdmin ? (
                <div>
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
                    <FolderIcon size={16} className="text-accent" /> Folder
                    <span className="text-xs font-medium text-slate-400 dark:text-slate-500">optional grouping</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={server?.folder_id || ""}
                      onChange={(event) => void assignFolder(event.target.value)}
                      disabled={folderBusy || !server}
                      aria-label="Assign this server to a folder"
                      className="h-10 min-w-[16rem] cursor-pointer rounded-xl border border-line bg-white px-3 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                    >
                      <option value="">Unassigned</option>
                      {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                    </select>
                    {folderBusy ? <Loader2 size={16} className="animate-spin text-accent" /> : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {tab === "storage" ? (
            <Panel title="Storage Perspective" icon={<HardDrive size={18} />}>
              <StorageChart rows={server?.storage ?? []} />
              <div className="mt-6 border-t border-line pt-4 dark:border-slate-700">
                <DataTable rows={storageTableRows(server?.storage ?? [])} columns={["mount", "type", "size", "used", "available", "used_percent", "status"]} />
              </div>
            </Panel>
          ) : null}

          {tab === "services" ? (
            <Panel title="Detected Services" icon={<ServerCog size={18} />}>
              <DataTable
                rows={server?.discovered_services ?? []}
                columns={["name", "type", "source", "status", "detail"]}
                action={(row) => row.source === "systemd" && row.name ? (
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => void loadServiceUnitLogs(row)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">Logs</button>
                    {isAdmin ? <button disabled={loading} onClick={() => void restartSelectedService(row.name)} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30">{busy === `service:${row.name}` ? <Loader2 size={12} className="animate-spin" /> : null}Restart</button> : null}
                  </div>
                ) : null}
              />
            </Panel>
          ) : null}

          {tab === "tomcat" ? (
            <Panel title="Tomcat Instances" icon={<Coffee size={18} />}>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <select value={tail} onChange={(event) => setTail(Number(event.target.value))} className="h-10 cursor-pointer rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100">
                  {[100, 200, 500, 1000].map((value) => <option key={value} value={value}>tail {value}</option>)}
                </select>
                <button disabled={loading} onClick={() => void loadTomcat()} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"><RefreshCw size={16} /> Load / Refresh</button>
                <span className="text-xs text-slate-500 dark:text-slate-400">{tomcat ? "Live probe" : server?.last_discovery ? `From discovery on ${new Date(server.last_discovery).toLocaleString()}` : "Never discovered"}</span>
              </div>
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Version</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Enabled</th><th className="px-4 py-3">PID</th><th className="px-4 py-3">Ports</th><th className="px-4 py-3">CATALINA_BASE</th><th className="px-4 py-3">Actions</th></tr></thead>
                <tbody>
                  {tomcatRows.map((instance) => (
                    <Fragment key={instance.name}>
                      <tr className="border-t border-line dark:border-slate-700">
                        <td className="px-4 py-3 font-medium">{instance.name}</td>
                        <td className="max-w-xs break-words px-4 py-3">{instance.version || "-"}</td>
                        <td className="px-4 py-3"><TomcatStatus status={instance.status} /></td>
                        <td className="px-4 py-3">{instance.enabled || "-"}</td>
                        <td className="px-4 py-3">{instance.pid || "-"}</td>
                        <td className="max-w-xs break-words px-4 py-3">{instance.ports || "-"}</td>
                        <td className="max-w-xs break-all px-4 py-3">{instance.catalina_base || "-"}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => setDetailPicker(detailPicker === instance.name ? "" : instance.name)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">{detailPicker === instance.name ? "Hide details" : "Details"}</button>
                            <button onClick={() => setLogPicker(logPicker === instance.name ? "" : instance.name)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">Logs</button>
                            {isAdmin ? (
                              <>
                                <button disabled={loading} onClick={() => void runTomcatAction(instance.name, "restart")} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30">{busy === `tomcat:${instance.name}:restart` ? <Loader2 size={12} className="animate-spin" /> : null}Restart</button>
                                <button disabled={loading} onClick={() => void runTomcatAction(instance.name, "start")} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800 transition-colors hover:bg-emerald-200 disabled:opacity-50 dark:bg-emerald-900/40 dark:text-emerald-200 dark:hover:bg-emerald-900/60">{busy === `tomcat:${instance.name}:start` ? <Loader2 size={12} className="animate-spin" /> : null}Start</button>
                                <button disabled={loading} onClick={() => void runTomcatAction(instance.name, "stop")} className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800 transition-colors hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-200 dark:hover:bg-red-900/60">{busy === `tomcat:${instance.name}:stop` ? <Loader2 size={12} className="animate-spin" /> : null}Stop</button>
                              </>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                      {detailPicker === instance.name ? (
                        <tr className="border-t border-line bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
                          <td colSpan={8} className="space-y-5 px-4 py-4">
                            <div>
                              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500 dark:text-slate-400"><InfoIcon size={14} /> Runtime detail for {instance.name}</div>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                <Detail label="Server number" value={instance.server_number} />
                                <Detail label="Version banner" value={instance.version} />
                                <Detail label="JVM version" value={instance.jvm_version} />
                                <Detail label="JVM vendor" value={instance.jvm_vendor} />
                                <Detail label="JAVA_HOME" value={instance.java_home} mono />
                                <Detail label="java binary" value={instance.java} mono />
                                <Detail label="OS" value={instance.os_name} />
                                <Detail label="CATALINA_HOME" value={instance.catalina_home} mono />
                                <Detail label="CATALINA_BASE" value={instance.catalina_base} mono />
                                <Detail label="Configured log dir" value={instance.configured_log_dir} mono />
                                <Detail label="Configured log prefix" value={instance.configured_log_prefix} mono />
                                <Detail label="Primary log file" value={instance.primary_log_file} mono />
                                <Detail label="Discovered log dir" value={instance.log_dir} mono />
                                <Detail label="Unit" value={instance.unit} mono />
                                <Detail label="Source" value={instance.source} />
                              </div>
                            </div>

                            <div>
                              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500 dark:text-slate-400"><ListChecks size={14} /> Prerequisites</div>
                              <PrerequisiteTable rows={instance.prerequisites ?? []} />
                            </div>

                            <div>
                              <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500 dark:text-slate-400"><LayoutGrid size={14} /> Webapps</div>
                              <WebappTable rows={instance.webapps ?? []} />
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {logPicker === instance.name ? (
                        <tr className="border-t border-line bg-slate-50 dark:border-slate-700 dark:bg-slate-950">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-500 dark:text-slate-400"><FileText size={14} /> Log files for {instance.name}</div>
                            {(instance.log_files ?? []).length ? (
                              <div className="mt-3 grid gap-2">
                                {(instance.log_files ?? []).map((file) => (
                                  <div key={file.path} className="flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
                                    <div className="min-w-0">
                                      <div className="font-medium">{file.name}</div>
                                      <div className="break-all text-xs text-slate-500 dark:text-slate-400">{[file.path, humanBytes(file.size_bytes), file.modified].filter(Boolean).join(" · ")}</div>
                                    </div>
                                    <button disabled={loading} onClick={() => void loadTomcatLog(instance, file)} className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30">View</button>
                                  </div>
                                ))}
                              </div>
                            ) : <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">No log files discovered for this instance. Press Load / Refresh to probe the host again.</p>}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                  {tomcatRows.length === 0 ? <tr><td className="px-4 py-6 text-slate-500" colSpan={8}>No Tomcat instances recorded. Run discovery or press Load / Refresh.</td></tr> : null}
                </tbody>
              </table>

              {isAdmin ? (
                <div className="mt-6 border-t border-line pt-5 dark:border-slate-700">
                  <div className="mb-4 flex items-center gap-2 font-semibold text-accent">
                    <Upload size={18} />
                    <span className="text-slate-900 dark:text-slate-100">Deploy WAR</span>
                  </div>
                  {tomcatRows.length === 0 ? (
                    <p className="text-xs text-slate-500 dark:text-slate-400">Load the Tomcat instances first — the target directory comes from the discovered instance, never from this form.</p>
                  ) : (
                    <WarDeployPanel token={token} serverId={serverId} instances={tomcatRows} onDeployed={() => loadTomcat(true)} />
                  )}
                </div>
              ) : null}
            </Panel>
          ) : null}

          {tab === "containers" && containerShellFor && server ? (
            (() => {
              // Don't hardcode `docker`: the host may run podman instead (or the discovered
              // runtime may be wrong). Probe for the binary at exec time and use whichever is
              // actually on PATH, preferring the detected runtime. Inside the container we prefer
              // an interactive bash and fall back to sh (many minimal images ship only sh), via
              // `sh -c 'command -v bash && exec bash || exec sh'`. If no runtime is installed it
              // prints a clear message instead of a cryptic failure.
              const order = [effectiveRuntime, "docker", "podman"].filter((r, i, a) => a.indexOf(r) === i);
              const inContainerShell = `sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
              const containerShellCommand =
                `for __rt in ${order.join(" ")}; do command -v "$__rt" >/dev/null 2>&1 && ` +
                `{ "$__rt" exec -it ${containerShellFor} ${inContainerShell}; break; }; done; ` +
                `command -v docker >/dev/null 2>&1 || command -v podman >/dev/null 2>&1 || ` +
                `echo "No docker or podman found on PATH for this user."`;
              return (
                <div className="mb-6">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-300">
                    <Terminal size={15} className="text-accent" />
                    Shell inside <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{containerShellFor}</span>
                    <span className="text-xs text-slate-400">— {order.join(" / ")} exec, into bash (or sh if bash is absent)</span>
                  </div>
                  <ShellPanel
                    // keyed on the container so switching to a different container's shell mounts a
                    // fresh session that runs the new exec, rather than reusing the previous PTY
                    key={containerShellFor}
                    token={token}
                    serverId={serverId}
                    hostname={server.hostname}
                    username={server.username}
                    onClose={() => setContainerShellFor("")}
                    initialCommand={containerShellCommand}
                  />
                </div>
              );
            })()
          ) : null}

          {tab === "containers" ? (
            <Panel
              title={`Containers${bothRuntimes ? "" : ` (${detectedRuntime})`}`}
              icon={<Boxes size={18} />}
              action={
                <>
                  {/* only shown when the host really runs both, so podman stays reachable */}
                  {bothRuntimes ? (
                    <select value={runtime} onChange={(event) => setRuntime(event.target.value)} className="h-9 cursor-pointer rounded-full border-none bg-slate-100 px-3 text-xs font-semibold text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100">
                      {runtimeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : null}
                  <button disabled={loading} onClick={() => void loadContainers()} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"><RefreshCw size={14} /> {loading ? "Loading..." : "Load"}</button>
                </>
              }
            >
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Image</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Ports</th><th className="px-4 py-3">Actions</th></tr></thead>
                <tbody>
                  {containers.map((container) => (
                    <tr key={container.id} className="border-t border-line dark:border-slate-700">
                      <td className="px-4 py-3 font-medium">{container.name}</td>
                      <td className="px-4 py-3">{container.image}</td>
                      <td className="px-4 py-3">{container.status}</td>
                      <td className="max-w-xs break-words px-4 py-3">{shortPorts(container.ports) || "-"}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button onClick={() => void loadContainerLogs(container.name)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">Logs</button>
                          <button disabled={loading} onClick={() => void loadContainerEnv(container.name)} title="Show the container's .env file (or its runtime environment if none)" className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">{busy === `env:${container.name}` ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} .env</button>
                          {isAdmin && server?.has_credentials ? <button onClick={() => setContainerShellFor(container.name)} title="Open an interactive shell inside this container" className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30"><Terminal size={12} /> Shell</button> : null}
                          {canRestartContainer ? <button disabled={loading} onClick={() => void restartSelectedContainer(container.name)} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30">{busy === `container:${container.name}` ? <Loader2 size={12} className="animate-spin" /> : null}Restart</button> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {containers.length === 0 ? <tr><td className="px-4 py-6 text-slate-500" colSpan={5}>Load Docker or Podman containers.</td></tr> : null}
                </tbody>
              </table>
            </Panel>
          ) : null}

          {tab === "databaseLogs" ? (
            <Panel title="Database Logs" icon={<Database size={18} />}>
              <DataTable rows={server?.database_logs ?? []} columns={["database", "source", "path"]} action={(row) => <button onClick={() => void loadDbLogs(row)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">View logs</button>} />
            </Panel>
          ) : null}

          {tab === "logs" ? (
            <div className={`bg-white dark:bg-slate-900 ${isFullscreen ? "fixed inset-0 z-[100] flex flex-col" : "overflow-hidden rounded-2xl shadow-sm ring-1 ring-slate-200 dark:ring-slate-800"}`}>
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">
                <span className="flex items-center gap-2"><FileText size={18} className="text-accent" />Logs {selected ? <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400">{selected}</span> : ""}</span>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => void copyLogs()}
                    disabled={logs.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-40 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {logsCopied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                  <button onClick={() => setIsFullscreen(!isFullscreen)} className="text-accent hover:underline text-sm font-medium">
                    {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                  </button>
                </div>
              </div>
              <pre className={`${isFullscreen ? "flex-1 max-h-none" : "max-h-[560px]"} whitespace-pre-wrap break-words overflow-auto bg-slate-950 p-4 text-xs leading-relaxed text-slate-100`}>{logs.length ? logs.join("\n") : "Select a container, service, Tomcat or database log source."}</pre>
            </div>
          ) : null}
        </section>
      </section>
      </div>
    </main>
  );
}

function shortPorts(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("[::]:"))
    .map((item) => {
      if (!item.includes("->")) return item.split("/")[0];
      const [left, right] = item.split("->");
      return `${left.split(":").pop()}->${right.split("/")[0]}`;
    })
    .filter((item, index, items) => item && items.indexOf(item) === index)
    .join(", ");
}

const DISTRO_LABELS: Record<string, string> = {
  almalinux: "AlmaLinux",
  alpine: "Alpine",
  amzn: "Amazon Linux",
  centos: "CentOS",
  debian: "Debian",
  fedora: "Fedora",
  ol: "Oracle Linux",
  opensuse: "openSUSE",
  rhel: "RHEL",
  rocky: "Rocky Linux",
  sles: "SLES",
  ubuntu: "Ubuntu"
};

function titleCase(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : "";
}

function osFlavour(server: Server | null) {
  const distro = server?.os_distro ?? "";
  const family = server?.os_family ?? "";
  const version = server?.os_version ?? "";
  const name = distro ? DISTRO_LABELS[distro.toLowerCase()] ?? titleCase(distro) : titleCase(family);
  return [name, version].filter(Boolean).join(" ") || "Unknown";
}

function packageManagerLabel(server: Server | null) {
  const manager = server?.package_manager ?? "";
  const family = server?.os_family ?? "";
  if (!manager) return family ? `Unknown (${family} family)` : "Unknown";
  return family ? `${manager} · ${family} family` : manager;
}

// Accepts either shape: log/webapp sizes arrive as shell-parsed strings today, but a
// Pydantic int field would serialise as a JSON number.
function humanBytes(value?: string | number) {
  const bytes = Number(value);
  if (value === undefined || value === "" || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

// df reports 1K blocks; storage rows discovered before the byte fields existed only carry *_1k
function bytesFrom(row: Record<string, string>, byteKey: string, blockKey: string) {
  const direct = Number(row[byteKey]);
  if (Number.isFinite(direct) && direct > 0) return String(direct);
  const blocks = Number(row[blockKey]);
  if (Number.isFinite(blocks) && blocks > 0) return String(blocks * 1024);
  return "";
}

function gb(value: string) {
  const bytes = Number(value);
  if (!value || !Number.isFinite(bytes) || bytes <= 0) return "-";
  const size = bytes / 1024 / 1024 / 1024;
  return `${size >= 10 ? Math.round(size) : size.toFixed(1)} GB`;
}

function storageTableRows(rows: Array<Record<string, string>>) {
  return rows.map((row) => ({
    mount: row.mount ?? "",
    type: row.type ?? "",
    size: gb(bytesFrom(row, "size_bytes", "blocks_1k")),
    used: gb(bytesFrom(row, "used_bytes", "used_1k")),
    available: gb(bytesFrom(row, "available_bytes", "available_1k")),
    used_percent: row.used_percent ?? "",
    status: row.status ?? ""
  }));
}

function TomcatStatus({ status }: { status?: string }) {
  const value = status || "unknown";
  const tone = value === "active" || value === "running"
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
    : value === "failed"
      ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold capitalize ${tone}`}>{value}</span>;
}

function Detail({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  const shown = (value ?? "").trim();
  return (
    <div className="min-w-0 border border-line bg-panel px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 break-all text-xs ${shown ? "font-medium text-slate-900 dark:text-slate-100" : "text-slate-400 dark:text-slate-500"} ${mono && shown ? "font-mono" : ""}`}>
        {shown || "Not detected"}
      </div>
    </div>
  );
}

// ok reads as the accent tone; unsupported and missing are both blocking, so both are red;
// unknown stays slate because it means "we could not tell", not "it is fine".
function PrerequisiteStatus({ status }: { status?: string }) {
  const value = (status || "unknown").toLowerCase();
  const tone = value === "ok"
    ? "bg-accent/10 text-accent dark:bg-accent/20"
    : value === "unsupported" || value === "missing"
      ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200"
      : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold capitalize ${tone}`}>{value}</span>;
}

function PrerequisiteTable({ rows }: { rows: TomcatPrerequisite[] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">No prerequisites reported for this instance. Press Load / Refresh to probe the host again.</p>;
  }
  return (
    <table className="mt-3 w-full text-left text-sm">
      <thead className="bg-slate-100 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
        <tr><th className="px-4 py-2">Requirement</th><th className="px-4 py-2">Required</th><th className="px-4 py-2">Detected</th><th className="px-4 py-2">Status</th></tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.name}-${index}`} className="border-t border-line dark:border-slate-700">
            <td className="px-4 py-2 font-medium">{row.name || "-"}</td>
            <td className="max-w-xs break-words px-4 py-2">{row.required || "-"}</td>
            <td className="max-w-xs break-words px-4 py-2">{row.detected || "Not detected"}</td>
            <td className="px-4 py-2"><PrerequisiteStatus status={row.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WebappTable({ rows }: { rows: TomcatWebapp[] }) {
  if (rows.length === 0) {
    return <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">No webapps found under this instance&apos;s webapps directory.</p>;
  }
  return (
    <table className="mt-3 w-full text-left text-sm">
      <thead className="bg-slate-100 text-xs uppercase text-slate-500 dark:bg-slate-900 dark:text-slate-400">
        <tr><th className="px-4 py-2">Name</th><th className="px-4 py-2">Type</th><th className="px-4 py-2">Size</th><th className="px-4 py-2">Modified</th><th className="px-4 py-2">Path</th></tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.path || row.name}-${index}`} className="border-t border-line dark:border-slate-700">
            <td className="px-4 py-2 font-medium">{row.name || "-"}</td>
            <td className="px-4 py-2 uppercase text-xs font-semibold text-slate-500 dark:text-slate-400">{row.type || "-"}</td>
            <td className="px-4 py-2">{row.type === "dir" ? "-" : humanBytes(row.size_bytes) || "-"}</td>
            <td className="px-4 py-2">{row.modified || "-"}</td>
            <td className="max-w-xs break-all px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{row.path || "-"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Info({ title, value, hint, tone, icon }: { title: string; value: string; hint?: string; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200 transition-shadow hover:shadow-md dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{title}</span>
        {icon ? <span className="shrink-0 text-slate-300 dark:text-slate-600">{icon}</span> : null}
      </div>
      <div className={`mt-2 break-words text-lg font-semibold ${tone || "text-slate-900 dark:text-white"}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{hint}</div> : null}
    </div>
  );
}

// --- overview formatting -------------------------------------------------------------------
function uptimeText(seconds: number): string {
  if (!seconds || seconds < 0) return "Unknown";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function gbText(mb: number): string {
  if (!mb) return "-";
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

// -1 = never sampled, which must never read as a healthy 0%.
function usageTone(percent: number): string {
  if (percent < 0) return "text-slate-400 dark:text-slate-500";
  if (percent >= 90) return "text-danger dark:text-red-400";
  if (percent >= 75) return "text-warn dark:text-amber-400";
  return "";
}

function agoText(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// Modal for entering/replacing the stored SSH credentials. Self-contained local state, and
// values are snapshotted before the await so no `event.currentTarget`-after-await hazard.
function CredentialsDialog({ hasCredentials, busy, onClose, onSave }: { hasCredentials: boolean; busy: boolean; onClose: () => void; onSave: (password: string, privateKey: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pw = password;
    const key = privateKey;
    if (!pw && !key) {
      setLocalError("Enter an SSH password or a private key.");
      return;
    }
    setSaving(true);
    setLocalError("");
    try {
      await onSave(pw, key);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to save credentials");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-panel shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-line px-5 py-4 dark:border-slate-700">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><KeyRound size={18} className="text-accent" /> SSH credentials</h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="space-y-3 p-5">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {hasCredentials ? "Credentials are already stored. Enter new ones to replace them." : "No credentials stored yet. Enter an SSH password or private key."}
          </p>
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="off" placeholder="SSH password" className="h-11 w-full rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
          <div className="text-center text-xs font-medium uppercase text-slate-400">or</div>
          <textarea value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} spellCheck={false} placeholder="SSH private key (PEM)" className="min-h-32 w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
          {localError ? <p className="text-xs font-medium text-danger dark:text-red-400">{localError}</p> : null}
          <p className="text-xs text-slate-500 dark:text-slate-400">Stored Fernet-encrypted on the server and never sent back to the browser.</p>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
            <button type="submit" disabled={saving || busy} className="h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">{saving ? "Saving…" : "Save encrypted"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditServerDialog({ server, onClose, onSave }: { server: Server; onClose: () => void; onSave: (changes: ServerUpdate) => Promise<void> }) {
  const [hostname, setHostname] = useState(server.hostname);
  const [ipAddress, setIpAddress] = useState(server.ip_address);
  const [alias, setAlias] = useState(server.alias);
  const [username, setUsername] = useState(server.username);
  const [sshPort, setSshPort] = useState(String(server.ssh_port));
  const [environment, setEnvironment] = useState(server.environment);
  const [serverType, setServerType] = useState(server.server_type);
  const [tags, setTags] = useState(server.tags.join(", "));
  const [businessOwner, setBusinessOwner] = useState(server.business_owner ?? "");
  const [supportContact, setSupportContact] = useState(server.support_contact ?? "");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hostname.trim()) return setLocalError("Hostname cannot be empty.");
    if (!ipAddress.trim()) return setLocalError("IP address / hostname cannot be empty.");
    if (!username.trim()) return setLocalError("SSH user cannot be empty.");
    const badAddress = addressError(ipAddress);
    if (badAddress) return setLocalError(badAddress);
    const port = Number(sshPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setLocalError("SSH port must be a whole number between 1 and 65535.");

    setSaving(true);
    setLocalError("");
    try {
      await onSave({
        hostname: hostname.trim(),
        ip_address: ipAddress.trim(),
        alias: alias.trim(),
        username: username.trim(),
        ssh_port: port,
        environment: environment.trim(),
        server_type: serverType.trim(),
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        business_owner: businessOwner.trim(),
        support_contact: supportContact.trim()
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to save changes");
    } finally {
      setSaving(false);
    }
  }

  const field = "h-11 w-full rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";
  const labelClass = "mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-line bg-panel shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="sticky top-0 flex items-center justify-between border-b border-line bg-panel px-5 py-4 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><Pencil size={18} className="text-accent" /> Edit server details</h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="grid gap-4 p-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={labelClass}>Hostname</label>
            <input value={hostname} onChange={(event) => setHostname(event.target.value)} className={field} />
          </div>
          <div>
            <label className={labelClass}>IP address / hostname</label>
            <input value={ipAddress} onChange={(event) => setIpAddress(event.target.value)} className={field} />
          </div>
          <div>
            <label className={labelClass}>Alias</label>
            <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="optional" className={field} />
          </div>
          <div>
            <label className={labelClass}>SSH user</label>
            <input value={username} onChange={(event) => setUsername(event.target.value)} className={field} />
          </div>
          <div>
            <label className={labelClass}>SSH port</label>
            <input value={sshPort} onChange={(event) => setSshPort(event.target.value)} type="number" min={1} max={65535} className={field} />
          </div>
          <div>
            <label className={labelClass}>Environment</label>
            <input value={environment} onChange={(event) => setEnvironment(event.target.value)} className={field} />
          </div>
          <div>
            <label className={labelClass}>Server type</label>
            <input value={serverType} onChange={(event) => setServerType(event.target.value)} className={field} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelClass}>Tags <span className="font-normal normal-case text-slate-400">(comma separated)</span></label>
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="web, prod" className={field} />
          </div>
          <div>
            <label className={labelClass}>Business owner</label>
            <input value={businessOwner} onChange={(event) => setBusinessOwner(event.target.value)} placeholder="optional" className={field} />
          </div>
          <div>
            <label className={labelClass}>Support contact</label>
            <input value={supportContact} onChange={(event) => setSupportContact(event.target.value)} placeholder="optional" className={field} />
          </div>
          {localError ? <p className="text-xs font-medium text-danger dark:text-red-400 sm:col-span-2">{localError}</p> : null}
          <p className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-2">SSH credentials and discovered facts are unchanged — use “Manage SSH credentials” for those.</p>
          <div className="flex items-center justify-end gap-2 pt-1 sm:col-span-2">
            <button type="button" onClick={onClose} className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
            <button type="submit" disabled={saving} className="h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// `action` renders on the header line, so a panel's primary control does not need a whole
// toolbar row of its own below the title.
function Panel({ title, icon, children, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5 dark:border-slate-800">
        <div className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100"><span className="text-accent">{icon}</span><span>{title}</span></div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
      <div className="overflow-x-auto p-5">{children}</div>
    </div>
  );
}

// Prettifies a raw record key ("used_percent" -> "Used percent") for a column header.
function columnLabel(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const STATUS_CHIP: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  running: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  healthy: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  present: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  enabled: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  ok: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  critical: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  dead: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  inactive: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
  stopped: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
  disabled: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300",
  unknown: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300"
};

function StatusChip({ value }: { value: string }) {
  const key = value.trim().toLowerCase();
  if (!key) return <span className="text-slate-400">-</span>;
  const style = STATUS_CHIP[key] ?? "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300";
  const dot = /emerald/.test(style) ? "bg-emerald-500" : /amber/.test(style) ? "bg-amber-500" : /red/.test(style) ? "bg-red-500" : "bg-slate-400";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${style}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {value}
    </span>
  );
}

function DataTable({ rows, columns, action }: { rows: Array<Record<string, string>>; columns: string[]; action?: (row: Record<string, string>) => React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-slate-200 dark:ring-slate-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
          <tr>
            {columns.map((column) => <th key={column} className="px-4 py-3">{columnLabel(column)}</th>)}
            {action ? <th className="px-4 py-3 text-right">Action</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row, index) => (
            <tr key={index} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40">
              {columns.map((column) => (
                <td key={column} className="max-w-md break-words px-4 py-3 text-slate-700 dark:text-slate-200">
                  {column === "status" ? <StatusChip value={row[column] ?? ""} /> : (row[column] ?? "")}
                </td>
              ))}
              {action ? <td className="px-4 py-3 text-right">{action(row)}</td> : null}
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="px-4 py-6 text-slate-500 dark:text-slate-400" colSpan={columns.length + (action ? 1 : 0)}>No data discovered yet.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
