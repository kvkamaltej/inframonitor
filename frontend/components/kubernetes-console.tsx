"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Boxes, CheckCircle2, Loader2, Pencil, PlugZap, Plus, Save, Trash2, X } from "lucide-react";
import {
  ApiError,
  createKubeCluster,
  deleteKubeCluster,
  getKubeClusters,
  testKubeCluster,
  updateKubeCluster,
  type KubeCluster,
  type KubeClusterInput
} from "@/lib/api";

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";
const textareaClass =
  "w-full resize-y rounded-xl border-none bg-surface px-4 py-3 font-mono text-sm text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

type AuthMethod = "kubeconfig" | "token";
type StatusNote = { kind: "ok" | "error"; text: string } | null;

// The kubectl recipe shown under "How do I get a token?". Kept as data so the guidance/command
// pairing stays exact and easy to read.
const TOKEN_HELP: { note: string; command?: string }[] = [
  {
    note: "Create a ServiceAccount and bind a role (use `view` for read-only, or `edit` if you enabled cluster actions like restart/scale):",
    command:
      "kubectl -n kube-system create serviceaccount inframonitor\nkubectl create clusterrolebinding inframonitor --clusterrole=edit --serviceaccount=kube-system:inframonitor"
  },
  {
    note: "Token (Kubernetes 1.24+):",
    command: "kubectl -n kube-system create token inframonitor --duration=8760h"
  },
  {
    note: "API server URL:",
    command: "kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'"
  },
  {
    note: "CA certificate (paste the PEM below):",
    command:
      "kubectl config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d"
  }
];

export function KubernetesConsole({ token }: { token: string }) {
  const router = useRouter();

  const [clusters, setClusters] = useState<KubeCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  // Form state. editingId is null for a new cluster, or the id of the cluster being edited (whose
  // credentials are never re-shown — leave the credential fields blank to keep the stored ones).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("kubeconfig");
  const [kubeconfig, setKubeconfig] = useState("");
  const [apiServerUrl, setApiServerUrl] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [caCert, setCaCert] = useState("");
  const [verifyTls, setVerifyTls] = useState(true);
  const [defaultNamespace, setDefaultNamespace] = useState("");
  const [group, setGroup] = useState("");

  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testNote, setTestNote] = useState<StatusNote>(null);
  const [formError, setFormError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  async function load() {
    setLoading(true);
    setListError("");
    try {
      setClusters(await getKubeClusters(token));
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Unable to load clusters");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setAuthMethod("kubeconfig");
    setKubeconfig("");
    setApiServerUrl("");
    setTokenValue("");
    setCaCert("");
    setVerifyTls(true);
    setDefaultNamespace("");
    setGroup("");
    setTestNote(null);
    setFormError("");
  }

  function startEdit(cluster: KubeCluster) {
    setEditingId(cluster.id);
    setName(cluster.name);
    setAuthMethod(cluster.auth_method);
    // Credentials are write-only, so they cannot be pre-filled; a blank credential field on save
    // keeps whatever is already stored server-side.
    setKubeconfig("");
    setApiServerUrl(cluster.api_server_url ?? "");
    setTokenValue("");
    setCaCert("");
    setVerifyTls(cluster.verify_tls);
    setDefaultNamespace(cluster.default_namespace ?? "");
    setGroup(cluster.group ?? "");
    setTestNote(null);
    setFormError("");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Assemble the input payload from the form. Credential fields are only included when non-empty so
  // an edit that leaves them blank keeps the stored credentials.
  function buildInput(): KubeClusterInput {
    const payload: KubeClusterInput = {
      name: name.trim(),
      auth_method: authMethod,
      default_namespace: defaultNamespace.trim() || undefined,
      group: group.trim() || null
    };
    if (authMethod === "kubeconfig") {
      if (kubeconfig.trim()) payload.kubeconfig = kubeconfig;
    } else {
      payload.api_server_url = apiServerUrl.trim();
      if (tokenValue.trim()) payload.token = tokenValue;
      if (caCert.trim()) payload.ca_cert = caCert;
      payload.verify_tls = verifyTls;
    }
    return payload;
  }

  async function test() {
    setTesting(true);
    setTestNote(null);
    try {
      const res = await testKubeCluster(token, buildInput());
      setTestNote({
        kind: res.ok ? "ok" : "error",
        text: res.version ? `${res.message} (${res.version})` : res.message
      });
    } catch (error) {
      setTestNote({ kind: "error", text: error instanceof Error ? error.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!name.trim()) {
      setFormError("Give the cluster a name.");
      return;
    }
    if (authMethod === "token" && !apiServerUrl.trim()) {
      setFormError("The API server URL is required for token auth.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      if (editingId) await updateKubeCluster(token, editingId, buildInput());
      else await createKubeCluster(token, buildInput());
      resetForm();
      await load();
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(cluster: KubeCluster) {
    if (!window.confirm(`Delete cluster "${cluster.name}"? This removes its stored credentials.`)) return;
    setListError("");
    try {
      await deleteKubeCluster(token, cluster.id);
      if (editingId === cluster.id) resetForm();
      await load();
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Delete failed");
    }
  }

  return (
    <div className="space-y-6 px-6 py-6">
      {/* Cluster list */}
      <div className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge px-6 py-5">
          <Boxes size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-fg">Clusters</h2>
          <span className="ml-2 text-xs font-medium text-muted">Select a cluster to view its nodes, pods and health.</span>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="flex items-center gap-2 text-sm font-medium text-muted">
              <Loader2 size={16} className="animate-spin" /> Loading clusters…
            </div>
          ) : listError ? (
            <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{listError}</span>
            </div>
          ) : clusters.length === 0 ? (
            <p className="text-sm font-medium text-muted">No clusters yet. Add one below to get started.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {clusters.map((cluster) => (
                <div
                  key={cluster.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/cluster?id=${encodeURIComponent(cluster.id)}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/cluster?id=${encodeURIComponent(cluster.id)}`);
                    }
                  }}
                  className="group flex cursor-pointer flex-col gap-3 rounded-2xl bg-surface p-5 ring-1 ring-edge transition-colors hover:ring-2 hover:ring-accent"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-fg">{cluster.name}</div>
                      <div className="mt-0.5 truncate text-xs font-medium text-muted" title={cluster.api_server_url}>
                        {cluster.api_server_url || "—"}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          startEdit(cluster);
                        }}
                        title="Edit cluster"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-accent/10 hover:text-accent"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(cluster);
                        }}
                        title="Delete cluster"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-accent">
                      {cluster.auth_method}
                    </span>
                    {cluster.group && (
                      <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-muted ring-1 ring-edge">
                        {cluster.group}
                      </span>
                    )}
                    {!cluster.has_credentials && (
                      <span className="rounded-full bg-danger/10 px-2.5 py-0.5 text-[11px] font-semibold text-danger dark:text-red-300">
                        no credentials
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add / edit form */}
      <div className="overflow-hidden rounded-3xl bg-elevated shadow-sm ring-1 ring-edge">
        <div className="flex items-center gap-3 border-b border-edge px-6 py-5">
          {editingId ? <Pencil size={18} className="text-accent" /> : <Plus size={18} className="text-accent" />}
          <h2 className="text-base font-semibold text-fg">{editingId ? "Edit cluster" : "Add cluster"}</h2>
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="ml-auto inline-flex items-center gap-1.5 text-xs font-semibold text-muted transition-colors hover:text-fg"
            >
              <X size={14} /> Cancel edit
            </button>
          )}
        </div>
        <div className="space-y-5 p-6">
          <div className="grid gap-4 md:grid-cols-3">
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-cluster" className={inputClass} />
            </label>
            <div className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Auth method
              <div className="flex h-11 items-center gap-1 rounded-xl bg-surface p-1 ring-1 ring-edge">
                {(["kubeconfig", "token"] as AuthMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => {
                      setAuthMethod(method);
                      setTestNote(null);
                    }}
                    className={`h-full flex-1 rounded-lg text-xs font-semibold capitalize transition-colors ${
                      authMethod === method ? "bg-accent text-white" : "text-muted hover:text-fg"
                    }`}
                  >
                    {method === "kubeconfig" ? "Kubeconfig" : "Token"}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {authMethod === "kubeconfig" ? (
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Paste kubeconfig
              <textarea
                value={kubeconfig}
                onChange={(e) => setKubeconfig(e.target.value)}
                rows={10}
                spellCheck={false}
                placeholder={editingId ? "Leave blank to keep the stored kubeconfig" : "apiVersion: v1\nkind: Config\nclusters:\n  - ..."}
                className={textareaClass}
              />
            </label>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
                API server URL
                <input
                  value={apiServerUrl}
                  onChange={(e) => setApiServerUrl(e.target.value)}
                  placeholder="https://10.0.0.1:6443"
                  className={inputClass}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
                Token
                <input
                  type="password"
                  value={tokenValue}
                  onChange={(e) => setTokenValue(e.target.value)}
                  autoComplete="new-password"
                  placeholder={editingId ? "Leave blank to keep the stored token" : "eyJhbGciOiJ..."}
                  className={inputClass}
                />
              </label>
              <label className="flex items-end gap-2 text-xs font-semibold uppercase tracking-wider text-muted">
                <span className="inline-flex h-11 items-center gap-2 rounded-xl bg-surface px-4 ring-1 ring-edge">
                  <input type="checkbox" checked={verifyTls} onChange={(e) => setVerifyTls(e.target.checked)} className="h-4 w-4 accent-[var(--inframonitor-accent)]" />
                  Verify TLS
                </span>
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
                CA certificate (PEM)
                <textarea
                  value={caCert}
                  onChange={(e) => setCaCert(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={editingId ? "Leave blank to keep the stored CA cert" : "-----BEGIN CERTIFICATE-----"}
                  className={textareaClass}
                />
              </label>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Default namespace (optional)
              <input
                value={defaultNamespace}
                onChange={(e) => setDefaultNamespace(e.target.value)}
                placeholder="default"
                className={inputClass}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
              Group (optional)
              <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="EMS" className={inputClass} />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void test()}
              disabled={testing || !name.trim()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-surface px-5 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:ring-2 hover:ring-accent disabled:opacity-50"
            >
              {testing ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
              Test
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !name.trim()}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {editingId ? "Save changes" : "Save cluster"}
            </button>
          </div>

          {testNote && (
            <div
              className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium ${
                testNote.kind === "ok"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "bg-danger/10 text-danger dark:text-red-300"
              }`}
            >
              {testNote.kind === "ok" ? (
                <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              )}
              <span className="break-words">{testNote.text}</span>
            </div>
          )}
          {formError && (
            <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span className="break-words">{formError}</span>
            </div>
          )}

          {/* Token help */}
          <div className="rounded-2xl bg-surface ring-1 ring-edge">
            <button
              type="button"
              onClick={() => setHelpOpen((v) => !v)}
              aria-expanded={helpOpen}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-fg"
            >
              How do I get a token?
              <span className="text-xs font-medium text-muted">{helpOpen ? "Hide" : "Show"}</span>
            </button>
            {helpOpen && (
              <div className="space-y-3 border-t border-edge px-4 py-4">
                {TOKEN_HELP.map((step, index) => (
                  <div key={index} className="space-y-2">
                    <p className="text-sm font-medium text-muted">{step.note}</p>
                    {step.command && (
                      <pre className="overflow-x-auto rounded-xl bg-page px-4 py-3 font-mono text-xs text-fg ring-1 ring-edge">
                        {step.command}
                      </pre>
                    )}
                  </div>
                ))}
                <p className="text-xs font-medium text-muted">Node cordon/uncordon needs extra permissions beyond `edit`.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
