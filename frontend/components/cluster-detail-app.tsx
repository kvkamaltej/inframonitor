"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Ban,
  Boxes,
  Calendar,
  Check,
  Copy,
  Cpu,
  FileText,
  HeartPulse,
  Info as InfoIcon,
  Layers,
  Loader2,
  MemoryStick,
  RefreshCw,
  RotateCw,
  ScrollText,
  Server,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  cordonKubeNode,
  deleteKubePod,
  getKubeCluster,
  getKubeDeployments,
  getKubeEvents,
  getKubeHealth,
  getKubeNamespaces,
  getKubeNodes,
  getKubeOverview,
  getKubePodLogs,
  getKubePods,
  getMe,
  KubeCluster,
  KubeDeployment,
  KubeEvent,
  KubeHealth,
  KubeNode,
  KubeOverview,
  KubePod,
  KubePodLogs,
  Me,
  restartKubeDeployment,
  restartKubePod,
  scaleKubeDeployment
} from "@/lib/api";
import { Sidebar } from "@/components/sidebar";

type Tab = "overview" | "nodes" | "pods" | "workloads" | "logs" | "health" | "events";
type Tone = "info" | "error";

const TABS: Array<[Tab, string]> = [
  ["overview", "Overview"],
  ["nodes", "Nodes"],
  ["pods", "Pods"],
  ["workloads", "Workloads"],
  ["logs", "Logs"],
  ["health", "Health"],
  ["events", "Events"]
];

export function ClusterDetailApp({ clusterId }: { clusterId: string }) {
  const [token, setToken] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [cluster, setCluster] = useState<KubeCluster | null>(null);
  const [overview, setOverview] = useState<KubeOverview | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [initializing, setInitializing] = useState(true);
  const [loadError, setLoadError] = useState("");

  // Per-tab data + "have we fetched this tab yet" flags, so opening a tab fetches once
  // rather than on every switch. Namespace-scoped tabs re-fetch when the namespace changes.
  const [nodes, setNodes] = useState<KubeNode[]>([]);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespacesLoaded, setNamespacesLoaded] = useState(false);
  const [namespace, setNamespace] = useState(""); // shared across pods/workloads/events; "" = all
  const [pods, setPods] = useState<KubePod[]>([]);
  const [podsLoaded, setPodsLoaded] = useState(false);
  const [deployments, setDeployments] = useState<KubeDeployment[]>([]);
  const [deploymentsLoaded, setDeploymentsLoaded] = useState(false);
  const [health, setHealth] = useState<KubeHealth | null>(null);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [events, setEvents] = useState<KubeEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);

  // Logs tab inputs. Populated when arriving from a pod row, or typed by the operator.
  const [logsNamespace, setLogsNamespace] = useState("");
  const [logsPod, setLogsPod] = useState("");
  const [logsContainer, setLogsContainer] = useState("");
  const [logsContainers, setLogsContainers] = useState<string[]>([]);
  const [logsTail, setLogsTail] = useState(200);
  const [logsPrevious, setLogsPrevious] = useState(false);
  const [podLogs, setPodLogs] = useState<KubePodLogs | null>(null);
  const [logsCopied, setLogsCopied] = useState(false);

  const [message, setMessage] = useState("");
  const [tone, setTone] = useState<Tone>("info");
  // Which action is in flight ("" = idle); every `disabled={loading}` serialises requests.
  const [busy, setBusy] = useState("");
  const loading = busy !== "";

  // Toast auto-dismiss: info fades after a few seconds, errors persist until dismissed.
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

  function errText(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
  }

  // ---- loaders --------------------------------------------------------------------------
  async function loadOverview(activeToken = token) {
    setBusy("overview");
    try {
      const next = await getKubeOverview(activeToken, clusterId);
      setOverview(next);
    } catch (error) {
      notify(errText(error, "Unable to load cluster overview"), "error");
    } finally {
      setBusy("");
    }
  }

  async function loadNodes() {
    setBusy("nodes");
    try {
      setNodes(await getKubeNodes(token, clusterId));
      setNodesLoaded(true);
    } catch (error) {
      notify(errText(error, "Unable to load nodes"), "error");
    } finally {
      setBusy("");
    }
  }

  async function ensureNamespaces() {
    if (namespacesLoaded) return;
    try {
      setNamespaces(await getKubeNamespaces(token, clusterId));
    } catch {
      // non-fatal: the select simply offers "All namespaces" only.
    } finally {
      setNamespacesLoaded(true);
    }
  }

  async function loadPods(ns = namespace) {
    setBusy("pods");
    try {
      setPods(await getKubePods(token, clusterId, ns || undefined));
      setPodsLoaded(true);
    } catch (error) {
      notify(errText(error, "Unable to load pods"), "error");
    } finally {
      setBusy("");
    }
  }

  async function loadDeployments(ns = namespace) {
    setBusy("workloads");
    try {
      setDeployments(await getKubeDeployments(token, clusterId, ns || undefined));
      setDeploymentsLoaded(true);
    } catch (error) {
      notify(errText(error, "Unable to load workloads"), "error");
    } finally {
      setBusy("");
    }
  }

  async function loadHealth() {
    setBusy("health");
    try {
      setHealth(await getKubeHealth(token, clusterId));
      setHealthLoaded(true);
    } catch (error) {
      notify(errText(error, "Unable to load health"), "error");
    } finally {
      setBusy("");
    }
  }

  async function loadEvents(ns = namespace) {
    setBusy("events");
    try {
      setEvents(await getKubeEvents(token, clusterId, ns || undefined));
      setEventsLoaded(true);
    } catch (error) {
      notify(errText(error, "Unable to load events"), "error");
    } finally {
      setBusy("");
    }
  }

  async function loadLogs(ns = logsNamespace, pod = logsPod, container = logsContainer) {
    if (!ns || !pod) {
      notify("Enter a namespace and a pod name first.", "error");
      return;
    }
    setBusy("logs");
    try {
      const next = await getKubePodLogs(token, clusterId, ns, pod, {
        container: container || undefined,
        tail: logsTail,
        previous: logsPrevious
      });
      setPodLogs(next);
    } catch (error) {
      notify(errText(error, "Unable to load pod logs"), "error");
    } finally {
      setBusy("");
    }
  }

  // Copy the current log output. Uses the async Clipboard API in a secure context (localhost /
  // https) and falls back to a hidden-textarea execCommand so it also works over plain http on a
  // LAN IP, where navigator.clipboard is unavailable.
  async function copyLogs() {
    const text = podLogs?.log ?? "";
    if (!text.trim()) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setLogsCopied(true);
      window.setTimeout(() => setLogsCopied(false), 1500);
    } catch {
      notify("Could not copy to the clipboard.", "error");
    }
  }

  // ---- initial + lazy loading ------------------------------------------------------------
  useEffect(() => {
    const saved = window.localStorage.getItem("inframonitor-token") ?? "";
    setToken(saved);
    (async () => {
      try {
        const [c, o] = await Promise.all([getKubeCluster(saved, clusterId), getKubeOverview(saved, clusterId)]);
        setCluster(c);
        setOverview(o);
      } catch (error) {
        setLoadError(errText(error, "Unable to load cluster"));
      } finally {
        setInitializing(false);
      }
      // Sidebar menu set; non-fatal (falls back to per-role defaults if it fails).
      getMe(saved).then(setMe).catch(() => undefined);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  // Lazily fetch a tab's data the first time it is opened.
  useEffect(() => {
    if (initializing) return;
    if (tab === "nodes" && !nodesLoaded) void loadNodes();
    if (tab === "pods" && !podsLoaded) { void ensureNamespaces(); void loadPods(); }
    if (tab === "workloads" && !deploymentsLoaded) { void ensureNamespaces(); void loadDeployments(); }
    if (tab === "health" && !healthLoaded) void loadHealth();
    if (tab === "events" && !eventsLoaded) { void ensureNamespaces(); void loadEvents(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, initializing]);

  function refreshActive() {
    if (tab === "overview") return void loadOverview();
    if (tab === "nodes") return void loadNodes();
    if (tab === "pods") return void loadPods();
    if (tab === "workloads") return void loadDeployments();
    if (tab === "health") return void loadHealth();
    if (tab === "events") return void loadEvents();
    if (tab === "logs") return void loadLogs();
  }

  function changeNamespace(ns: string) {
    setNamespace(ns);
    if (tab === "pods") void loadPods(ns);
    else if (tab === "workloads") void loadDeployments(ns);
    else if (tab === "events") void loadEvents(ns);
  }

  // ---- mutations -------------------------------------------------------------------------
  function openPodLogs(pod: KubePod) {
    const container = pod.containers[0] ?? "";
    setLogsNamespace(pod.namespace);
    setLogsPod(pod.name);
    setLogsContainers(pod.containers ?? []);
    setLogsContainer(container);
    setPodLogs(null);
    setTab("logs");
    void loadLogs(pod.namespace, pod.name, container);
  }

  async function restartPod(pod: KubePod) {
    if (!window.confirm(`Restart pod "${pod.name}" in ${pod.namespace}? Its container(s) will be restarted.`)) return;
    setBusy(`pod-restart:${pod.namespace}/${pod.name}`);
    try {
      const result = await restartKubePod(token, clusterId, pod.namespace, pod.name);
      notify(result.message || `Restart requested for ${pod.name}`, result.ok ? "info" : "error");
      await loadPods();
    } catch (error) {
      notify(errText(error, "Unable to restart pod"), "error");
    } finally {
      setBusy("");
    }
  }

  async function removePod(pod: KubePod) {
    if (!window.confirm(`Delete pod "${pod.name}" in ${pod.namespace}? Its controller will normally recreate it.`)) return;
    setBusy(`pod-delete:${pod.namespace}/${pod.name}`);
    try {
      const result = await deleteKubePod(token, clusterId, pod.namespace, pod.name);
      notify(result.message || `Delete requested for ${pod.name}`, result.ok ? "info" : "error");
      await loadPods();
    } catch (error) {
      notify(errText(error, "Unable to delete pod"), "error");
    } finally {
      setBusy("");
    }
  }

  async function toggleCordon(node: KubeNode) {
    // Follows the api contract: pass `!schedulable`. A schedulable node's button cordons it,
    // an already-cordoned node's button uncordons it.
    const cordoning = node.schedulable;
    if (!window.confirm(`${cordoning ? "Cordon" : "Uncordon"} node "${node.name}"?`)) return;
    setBusy(`node:${node.name}`);
    try {
      const result = await cordonKubeNode(token, clusterId, node.name, !node.schedulable);
      notify(result.message || `${cordoning ? "Cordoned" : "Uncordoned"} ${node.name}`, result.ok ? "info" : "error");
      await loadNodes();
    } catch (error) {
      notify(errText(error, "Cordon failed — this may require extra cluster permissions."), "error");
    } finally {
      setBusy("");
    }
  }

  async function scaleDeployment(dep: KubeDeployment) {
    const input = window.prompt(`Scale deployment "${dep.name}" to how many replicas?`, String(dep.replicas));
    if (input === null) return;
    const replicas = Number(input.trim());
    if (!Number.isInteger(replicas) || replicas < 0) {
      notify("Replicas must be a whole number, zero or greater.", "error");
      return;
    }
    setBusy(`dep-scale:${dep.namespace}/${dep.name}`);
    try {
      const result = await scaleKubeDeployment(token, clusterId, dep.namespace, dep.name, replicas);
      notify(result.message || `Scaled ${dep.name} to ${replicas}`, result.ok ? "info" : "error");
      await loadDeployments();
    } catch (error) {
      notify(errText(error, "Unable to scale deployment"), "error");
    } finally {
      setBusy("");
    }
  }

  async function restartDeployment(dep: KubeDeployment) {
    if (!window.confirm(`Restart deployment "${dep.name}" in ${dep.namespace}? This triggers a rolling restart of its pods.`)) return;
    setBusy(`dep-restart:${dep.namespace}/${dep.name}`);
    try {
      const result = await restartKubeDeployment(token, clusterId, dep.namespace, dep.name);
      notify(result.message || `Rolling restart requested for ${dep.name}`, result.ok ? "info" : "error");
      await loadDeployments();
    } catch (error) {
      notify(errText(error, "Unable to restart deployment"), "error");
    } finally {
      setBusy("");
    }
  }

  if (initializing) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <main className="flex min-h-screen">
      <Sidebar role={me?.role} guest={me?.guest} menus={me?.menus} />
      <div className="min-w-0 flex-1">
        <header className="border-b border-edge bg-elevated">
          <div className="flex items-center justify-between px-6 pl-16 py-5">
            <div className="min-w-0">
              <Link href="/kubernetes" className="mb-2 inline-flex items-center gap-2 text-sm text-accent"><ArrowLeft size={16} /> Kubernetes Clusters</Link>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-normal"><Boxes size={22} className="text-accent" /> {cluster?.name ?? "Cluster"}</h1>
              <p className="mt-1 break-all text-sm text-slate-600 dark:text-slate-300">{cluster?.api_server_url ?? clusterId}</p>
            </div>
            <div className="flex items-center gap-3">
              {overview ? <HealthBadge ok={overview.health_ok} /> : null}
              <button
                type="button"
                disabled={loading}
                onClick={() => refreshActive()}
                title="Refresh the current tab"
                className="inline-flex h-9 items-center gap-2 rounded-full bg-accent/10 px-4 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:hover:bg-accent/30"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} Refresh
              </button>
            </div>
          </div>
        </header>

        <section className="px-6 py-6">
          <section className="space-y-6">
            {message ? (
              <div className={`fixed bottom-5 right-5 z-[70] flex max-w-sm items-start gap-3 rounded-2xl border px-4 py-3 text-sm shadow-lg ${tone === "error" ? "border-danger/30 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-950 dark:text-red-100" : "border-accent/30 bg-white text-slate-700 dark:border-accent/40 dark:bg-slate-900 dark:text-slate-100"}`}>
                {tone === "error" ? <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger dark:text-red-400" /> : <InfoIcon size={16} className="mt-0.5 shrink-0 text-accent" />}
                <span className="min-w-0 flex-1 break-words font-medium">{message}</span>
                <button type="button" onClick={() => notify("")} aria-label="Dismiss" className="-mr-1 -mt-0.5 shrink-0 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"><X size={14} /></button>
              </div>
            ) : null}

            {loadError && !cluster ? (
              <div className="rounded-2xl border border-danger/30 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 dark:border-red-500/40 dark:bg-red-950 dark:text-red-100">
                {loadError}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {TABS.map(([key, label]) => (
                <button key={key} onClick={() => setTab(key)} className={`h-9 rounded-full border px-4 text-sm font-medium transition-colors ${tab === key ? "border-accent bg-accent text-white" : "border-line text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"}`}>{label}</button>
              ))}
            </div>

            {tab === "overview" ? <OverviewTab overview={overview} /> : null}

            {tab === "nodes" ? (
              <Panel title="Nodes" icon={<Server size={18} />}>
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
                    <tr>
                      {["Name", "Status", "Roles", "Kubelet", "Internal IP", "CPU", "Memory", "Age", "Scheduling", ""].map((h, i) => <th key={i} className="px-4 py-3 font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {nodes.map((node) => (
                      <tr key={node.name}>
                        <td className="px-4 py-3 font-medium">{node.name}</td>
                        <td className="px-4 py-3"><Badge tone={node.status === "Ready" ? "green" : "red"}>{node.status}</Badge></td>
                        <td className="px-4 py-3">{node.roles.length ? node.roles.join(", ") : "-"}</td>
                        <td className="px-4 py-3">{node.kubelet_version || "-"}</td>
                        <td className="px-4 py-3">{node.internal_ip || "-"}</td>
                        <td className="px-4 py-3">{node.cpu_capacity || "-"}</td>
                        <td className="px-4 py-3">{node.memory_capacity || "-"}</td>
                        <td className="px-4 py-3">{node.age || "-"}</td>
                        <td className="px-4 py-3">{node.schedulable ? <Badge tone="green">Schedulable</Badge> : <Badge tone="amber">Cordoned</Badge>}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            {node.linked_server_id ? (
                              <Link href={`/server/?id=${encodeURIComponent(node.linked_server_id)}&shell=1`} title={`Open a shell on ${node.linked_server_alias || node.name} (via its linked server)`} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">
                                <Terminal size={12} /> Shell{node.linked_server_alias ? ` · ${node.linked_server_alias}` : ""}
                              </Link>
                            ) : (
                              <span title="No server is linked to this node. Add a server whose IP or hostname matches this node to open a shell." className="inline-flex items-center gap-1 rounded-full bg-slate-100/60 px-3 py-1 text-xs font-medium text-muted dark:bg-slate-800/50">
                                <Terminal size={12} /> No shell
                              </span>
                            )}
                            <button disabled={loading} onClick={() => void toggleCordon(node)} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:hover:bg-accent/30">
                              {busy === `node:${node.name}` ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />} {node.schedulable ? "Cordon" : "Uncordon"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {nodes.length === 0 ? <tr><td className="px-4 py-6 text-muted" colSpan={10}>No nodes reported.</td></tr> : null}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-muted">Cordoning a node may require extra cluster permissions; if it fails, an error is shown above.</p>
              </Panel>
            ) : null}

            {tab === "pods" ? (
              <Panel
                title="Pods"
                icon={<Boxes size={18} />}
                action={<NamespaceSelect value={namespace} namespaces={namespaces} onChange={changeNamespace} />}
              >
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
                    <tr>
                      {["Name", "Namespace", "Phase", "Ready", "Restarts", "Node", "Age", ""].map((h, i) => <th key={i} className="px-4 py-3 font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {pods.map((pod) => (
                      <tr key={`${pod.namespace}/${pod.name}`}>
                        <td className="px-4 py-3 font-medium">{pod.name}</td>
                        <td className="px-4 py-3">{pod.namespace}</td>
                        <td className="px-4 py-3"><Badge tone={phaseTone(pod.phase)}>{pod.phase}</Badge></td>
                        <td className="px-4 py-3">{pod.ready || "-"}</td>
                        <td className="px-4 py-3">{pod.restarts}</td>
                        <td className="px-4 py-3">{pod.node || "-"}</td>
                        <td className="px-4 py-3">{pod.age || "-"}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button onClick={() => openPodLogs(pod)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"><ScrollText size={12} /> Logs</button>
                            <button disabled={loading} onClick={() => void restartPod(pod)} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:hover:bg-accent/30">{busy === `pod-restart:${pod.namespace}/${pod.name}` ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Restart</button>
                            <button disabled={loading} onClick={() => void removePod(pod)} className="inline-flex items-center gap-1 rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-800 transition-colors hover:bg-red-200 disabled:opacity-50 dark:bg-red-900/40 dark:text-red-200 dark:hover:bg-red-900/60">{busy === `pod-delete:${pod.namespace}/${pod.name}` ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {pods.length === 0 ? <tr><td className="px-4 py-6 text-muted" colSpan={8}>No pods in {namespace || "any namespace"}.</td></tr> : null}
                  </tbody>
                </table>
              </Panel>
            ) : null}

            {tab === "workloads" ? (
              <Panel
                title="Deployments"
                icon={<Layers size={18} />}
                action={<NamespaceSelect value={namespace} namespaces={namespaces} onChange={changeNamespace} />}
              >
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
                    <tr>
                      {["Name", "Namespace", "Ready", "Replicas", "Available", "Updated", "Age", ""].map((h, i) => <th key={i} className="px-4 py-3 font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {deployments.map((dep) => (
                      <tr key={`${dep.namespace}/${dep.name}`}>
                        <td className="px-4 py-3 font-medium">{dep.name}</td>
                        <td className="px-4 py-3">{dep.namespace}</td>
                        <td className="px-4 py-3">{dep.ready || "-"}</td>
                        <td className="px-4 py-3">{dep.replicas}</td>
                        <td className="px-4 py-3">{dep.available}</td>
                        <td className="px-4 py-3">{dep.updated}</td>
                        <td className="px-4 py-3">{dep.age || "-"}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button disabled={loading} onClick={() => void scaleDeployment(dep)} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700">{busy === `dep-scale:${dep.namespace}/${dep.name}` ? <Loader2 size={12} className="animate-spin" /> : null} Scale</button>
                            <button disabled={loading} onClick={() => void restartDeployment(dep)} className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-50 dark:bg-accent/20 dark:hover:bg-accent/30">{busy === `dep-restart:${dep.namespace}/${dep.name}` ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />} Restart</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {deployments.length === 0 ? <tr><td className="px-4 py-6 text-muted" colSpan={8}>No deployments in {namespace || "any namespace"}.</td></tr> : null}
                  </tbody>
                </table>
              </Panel>
            ) : null}

            {tab === "logs" ? (
              <Panel title="Pod Logs" icon={<FileText size={18} />}>
                <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">Namespace</span>
                    <input value={logsNamespace} onChange={(event) => setLogsNamespace(event.target.value)} placeholder="e.g. default" className="h-10 rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">Pod</span>
                    <input value={logsPod} onChange={(event) => setLogsPod(event.target.value)} placeholder="pod name" className="h-10 rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">Container</span>
                    {logsContainers.length ? (
                      <select value={logsContainer} onChange={(event) => setLogsContainer(event.target.value)} className="h-10 cursor-pointer rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                        {logsContainers.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    ) : (
                      <input value={logsContainer} onChange={(event) => setLogsContainer(event.target.value)} placeholder="default container" className="h-10 rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                    )}
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted">Tail lines</span>
                    <input type="number" min={1} value={logsTail} onChange={(event) => setLogsTail(Math.max(1, Number(event.target.value) || 1))} className="h-10 rounded-xl border border-line bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                  </label>
                </div>
                <div className="mb-4 flex flex-wrap items-center gap-3">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input type="checkbox" checked={logsPrevious} onChange={(event) => setLogsPrevious(event.target.checked)} className="h-4 w-4 rounded border-line text-accent focus:ring-accent" />
                    Previous (crashed) container
                  </label>
                  <button disabled={loading} onClick={() => void loadLogs()} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">{busy === "logs" ? <Loader2 size={16} className="animate-spin" /> : <ScrollText size={16} />} Load logs</button>
                  <button type="button" disabled={!podLogs?.log?.trim()} onClick={() => void copyLogs()} title="Copy the log output to the clipboard" className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">{logsCopied ? <Check size={16} /> : <Copy size={16} />} {logsCopied ? "Copied" : "Copy"}</button>
                </div>
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">{podLogs ? (podLogs.log?.trim() ? podLogs.log : `No log output for ${logsPod || "this pod"}.`) : "Choose a pod (from the Pods tab) or type a namespace + pod, then Load logs."}</pre>
              </Panel>
            ) : null}

            {tab === "health" ? <HealthTab health={health} /> : null}

            {tab === "events" ? (
              <Panel
                title="Events"
                icon={<Calendar size={18} />}
                action={<NamespaceSelect value={namespace} namespaces={namespaces} onChange={changeNamespace} />}
              >
                <EventsTable events={events} emptyLabel={`No events in ${namespace || "any namespace"}.`} />
              </Panel>
            ) : null}
          </section>
        </section>
      </div>
    </main>
  );
}

// ---- sub-views ---------------------------------------------------------------------------

function OverviewTab({ overview }: { overview: KubeOverview | null }) {
  if (!overview) return <Panel title="Overview" icon={<Activity size={18} />}><p className="text-sm text-muted">No overview available.</p></Panel>;
  const phases = overview.pods_by_phase;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Info icon={<Activity size={16} />} title="Kubernetes" value={overview.version || "-"} hint={overview.platform || "cluster"} />
        <Info icon={<HeartPulse size={16} />} title="Control plane" value={overview.health_ok ? "Healthy" : "Degraded"} tone={overview.health_ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger dark:text-red-400"} />
        <Info icon={<Server size={16} />} title="Nodes ready" value={`${overview.nodes_ready} / ${overview.node_count}`} hint="ready / total" />
        <Info icon={<Layers size={16} />} title="Namespaces" value={String(overview.namespace_count)} />
        <Info icon={<Boxes size={16} />} title="Pods" value={String(overview.pod_count)} hint="across all namespaces" />
        <Info icon={<Cpu size={16} />} title="CPU capacity" value={overview.cpu_capacity || "-"} />
        <Info icon={<MemoryStick size={16} />} title="Memory capacity" value={overview.memory_capacity || "-"} />
      </div>

      <div>
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200"><Boxes size={16} className="text-accent" /> Pods by phase</div>
        <div className="flex flex-wrap gap-2">
          <PhaseChip label="Running" value={phases.Running} tone="green" />
          <PhaseChip label="Pending" value={phases.Pending} tone="amber" />
          <PhaseChip label="Failed" value={phases.Failed} tone="red" />
          <PhaseChip label="Succeeded" value={phases.Succeeded} tone="slate" />
          <PhaseChip label="Unknown" value={phases.Unknown} tone="slate" />
        </div>
      </div>

      <Panel title="Warnings" icon={<AlertTriangle size={18} />}>
        <EventsTable events={overview.warnings ?? []} emptyLabel="No active warnings." />
      </Panel>
    </div>
  );
}

function HealthTab({ health }: { health: KubeHealth | null }) {
  if (!health) return <Panel title="Health" icon={<HeartPulse size={18} />}><p className="text-sm text-muted">No health data available.</p></Panel>;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Info icon={<HeartPulse size={16} />} title="livez" value={health.livez_ok ? "OK" : "Failing"} tone={health.livez_ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger dark:text-red-400"} />
        <Info icon={<HeartPulse size={16} />} title="readyz" value={health.readyz_ok ? "OK" : "Failing"} tone={health.readyz_ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger dark:text-red-400"} />
      </div>

      <Panel title="Readiness checks" icon={<Activity size={18} />}>
        {health.readyz.length ? (
          <div className="flex flex-wrap gap-2">
            {health.readyz.map((check) => (
              <span key={check.name} className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${check.ok ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${check.ok ? "bg-emerald-500" : "bg-red-500"}`} /> {check.name}
              </span>
            ))}
          </div>
        ) : <p className="text-sm text-muted">No readiness checks reported.</p>}
      </Panel>

      <Panel title="Component statuses" icon={<Server size={18} />}>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface text-xs uppercase tracking-wider text-muted"><tr>{["Name", "Healthy", "Message"].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-edge">
            {health.component_statuses.map((c) => (
              <tr key={c.name}>
                <td className="px-4 py-3 font-medium">{c.name}</td>
                <td className="px-4 py-3"><Badge tone={c.healthy ? "green" : "red"}>{c.healthy ? "Healthy" : "Unhealthy"}</Badge></td>
                <td className="px-4 py-3 break-words">{c.message || "-"}</td>
              </tr>
            ))}
            {health.component_statuses.length === 0 ? <tr><td className="px-4 py-6 text-muted" colSpan={3}>No component statuses reported.</td></tr> : null}
          </tbody>
        </table>
      </Panel>

      <Panel title="Control plane pods" icon={<Boxes size={18} />}>
        <table className="w-full text-left text-sm">
          <thead className="bg-surface text-xs uppercase tracking-wider text-muted"><tr>{["Name", "Namespace", "Phase", "Ready", "Restarts"].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-edge">
            {health.control_plane_pods.map((p) => (
              <tr key={`${p.namespace}/${p.name}`}>
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3">{p.namespace}</td>
                <td className="px-4 py-3"><Badge tone={phaseTone(p.phase)}>{p.phase}</Badge></td>
                <td className="px-4 py-3"><Badge tone={p.ready ? "green" : "red"}>{p.ready ? "Ready" : "Not ready"}</Badge></td>
                <td className="px-4 py-3">{p.restarts}</td>
              </tr>
            ))}
            {health.control_plane_pods.length === 0 ? <tr><td className="px-4 py-6 text-muted" colSpan={5}>No control plane pods reported.</td></tr> : null}
          </tbody>
        </table>
      </Panel>

      <Panel title="Add-ons" icon={<Layers size={18} />}>
        {health.addons.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {health.addons.map((addon) => (
              <div key={addon.name} className="rounded-xl border border-line bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{addon.name}</span>
                  <Badge tone={addon.healthy ? "green" : "red"}>{addon.healthy ? "Healthy" : "Down"}</Badge>
                </div>
                {addon.detail ? <p className="mt-1 break-words text-xs text-muted">{addon.detail}</p> : null}
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted">No add-ons reported.</p>}
      </Panel>
    </div>
  );
}

function EventsTable({ events, emptyLabel }: { events: KubeEvent[]; emptyLabel: string }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="bg-surface text-xs uppercase tracking-wider text-muted">
        <tr>{["Type", "Reason", "Object", "Message", "Count", "Last seen"].map((h) => <th key={h} className="px-4 py-3 font-semibold">{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-edge">
        {events.map((event, index) => (
          <tr key={`${event.namespace}/${event.object}/${event.reason}/${index}`}>
            <td className="px-4 py-3"><Badge tone={event.type === "Warning" ? "amber" : "slate"}>{event.type}</Badge></td>
            <td className="px-4 py-3 font-medium">{event.reason || "-"}</td>
            <td className="px-4 py-3">{event.object || "-"}{event.namespace ? <span className="text-muted"> · {event.namespace}</span> : null}</td>
            <td className="px-4 py-3 max-w-md break-words">{event.message || "-"}</td>
            <td className="px-4 py-3">{event.count}</td>
            <td className="px-4 py-3">{event.last_seen || "-"}</td>
          </tr>
        ))}
        {events.length === 0 ? <tr><td className="px-4 py-6 text-muted" colSpan={6}>{emptyLabel}</td></tr> : null}
      </tbody>
    </table>
  );
}

function NamespaceSelect({ value, namespaces, onChange }: { value: string; namespaces: string[]; onChange: (ns: string) => void }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Filter by namespace" className="h-9 cursor-pointer rounded-full border border-line bg-white px-3 text-xs font-semibold text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
      <option value="">All namespaces</option>
      {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
    </select>
  );
}

// ---- small presentational helpers --------------------------------------------------------

type BadgeTone = "green" | "red" | "amber" | "slate";
const BADGE_TONES: Record<BadgeTone, string> = {
  green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  red: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-700/40 dark:text-slate-300"
};

function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE_TONES[tone]}`}>{children}</span>;
}

function phaseTone(phase: string): BadgeTone {
  const value = (phase || "").toLowerCase();
  if (value === "running" || value === "succeeded") return "green";
  if (value === "pending") return "amber";
  if (value === "failed") return "red";
  return "slate";
}

function HealthBadge({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${ok ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" : "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} /> {ok ? "Healthy" : "Degraded"}
    </span>
  );
}

function PhaseChip({ label, value, tone }: { label: string; value: number; tone: BadgeTone }) {
  return (
    <div className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold ${BADGE_TONES[tone]}`}>
      <span>{label}</span>
      <span className="rounded-full bg-white/60 px-2 py-0.5 text-xs dark:bg-black/20">{value}</span>
    </div>
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
