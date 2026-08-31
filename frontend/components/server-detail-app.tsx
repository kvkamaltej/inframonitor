"use client";

import Link from "next/link";
import { Activity, AlertTriangle, ArrowLeft, Boxes, Check, ChevronDown, ChevronRight, Clock, Coffee, Copy, Download, ExternalLink, Cpu, Database, FileText, Folder as FolderIcon, Gauge, HardDrive, Info as InfoIcon, KeyRound, Layers, LayoutGrid, LineChart as LineChartIcon, ListChecks, Loader2, Lock, MemoryStick, MonitorCog, MoreVertical, Network, Package, Pencil, PlugZap, RefreshCw, ScrollText, ServerCog, Terminal, Trash2, Upload, X } from "lucide-react";
import { Fragment, FormEvent, useEffect, useRef, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AutoRefreshSelect, useAutoRefresh } from "@/components/auto-refresh";
import { downloadTextFile, safeFilename } from "@/lib/download";
import { serverMetricCharts } from "@/lib/monitoring-queries";
import {
  assignServerFolder,
  ContainerInfo,
  ImageInfo,
  deleteServer,
  discoverServer,
  refreshVitals,
  Folder,
  getContainerEnv,
  getContainerLogs,
  getContainers,
  getImages,
  removeContainer,
  removeImage,
  testConnection,
  getFolders,
  getMe,
  getServer,
  getServiceLogs,
  getTomcatInstances,
  getTomcatLogs,
  getMonitoringEnabled,
  getServerMonitoring,
  getServerLogCapabilities,
  installServerMetrics,
  uninstallServerMetrics,
  setServerLogShipping,
  promQueryRange,
  Me,
  MonitoringEnabled,
  PromResponse,
  ServerMonitoring,
  ServerLogCapabilities,
  ServerLogSource,
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
import { LokiLogViewer } from "@/components/loki-logs";
import { LoginPanel } from "@/components/login-panel";
import { ShellPanel } from "@/components/shell-panel";
import { StatusPill } from "@/components/status-pill";
import { StorageChart } from "@/components/storage-chart";
import { Sidebar } from "@/components/sidebar";
import { WarDeployPanel } from "@/components/war-deploy-panel";

type Tab = "overview" | "storage" | "services" | "tomcat" | "containers" | "databaseLogs" | "monitoring" | "logs";
type Credentials = { password: string; private_key: string; tail?: number };
type Tone = "info" | "error";
type PendingSudo =
  | { kind: "tomcat"; instance: string; action: string }
  | { kind: "service"; name: string }
  | { kind: "metrics" };

export function ServerDetailApp({ serverId }: { serverId: string }) {
  const [token, setToken] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [server, setServer] = useState<Server | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [credentials, setCredentials] = useState<Credentials>({ password: "", private_key: "" });
  const [runtime, setRuntime] = useState("docker");
  const [tail, setTail] = useState(200);
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  // Containers are loaded with `docker ps -a` (stopped ones included); this filters the table to
  // just the running ones (status starts with "Up" for both docker and podman).
  const [runningOnly, setRunningOnly] = useState(false);
  // Images share the Containers tab via a segmented toggle -- they're the same runtime surface.
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [containerView, setContainerView] = useState<"containers" | "images">("containers");
  const [imagesAutoLoaded, setImagesAutoLoaded] = useState(false);
  const [tomcat, setTomcat] = useState<TomcatInstance[] | null>(null);
  const [logPicker, setLogPicker] = useState("");
  const [detailPicker, setDetailPicker] = useState("");
  const [pendingSudo, setPendingSudo] = useState<PendingSudo | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");
  const [selected, setSelected] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  // Auto-refresh for the shared log pane: the interval, and a closure that re-runs whichever log
  // source was last opened (container / Tomcat / service / database), so the timer reloads it.
  const [logsAuto, setLogsAuto] = useState(0);
  const [logRefresher, setLogRefresher] = useState<null | (() => void)>(null);
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

  // Per-server monitoring (feature/server-monitoring). `monitoring` is this host's agent + log
  // shipping state; `monEnabled` reports whether the deployment-wide Prometheus/Loki stack is
  // actually configured (so the controls can warn there's nowhere to scrape/ship yet). Loaded
  // once when the Monitoring tab is first opened. The log-shipping editor keeps its own toggle
  // and a Set of chosen source keys, seeded from `monitoring.log_sources`.
  const [monitoring, setMonitoring] = useState<ServerMonitoring | null>(null);
  const [monEnabled, setMonEnabled] = useState<MonitoringEnabled | null>(null);
  // Detected log-producing systems on the host (nginx/docker/podman/kubernetes) plus suggested
  // log sources. Best-effort: a probe failure leaves this null and the chips simply don't render.
  const [caps, setCaps] = useState<ServerLogCapabilities | null>(null);
  const [monLoaded, setMonLoaded] = useState(false);
  // The whole metrics + log-shipping card folds shut once monitoring is already configured, so a
  // done setup step doesn't dominate the tab. Defaults open; loadMonitoring closes it when set up.
  const [monCardOpen, setMonCardOpen] = useState(true);
  const [logShipEnabled, setLogShipEnabled] = useState(false);
  const [chosenSources, setChosenSources] = useState<Set<string>>(new Set());
  // Once the metrics agent is installed its controls collapse behind a status header, so the
  // Monitoring tab isn't dominated by an already-done step. Expands to reveal Uninstall.
  const [metricsExpanded, setMetricsExpanded] = useState(false);

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
  useEffect(() => { setContainersAutoLoaded(false); setImagesAutoLoaded(false); setContainerView("containers"); }, [serverId]);
  useEffect(() => {
    if (tab === "containers" && !containersAutoLoaded && server?.has_credentials) {
      setContainersAutoLoaded(true);
      void loadContainers();
    }
  }, [tab, containersAutoLoaded, server?.has_credentials]);

  // Load the monitoring state (agent + log shipping) and the deployment-wide stack config the
  // first time the Monitoring tab is opened. Guarded so it fires once per server, like the
  // containers auto-load above.
  useEffect(() => setMonLoaded(false), [serverId]);
  useEffect(() => {
    if (tab === "monitoring" && !monLoaded) {
      setMonLoaded(true);
      void loadMonitoring();
    }
  }, [tab, monLoaded]);

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

  // While the Logs tab is fullscreen, let Escape exit it and lock body scroll so the page behind
  // the fixed overlay doesn't scroll. Cleanup restores both when leaving fullscreen / unmounting.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

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

  // Re-run the currently-shown log source on the chosen interval (skipped while a request is in
  // flight). Declared here — above the early returns below — so the hook runs on every render and
  // never trips the Rules of Hooks (React #310).
  useAutoRefresh(logsAuto, () => {
    if (logRefresher && !busy) logRefresher();
  });

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
    setLogRefresher(() => () => loadContainerLogs(containerName));
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

  async function loadImages() {
    setImagesAutoLoaded(true);
    setBusy("busy");
    notify("");
    try {
      setImages(await getImages(token, serverId, effectiveRuntime, { tail }));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load images", "error");
    } finally {
      setBusy("");
    }
  }

  async function removeSelectedContainer(containerName: string) {
    if (!(await confirm({
      title: `Delete container "${containerName}"?`,
      message: `On ${server?.hostname ?? "this server"} (${effectiveRuntime}). Force-removes the container (stopping it first if running). This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    }))) return;
    setBusy(`rmc:${containerName}`);
    try {
      const result = await removeContainer(token, serverId, { runtime: effectiveRuntime, name: containerName });
      report(result, `Removed ${containerName}`);
      await loadContainers();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to delete container", "error");
    } finally {
      setBusy("");
    }
  }

  async function removeSelectedImage(image: ImageInfo) {
    // Prefer repo:tag; fall back to the id for dangling/untagged images.
    const ref = image.repository && image.repository !== "<none>" && image.tag && image.tag !== "<none>"
      ? `${image.repository}:${image.tag}`
      : image.id;
    if (!(await confirm({
      title: `Delete image "${ref}"?`,
      message: `On ${server?.hostname ?? "this server"} (${effectiveRuntime}). Fails if a container still uses it. This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true
    }))) return;
    setBusy(`rmi:${image.id}`);
    try {
      const result = await removeImage(token, serverId, { runtime: effectiveRuntime, name: ref });
      report(result, `Removed image ${ref}`);
      await loadImages();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to delete image", "error");
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
      else if (pending.kind === "metrics") await installMetrics(password);
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
    setLogRefresher(() => () => loadTomcatLog(instance, file));
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
    setLogRefresher(() => () => loadServiceUnitLogs(row));
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
    setLogRefresher(() => () => loadDbLogs(item));
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


  async function loadMonitoring() {
    try {
      const [mon, enabled] = await Promise.all([getServerMonitoring(token, serverId), getMonitoringEnabled(token)]);
      setMonitoring(mon);
      setMonEnabled(enabled);
      setLogShipEnabled(mon.log_shipping_enabled);
      setChosenSources(new Set(mon.log_sources.map((s) => `${s.source}|${s.name_or_path}`)));
      // Already configured? Fold the setup card so the tab leads with the drill-down instead.
      setMonCardOpen(!(mon.metrics_enabled || mon.log_shipping_enabled));
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to load monitoring state", "error");
    }
    // Best-effort capability probe (one SSH round-trip); failures leave the chips absent.
    try {
      setCaps(await getServerLogCapabilities(token, serverId));
    } catch {
      setCaps(null);
    }
  }

  // Install node_exporter on the host over SSH. Runs real commands on the box, so it can come
  // back needing a sudo password — handled with the SAME pendingSudo modal the tomcat/service
  // actions use; submitSudoPassword retries this with the password.
  async function installMetrics(password = "") {
    setBusy("metrics-install");
    try {
      const result = await installServerMetrics(token, serverId, password || undefined);
      if (result.needs_sudo_password) {
        setPendingSudo({ kind: "metrics" });
        notify(result.message || "Sudo password required to install the metrics agent", "error");
        return;
      }
      setPendingSudo(null);
      report(result, "Metrics agent installed");
      if (result.ok) await loadMonitoring();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to install the metrics agent", "error");
    } finally {
      setBusy("");
    }
  }

  async function uninstallMetrics() {
    if (!(await confirm({
      title: "Uninstall the metrics agent?",
      message: `This runs commands on ${server?.hostname ?? "this server"} to remove node_exporter and stop shipping its metrics.`,
      confirmLabel: "Uninstall",
      danger: true
    }))) return;
    setBusy("metrics-uninstall");
    try {
      const result = await uninstallServerMetrics(token, serverId);
      report(result, "Metrics agent uninstalled");
      if (result.ok) await loadMonitoring();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to uninstall the metrics agent", "error");
    } finally {
      setBusy("");
    }
  }

  async function saveLogShipping() {
    // Ships log files/journal units to Loki — an invasive change on the host, so confirm before
    // enabling it. Disabling or editing the set is confirmed too for symmetry.
    const options = buildLogSourceOptions(server, tomcatRows, containers, monitoring?.log_sources ?? [], caps?.suggested_sources ?? []);
    const sources: ServerLogSource[] = options
      .filter((opt) => chosenSources.has(`${opt.source}|${opt.name_or_path}`))
      .map(({ source, name_or_path }) => ({ source, name_or_path }));
    if (!(await confirm({
      title: logShipEnabled ? "Update log shipping?" : "Disable log shipping?",
      message: logShipEnabled
        ? `Ship ${sources.length} source${sources.length === 1 ? "" : "s"} from ${server?.hostname ?? "this server"} to Loki. This configures a shipper on the host.`
        : `Stop shipping logs from ${server?.hostname ?? "this server"}.`,
      confirmLabel: logShipEnabled ? "Save" : "Disable",
      danger: !logShipEnabled
    }))) return;
    setBusy("log-shipping");
    try {
      const result = await setServerLogShipping(token, serverId, logShipEnabled, sources);
      report(result, "Log shipping updated");
      if (result.ok) await loadMonitoring();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Unable to update log shipping", "error");
    } finally {
      setBusy("");
    }
  }

  async function removeServer() {
    // Typed-phrase gate: the operator must type the exact hostname before Delete enables, so an
    // irreversible removal (host + stored credentials + access grants) can never be a misclick.
    // Fall back to "delete" only if the hostname is somehow unknown, so the gate is never empty.
    const phrase = server?.hostname || "delete";
    if (!(await confirm({
      title: `Delete ${server?.hostname ?? "this server"}?`,
      message: "It is removed from Infra Monitor along with its stored credentials and access grants. This cannot be undone.",
      confirmLabel: "Delete server",
      danger: true,
      requirePhrase: phrase
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
          onTest={(password, privateKey) => testConnection(token, serverId, { password, private_key: privateKey })}
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
                {pendingSudo.kind === "tomcat"
                  ? `Confirm to ${pendingSudo.action} Tomcat instance ${pendingSudo.instance}.`
                  : pendingSudo.kind === "metrics"
                    ? `Confirm to install the metrics agent on ${server?.hostname ?? "this host"}.`
                    : `Confirm to restart service ${pendingSudo.name}.`}
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
              ["monitoring", "Monitoring", true],
              ["logs", "Log Window", true]
            ] as Array<[Tab, string, boolean]>).filter(([, , visible]) => visible).map(([key, label]) => (
              <button key={key} onClick={() => setTab(key as Tab)} className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors ${tab === key ? "border-accent bg-accent text-white" : "border-line text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"}`}>{key === "monitoring" ? <LineChartIcon size={14} /> : null}{label}</button>
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
              title={`${containerView === "images" ? "Images" : "Containers"}${bothRuntimes ? "" : ` (${detectedRuntime})`}`}
              icon={containerView === "images" ? <Layers size={18} /> : <Boxes size={18} />}
              action={
                <>
                  {/* Containers | Images segmented toggle -- the same runtime surface, one screen. */}
                  <div className="inline-flex h-9 items-center rounded-full bg-slate-100 p-0.5 text-xs font-semibold dark:bg-slate-800/50">
                    <button onClick={() => setContainerView("containers")} className={`inline-flex h-8 items-center gap-1 rounded-full px-3 transition-colors ${containerView === "containers" ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:text-slate-700 dark:text-slate-400"}`}><Boxes size={13} /> Containers</button>
                    <button onClick={() => { setContainerView("images"); if (!imagesAutoLoaded) void loadImages(); }} className={`inline-flex h-8 items-center gap-1 rounded-full px-3 transition-colors ${containerView === "images" ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100" : "text-slate-500 hover:text-slate-700 dark:text-slate-400"}`}><Layers size={13} /> Images</button>
                  </div>
                  {/* Running-only only makes sense for containers. */}
                  {containerView === "containers" ? (
                    <label className={`inline-flex h-9 items-center gap-2 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 dark:bg-slate-800/50 dark:text-slate-300 ${containers.length === 0 ? "opacity-50" : "cursor-pointer"}`}>
                      <input
                        type="checkbox"
                        checked={runningOnly}
                        disabled={containers.length === 0}
                        onChange={(event) => setRunningOnly(event.target.checked)}
                        className="h-4 w-4 cursor-pointer accent-accent"
                      />
                      Running only
                    </label>
                  ) : null}
                  {/* only shown when the host really runs both, so podman stays reachable */}
                  {bothRuntimes ? (
                    <select value={runtime} onChange={(event) => setRuntime(event.target.value)} className="h-9 cursor-pointer rounded-full border-none bg-slate-100 px-3 text-xs font-semibold text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100">
                      {runtimeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : null}
                  <button disabled={loading} onClick={() => void (containerView === "images" ? loadImages() : loadContainers())} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"><RefreshCw size={14} /> {loading ? "Loading..." : "Load"}</button>
                </>
              }
            >
              {containerView === "images" ? (
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400"><tr><th className="px-4 py-3">Repository</th><th className="px-4 py-3">Tag</th><th className="px-4 py-3">Image ID</th><th className="px-4 py-3">Size</th><th className="px-4 py-3">Created</th><th className="px-4 py-3">Actions</th></tr></thead>
                  <tbody>
                    {images.map((image) => (
                      <tr key={`${image.id}-${image.repository}-${image.tag}`} className="border-t border-line dark:border-slate-700">
                        <td className="px-4 py-3 font-medium break-all">{image.repository}</td>
                        <td className="px-4 py-3">{image.tag}</td>
                        <td className="px-4 py-3 font-mono text-xs">{image.id}</td>
                        <td className="px-4 py-3">{image.size}</td>
                        <td className="px-4 py-3">{image.created}</td>
                        <td className="px-4 py-3">
                          {isAdmin ? <button disabled={loading} onClick={() => void removeSelectedImage(image)} title="Delete this image" className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400">{busy === `rmi:${image.id}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete</button> : null}
                        </td>
                      </tr>
                    ))}
                    {images.length === 0 ? <tr><td className="px-4 py-6 text-slate-500" colSpan={6}>Load Docker or Podman images.</td></tr> : null}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Image</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Ports</th><th className="px-4 py-3">Actions</th></tr></thead>
                  <tbody>
                    {(() => {
                    const visible = containers.filter((c) => !runningOnly || /^up\b/i.test((c.status || "").trim()));
                    return (<>
                    {visible.map((container) => (
                      <tr key={container.id} className="border-t border-line dark:border-slate-700">
                        <td className="px-4 py-3 font-medium">{container.name}</td>
                        <td className="px-4 py-3">{container.image}</td>
                        <td className="px-4 py-3">{container.status}</td>
                        <td className="max-w-xs break-words px-4 py-3">
                          {container.host_ports && container.host_ports.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {container.host_ports.map((p) => (
                                <a key={p} href={`http://${server?.ip_address}:${p}`} target="_blank" rel="noreferrer" title={`Open http://${server?.ip_address}:${p} in a new tab`} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20">{p}<ExternalLink size={11} /></a>
                              ))}
                            </div>
                          ) : (shortPorts(container.ports) || "-")}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button onClick={() => void loadContainerLogs(container.name)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">Logs</button>
                            <button disabled={loading} onClick={() => void loadContainerEnv(container.name)} title="Show the container's .env file (or its runtime environment if none)" className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">{busy === `env:${container.name}` ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} .env</button>
                            {isAdmin && server?.has_credentials ? <button onClick={() => setContainerShellFor(container.name)} title="Open an interactive shell inside this container" className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30"><Terminal size={12} /> Shell</button> : null}
                            {canRestartContainer ? <button disabled={loading} onClick={() => void restartSelectedContainer(container.name)} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:text-accent dark:hover:bg-accent/30">{busy === `container:${container.name}` ? <Loader2 size={12} className="animate-spin" /> : null}Restart</button> : null}
                            {isAdmin ? <button disabled={loading} onClick={() => void removeSelectedContainer(container.name)} title="Delete this container" className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-600 transition-colors hover:bg-red-500/20 disabled:opacity-50 dark:text-red-400">{busy === `rmc:${container.name}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete</button> : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visible.length === 0 ? <tr><td className="px-4 py-6 text-slate-500" colSpan={5}>{containers.length === 0 ? "Load Docker or Podman containers." : "No running containers."}</td></tr> : null}
                    </>);
                    })()}
                  </tbody>
                </table>
              )}
            </Panel>
          ) : null}

          {tab === "databaseLogs" ? (
            <Panel title="Database Logs" icon={<Database size={18} />}>
              <DataTable rows={server?.database_logs ?? []} columns={["database", "source", "path"]} action={(row) => <button onClick={() => void loadDbLogs(row)} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">View logs</button>} />
            </Panel>
          ) : null}

          {tab === "monitoring" ? (
            <div className="space-y-6">
              <Panel
                title="Server monitoring"
                icon={<Activity size={18} />}
                action={monitoring !== null ? (
                  <button
                    type="button"
                    onClick={() => setMonCardOpen((prev) => !prev)}
                    aria-expanded={monCardOpen}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge px-3 text-xs font-semibold text-fg transition-colors hover:bg-elevated"
                  >
                    {monCardOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    {monCardOpen ? "Collapse" : "Expand"}
                  </button>
                ) : undefined}
              >
                {monitoring === null ? (
                  <div className="flex items-center gap-2 py-6 text-sm font-medium text-muted">
                    <Loader2 size={16} className="animate-spin" /> Loading monitoring…
                  </div>
                ) : !monCardOpen ? (
                  <button
                    type="button"
                    onClick={() => setMonCardOpen(true)}
                    className="flex w-full items-center gap-2 text-left text-sm font-medium text-muted transition-colors hover:text-fg"
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${monitoring.metrics_enabled ? "bg-emerald-500" : "bg-slate-400"}`} />
                    <span>
                      Metrics: {monitoring.metrics_enabled ? "on" : "off"} · Log shipping: {monitoring.log_shipping_enabled ? "on" : "off"}
                      {monitoring.log_shipping_enabled ? ` (${monitoring.log_sources.length} source${monitoring.log_sources.length === 1 ? "" : "s"})` : ""}
                    </span>
                  </button>
                ) : (
                  <div className="space-y-6">
                    {monEnabled && (!monEnabled.prometheus || !monEnabled.loki) ? (
                      <div className="flex items-start gap-2 rounded-xl border border-edge bg-elevated px-4 py-3 text-xs font-medium text-muted">
                        <InfoIcon size={15} className="mt-0.5 shrink-0 text-accent" />
                        <span>
                          Requires the full monitoring profile.{" "}
                          {!monEnabled.prometheus ? "Prometheus is not configured, so metrics have nowhere to be scraped. " : ""}
                          {!monEnabled.loki ? "Loki is not configured, so shipped logs have nowhere to go. " : ""}
                          You can still toggle these — they take effect once the stack is enabled.
                        </span>
                      </div>
                    ) : null}

                    {/* Metrics agent (node_exporter) */}
                    <div>
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
                        <Gauge size={16} className="text-accent" /> Metrics agent (node_exporter)
                      </div>
                      {monitoring.metrics_enabled ? (
                        <div>
                          <button
                            type="button"
                            onClick={() => setMetricsExpanded((prev) => !prev)}
                            className="flex w-full items-center gap-2 rounded-lg text-left text-sm text-muted hover:text-fg"
                          >
                            {metricsExpanded ? <ChevronDown size={15} className="shrink-0" /> : <ChevronRight size={15} className="shrink-0" />}
                            <span className={`h-2 w-2 shrink-0 rounded-full ${monitoring.scraped ? "bg-emerald-500" : "bg-amber-500"}`} />
                            <span>Agent installed · {monitoring.scraped ? "scraped ✓" : "not scraped ✗"} on port {monitoring.node_exporter_port}</span>
                          </button>
                          {metricsExpanded ? (
                            <div className="mt-3 pl-6">
                              <button
                                disabled={loading}
                                onClick={() => void uninstallMetrics()}
                                className="inline-flex h-9 items-center gap-2 rounded-full bg-red-100 px-4 text-xs font-semibold text-red-800 transition-colors hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-200 dark:hover:bg-red-900/60"
                              >
                                {busy === "metrics-uninstall" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Uninstall
                              </button>
                              <p className="mt-2 text-xs text-muted">Installing runs commands on the real host over SSH to set up node_exporter.</p>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <button
                            disabled={loading}
                            onClick={() => void installMetrics()}
                            className="inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
                          >
                            {busy === "metrics-install" ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={15} />} Install metrics agent
                          </button>
                          <p className="mt-2 text-xs text-muted">Installing runs commands on the real host over SSH to set up node_exporter.</p>
                        </>
                      )}
                    </div>

                    {/* Log shipping */}
                    <div className="border-t border-edge pt-5">
                      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
                        <ScrollText size={16} className="text-accent" /> Log shipping
                      </div>
                      {caps ? (
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="text-xs font-medium text-muted">Detected:</span>
                          {([["nginx", caps.nginx], ["docker", caps.docker], ["podman", caps.podman], ["kubernetes", caps.kubernetes]] as const)
                            .filter(([, on]) => on)
                            .map(([name]) => (
                              <span key={name} className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {name}
                              </span>
                            ))}
                          {!caps.nginx && !caps.docker && !caps.podman && !caps.kubernetes ? (
                            <span className="text-xs text-muted">none detected</span>
                          ) : null}
                        </div>
                      ) : null}
                      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-fg">
                        <input
                          type="checkbox"
                          checked={logShipEnabled}
                          onChange={(event) => setLogShipEnabled(event.target.checked)}
                          className="h-4 w-4 cursor-pointer accent-accent"
                        />
                        Ship selected logs to Loki
                      </label>
                      <p className="mt-2 mb-3 text-xs text-muted">
                        Choose which discovered log sources to ship. Each is labelled with <code className="font-mono">server_id=&quot;{serverId}&quot;</code> in Loki.
                      </p>
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => void loadContainers()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge px-3 text-xs font-medium text-fg transition-colors hover:bg-elevated disabled:opacity-50"
                        >
                          <Boxes size={13} /> {containers.length > 0 ? "Reload containers" : "Load containers"}
                        </button>
                        <span className="text-xs text-muted">Container logs are shipped with <code className="font-mono">source=&lt;container name&gt;</code>.</span>
                      </div>
                      {(() => {
                        const options = buildLogSourceOptions(server, tomcatRows, containers, monitoring.log_sources, caps?.suggested_sources ?? []);
                        if (options.length === 0) {
                          return <p className="text-xs text-muted">No log sources discovered yet. Run discovery, load Tomcat instances, or load containers to populate this list.</p>;
                        }
                        return (
                          <div className="grid gap-2 sm:grid-cols-2">
                            {options.map((opt) => {
                              const key = `${opt.source}|${opt.name_or_path}`;
                              const checked = chosenSources.has(key);
                              return (
                                <label key={key} className="flex cursor-pointer items-start gap-2 rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(event) => {
                                      setChosenSources((prev) => {
                                        const next = new Set(prev);
                                        if (event.target.checked) next.add(key);
                                        else next.delete(key);
                                        return next;
                                      });
                                    }}
                                    className="mt-0.5 h-4 w-4 cursor-pointer accent-accent"
                                  />
                                  <span className="min-w-0">
                                    <span className="block font-medium text-fg">{opt.label}</span>
                                    <span className="block break-all font-mono text-[11px] text-muted">{opt.source} · {opt.name_or_path}</span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        );
                      })()}
                      <div className="mt-4 flex flex-wrap items-center gap-3">
                        <button
                          disabled={loading}
                          onClick={() => void saveLogShipping()}
                          className="inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
                        >
                          {busy === "log-shipping" ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />} Save log shipping
                        </button>
                        <span className="text-xs text-muted">
                          {monitoring.log_shipping_enabled
                            ? `Currently shipping ${monitoring.log_sources.length} source${monitoring.log_sources.length === 1 ? "" : "s"}.`
                            : "Currently not shipping any logs."}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </Panel>

              <ServerMonitoringDrilldown token={token} serverId={serverId} scraped={monitoring?.scraped ?? false} />
            </div>
          ) : null}

          {tab === "logs" ? (
            <div className={`bg-white dark:bg-slate-900 ${isFullscreen ? "fixed inset-0 z-[100] flex flex-col" : "overflow-hidden rounded-2xl shadow-sm ring-1 ring-slate-200 dark:ring-slate-800"}`}>
              <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5 font-semibold text-slate-900 dark:border-slate-800 dark:text-slate-100">
                <span className="flex items-center gap-2"><FileText size={18} className="text-accent" />Logs {selected ? <span className="font-mono text-xs font-medium text-slate-500 dark:text-slate-400">{selected}</span> : ""}</span>
                <div className="flex items-center gap-3">
                  <AutoRefreshSelect value={logsAuto} onChange={setLogsAuto} disabled={!logRefresher} />
                  <button
                    onClick={() => logRefresher?.()}
                    disabled={!logRefresher || busy !== ""}
                    title="Reload the current log now"
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-40 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <RefreshCw size={13} className={busy !== "" ? "animate-spin" : ""} /> Refresh
                  </button>
                  <button
                    onClick={() => void copyLogs()}
                    disabled={logs.length === 0}
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-40 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {logsCopied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
                  </button>
                  <button
                    onClick={() => downloadTextFile(`${safeFilename(selected || "server-log")}.log`, logs.join("\n"))}
                    disabled={logs.length === 0}
                    title="Download the log as a file"
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-40 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <Download size={13} /> Download
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
function CredentialsDialog({ hasCredentials, busy, onClose, onSave, onTest }: { hasCredentials: boolean; busy: boolean; onClose: () => void; onSave: (password: string, privateKey: string) => Promise<void>; onTest: (password: string, privateKey: string) => Promise<{ ok: boolean; message: string }> }) {
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [localError, setLocalError] = useState("");

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    setLocalError("");
    try {
      // Empty fields test the stored credentials; otherwise the just-typed ones.
      setTestResult(await onTest(password, privateKey));
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

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
          {testResult ? <p className={`text-xs font-medium ${testResult.ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger dark:text-red-400"}`}>{testResult.ok ? "✓ " : "✕ "}{testResult.message}</p> : null}
          <p className="text-xs text-slate-500 dark:text-slate-400">Stored Fernet-encrypted on the server and never sent back to the browser.</p>
          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" onClick={() => void runTest()} disabled={testing || busy} title={hasCredentials ? "Test the entered credentials, or the stored ones if blank" : "Test the entered credentials over SSH"} className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{testing ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />} Test connection</button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="h-10 rounded-full border border-line px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
              <button type="submit" disabled={saving || busy} className="h-10 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">{saving ? "Saving…" : "Save encrypted"}</button>
            </div>
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

// --- per-server monitoring (feature/server-monitoring) -------------------------------------

type LogSourceOption = { source: string; name_or_path: string; label: string };

// The log-shipping editor seeds its choices from what discovery already found on the host —
// systemd units (shipped from the journal), database log files, and Tomcat log files — so the
// operator picks real paths/units rather than typing them. Anything already shipped but no
// longer discovered is appended so it stays visible and selectable. Deduped by source+path.
function buildLogSourceOptions(server: Server | null, tomcatRows: TomcatInstance[], containers: ContainerInfo[], shipped: ServerLogSource[], suggested: ServerLogSource[] = []): LogSourceOption[] {
  const out: LogSourceOption[] = [];
  const seen = new Set<string>();
  const add = (source: string, name_or_path: string, label: string) => {
    if (!name_or_path) return;
    const key = `${source}|${name_or_path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, name_or_path, label });
  };
  for (const svc of server?.discovered_services ?? []) {
    if (svc.source === "systemd" && svc.name) add("journal", svc.name, `journal · ${svc.name}`);
  }
  for (const db of server?.database_logs ?? []) {
    if (db.path) add(db.source || "file", db.path, `${db.database || "database"} · ${db.path}`);
  }
  for (const inst of tomcatRows) {
    for (const file of inst.log_files ?? []) {
      if (file.path) add("file", file.path, `${inst.name} · ${file.name}`);
    }
  }
  for (const c of containers) {
    const rt = c.runtime || "docker";
    if (c.name) add(rt, c.name, `${rt} · ${c.name}`);
  }
  for (const s of suggested) add(s.source, s.name_or_path, `${s.source} · ${s.name_or_path}`);
  for (const s of shipped) add(s.source, s.name_or_path, `${s.source} · ${s.name_or_path}`);
  return out;
}

// Each range fixes both a window and a step chosen to keep ~60-120 points on the chart.
type MonRange = { key: string; label: string; seconds: number; step: number };
const MON_RANGES: MonRange[] = [
  { key: "15m", label: "15m", seconds: 15 * 60, step: 15 },
  { key: "1h", label: "1h", seconds: 60 * 60, step: 30 },
  { key: "6h", label: "6h", seconds: 6 * 60 * 60, step: 180 }
];

function monNowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// The server id is a uuid, but escape it anyway so it can never break out of the PromQL/LogQL
// double-quoted string selector.
function promLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function monFormatClock(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

type MonLine = { key: string; query: string; color: string; label: string };

// Merges the first series of each response into recharts rows keyed by timestamp, so a chart can
// carry several lines (e.g. network in/out) sharing one X axis. A non-finite Prometheus value
// (NaN/Inf) becomes null, leaving a gap.
function mergeSeries(parts: { key: string; resp: PromResponse | null }[]): Record<string, number | null>[] {
  const map = new Map<number, Record<string, number | null>>();
  for (const { key, resp } of parts) {
    const first = resp?.data?.result?.[0];
    if (!first?.values) continue;
    for (const [ts, raw] of first.values) {
      const num = Number(raw);
      const row = map.get(ts) ?? { t: ts };
      row[key] = Number.isFinite(num) ? num : null;
      map.set(ts, row);
    }
  }
  return Array.from(map.values()).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

// Drill-down: per-server metric charts (scoped by server_id) plus shipped-log tail, sharing one
// range selector + Refresh. Only meaningful once the agent is installed / logs are shipping;
// each panel shows its own empty state until then.
function ServerMonitoringDrilldown({ token, serverId, scraped }: { token: string; serverId: string; scraped: boolean }) {
  const [range, setRange] = useState<MonRange>(MON_RANGES[1]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [chartsOpen, setChartsOpen] = useState(true);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setChartsOpen((prev) => !prev)}
          aria-expanded={chartsOpen}
          className="flex items-center gap-2 text-sm font-semibold text-fg"
        >
          {chartsOpen ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
          <Activity size={16} className="text-accent" /> Metrics graphs
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${scraped ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${scraped ? "bg-emerald-500" : "bg-slate-400"}`} /> {scraped ? "scraped" : "not scraped"}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-edge bg-surface p-1">
            {MON_RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => { setRange(r); setRefreshKey((k) => k + 1); }}
                className={`h-7 rounded-full px-3 text-xs font-semibold transition-colors ${range.key === r.key ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-accent/10 px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent/20"
          >
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      {chartsOpen ? (
        <div className="grid gap-5 lg:grid-cols-2">
          {serverMetricCharts(serverId).map((c) => (
            <ServerChart key={c.id} token={token} title={c.title} subtitle={c.subtitle} unit={c.unit} range={range} refreshKey={refreshKey} lines={c.lines} />
          ))}
        </div>
      ) : null}

      <LokiLogViewer token={token} pinnedSelector={`server_id="${promLabel(serverId)}"`} title="Server logs" />
    </div>
  );
}

function ServerChart({
  token,
  title,
  subtitle,
  unit,
  lines,
  range,
  refreshKey
}: {
  token: string;
  title: string;
  subtitle?: string;
  unit?: string;
  lines: MonLine[];
  range: MonRange;
  refreshKey: number;
}) {
  const [data, setData] = useState<Record<string, number | null>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // lines is a fresh array literal each render; key the fetch off its query strings instead.
  const linesKey = lines.map((l) => `${l.key}:${l.query}`).join("~");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const end = monNowSec();
        const start = end - range.seconds;
        const resps = await Promise.all(lines.map((l) => promQueryRange(token, l.query, start, end, range.step)));
        if (!cancelled) setData(mergeSeries(lines.map((l, i) => ({ key: l.key, resp: resps[i] }))));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Query failed");
          setData([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, range.seconds, range.step, refreshKey, linesKey]);

  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        {subtitle ? <span className="text-xs font-medium text-muted">{subtitle}</span> : null}
      </div>
      <div className="h-56">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted"><Loader2 size={16} className="animate-spin" /> Loading…</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-2 text-center text-sm font-medium text-danger">{error}</div>
        ) : data.length === 0 ? (
          <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted">No metrics yet — install the agent.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="var(--im-edge)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="t" tickFormatter={monFormatClock} stroke="var(--im-muted)" tick={{ fontSize: 11 }} minTickGap={40} />
              <YAxis stroke="var(--im-muted)" tick={{ fontSize: 11 }} width={48} allowDecimals />
              <Tooltip
                contentStyle={{ background: "var(--im-elevated)", border: "1px solid var(--im-edge)", borderRadius: 12, fontSize: 12, color: "var(--im-fg)" }}
                labelFormatter={(t) => new Date(Number(t) * 1000).toLocaleString()}
                formatter={(value: number | string, name: string | number) => [
                  typeof value === "number" ? `${value.toPrecision(4)}${unit ? ` ${unit}` : ""}` : value,
                  lines.find((l) => l.key === name)?.label ?? String(name)
                ]}
              />
              {lines.map((l) => (
                <Line key={l.key} type="monotone" dataKey={l.key} name={l.key} stroke={l.color} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
