"use client";

// Shared "connect through an SSH bastion" section, used by the add-server form, the edit-server
// dialog and the database connection dialog. A managed server's jump host and a DB connection's
// SSH tunnel are the same idea, so they share this control.
//
// The bastion is EITHER a reusable "global SSH config" (picked from a dropdown, defined once under
// Master Data) OR typed inline. The whole section is hidden behind an opt-in toggle: a direct
// connection shows nothing. Callers keep a single SshTunnelValue in state and map it to their own
// payload keys with serverJumpPayload / dbTunnelPayload.

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, PlugZap, Plus, X } from "lucide-react";
import {
  createSshConfig,
  getSshConfigs,
  testSshBastion,
  type DbConnection,
  type Server,
  type SshConfig
} from "@/lib/api";

export type SshTunnelValue = {
  // section opened / a bastion is in use. false => direct connection, nothing configured.
  enabled: boolean;
  // referenced reusable SSH config id, or "" to type the bastion inline.
  configId: string;
  // inline bastion fields (used only when configId === "").
  host: string;
  port: number;
  username: string;
  // write-only: blank on an edit keeps the stored credential.
  password: string;
  privateKey: string;
  // whether the entity being edited already had a stored inline credential (drives the placeholder).
  hadStored: boolean;
  // Optional SECOND hop (kube only): a saved SSH config used as a jump host in FRONT of the tunnel
  // host, so a control-plane node behind a bastion is reached app -> jump -> node -> API. "" = none.
  jumpConfigId: string;
};

export function emptySshTunnel(): SshTunnelValue {
  return { enabled: false, configId: "", host: "", port: 22, username: "", password: "", privateKey: "", hadStored: false, jumpConfigId: "" };
}

export function sshTunnelFromServer(server: Server): SshTunnelValue {
  return {
    enabled: Boolean(server.ssh_config_id) || Boolean(server.jump_host),
    configId: server.ssh_config_id || "",
    host: server.jump_host || "",
    port: server.jump_port || 22,
    username: server.jump_username || "",
    password: "",
    privateKey: "",
    hadStored: Boolean(server.has_jump_credentials),
    jumpConfigId: ""
  };
}

export function sshTunnelFromDbConnection(conn: DbConnection): SshTunnelValue {
  return {
    enabled: Boolean(conn.ssh_config_id) || Boolean(conn.ssh_host),
    configId: conn.ssh_config_id || "",
    host: conn.ssh_host || "",
    port: conn.ssh_port || 22,
    username: conn.ssh_username || "",
    password: "",
    privateKey: "",
    hadStored: Boolean(conn.has_ssh_credentials),
    jumpConfigId: ""
  };
}

// Same shape, from a Kubernetes cluster's ssh_* tunnel fields (reaches the API server via a bastion).
export function sshTunnelFromKubeCluster(cluster: {
  ssh_config_id?: string; ssh_host?: string; ssh_port?: number; ssh_username?: string; has_ssh_credentials?: boolean;
  ssh_jump_config_id?: string;
}): SshTunnelValue {
  return {
    enabled: Boolean(cluster.ssh_config_id) || Boolean(cluster.ssh_host) || Boolean(cluster.ssh_jump_config_id),
    configId: cluster.ssh_config_id || "",
    host: cluster.ssh_host || "",
    port: cluster.ssh_port || 22,
    username: cluster.ssh_username || "",
    password: "",
    privateKey: "",
    hadStored: Boolean(cluster.has_ssh_credentials),
    jumpConfigId: cluster.ssh_jump_config_id || ""
  };
}

// Payload for a server's jump-host fields. Disabled => everything cleared (and ssh_config_id ""
// unlinks any reference). A referenced config wins and blanks the inline fields; otherwise the
// inline values are sent. Blank jump_password/jump_private_key on an edit keep the stored ones.
export function serverJumpPayload(v: SshTunnelValue) {
  if (!v.enabled) {
    return { jump_host: "", jump_port: 22, jump_username: "", jump_password: "", jump_private_key: "", ssh_config_id: "" };
  }
  if (v.configId) {
    return { jump_host: "", jump_port: 22, jump_username: "", jump_password: "", jump_private_key: "", ssh_config_id: v.configId };
  }
  return {
    jump_host: v.host.trim(),
    jump_port: Number(v.port) || 22,
    jump_username: v.username.trim(),
    jump_password: v.password,
    jump_private_key: v.privateKey,
    ssh_config_id: ""
  };
}

// Same, for a DB connection's ssh_* tunnel fields. Also carries ssh_jump_config_id (the optional
// second-hop jump host); DB connections ignore that extra field, Kubernetes clusters use it.
export function dbTunnelPayload(v: SshTunnelValue) {
  if (!v.enabled) {
    return { ssh_host: "", ssh_port: 22, ssh_username: "", ssh_password: "", ssh_private_key: "", ssh_config_id: "", ssh_jump_config_id: "" };
  }
  const jump = { ssh_jump_config_id: v.jumpConfigId || "" };
  if (v.configId) {
    return { ssh_host: "", ssh_port: 22, ssh_username: "", ssh_password: "", ssh_private_key: "", ssh_config_id: v.configId, ...jump };
  }
  return {
    ssh_host: v.host.trim(),
    ssh_port: Number(v.port) || 22,
    ssh_username: v.username.trim(),
    ssh_password: v.password,
    ssh_private_key: v.privateKey,
    ssh_config_id: "",
    ...jump
  };
}

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";
const labelClass = "grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted";

export function SshTunnelSection({
  token,
  value,
  onChange,
  kind
}: {
  token: string;
  value: SshTunnelValue;
  onChange: (next: SshTunnelValue) => void;
  kind: "server" | "db" | "kube";
}) {
  const [configs, setConfigs] = useState<SshConfig[]>([]);
  const [loadError, setLoadError] = useState("");
  // inline "save as reusable config" affordance
  const [savingName, setSavingName] = useState<string | null>(null); // null = closed
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  // bastion connectivity probe
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);

  const title = kind === "server" ? "Jump host (bastion)" : "SSH tunnel (jump host)";
  const hostLabel = kind === "server" ? "Jump host / bastion" : "Jump host / bastion";
  const userHint = kind === "server" ? "defaults to the server's SSH user" : "bastion login";

  useEffect(() => {
    let alive = true;
    void getSshConfigs(token)
      .then((rows) => alive && setConfigs(rows))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : "Could not load saved SSH configs"));
    return () => {
      alive = false;
    };
  }, [token]);

  function patch(partial: Partial<SshTunnelValue>) {
    setTestNote(null); // any change invalidates the last probe result
    onChange({ ...value, ...partial });
  }

  // Remove the jump host entirely: collapse the section and clear every field, so saving unlinks any
  // referenced config and wipes the inline bastion (the backend also drops its stored credentials).
  function removeJump() {
    setTestNote(null);
    setSavingName(null);
    onChange({ ...value, enabled: false, configId: "", host: "", username: "", password: "", privateKey: "", jumpConfigId: "" });
  }

  async function testBastion() {
    setTesting(true);
    setTestNote(null);
    try {
      // With a jump host in front (kube two-hop), the tunnel host itself is NOT directly reachable,
      // so probe the JUMP host — the one hop this test can actually make. Otherwise probe the tunnel
      // host (a saved config or the inline details).
      const res = value.jumpConfigId
        ? await testSshBastion(token, { ssh_config_id: value.jumpConfigId })
        : value.configId
          ? await testSshBastion(token, { ssh_config_id: value.configId })
          : await testSshBastion(token, {
              host: value.host.trim(),
              port: Number(value.port) || 22,
              username: value.username.trim(),
              password: value.password,
              private_key: value.privateKey
            });
      const prefix = value.jumpConfigId ? "Jump host: " : "";
      setTestNote({ ok: res.ok, text: prefix + res.message });
    } catch (e) {
      setTestNote({ ok: false, text: e instanceof Error ? e.message : "Bastion test failed" });
    } finally {
      setTesting(false);
    }
  }

  const selected = configs.find((c) => c.id === value.configId);
  const canTest = value.jumpConfigId !== "" || value.configId !== "" || value.host.trim().length > 0;

  async function saveAsConfig() {
    const name = (savingName || "").trim();
    if (!name) {
      setSaveError("Name the config first.");
      return;
    }
    if (!value.host.trim()) {
      setSaveError("Enter a host before saving.");
      return;
    }
    setSaveBusy(true);
    setSaveError("");
    try {
      const created = await createSshConfig(token, {
        name,
        host: value.host.trim(),
        port: Number(value.port) || 22,
        username: value.username.trim(),
        password: value.password,
        private_key: value.privateKey
      });
      setConfigs((rows) => [...rows, created].sort((a, b) => a.name.localeCompare(b.name)));
      // switch the selection to the freshly-saved config and clear the now-redundant inline fields.
      onChange({ ...value, configId: created.id, host: "", username: "", password: "", privateKey: "" });
      setSavingName(null);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save the SSH config");
    } finally {
      setSaveBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-edge">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <label className="flex flex-1 cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="h-4 w-4 shrink-0 rounded border-edge text-accent focus:ring-accent"
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</span>
          {value.enabled ? (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
              {selected ? `via ${selected.name}` : value.host.trim() ? `via ${value.host.trim()}` : "on"}
            </span>
          ) : (
            <span className="text-[11px] font-normal normal-case text-muted">
              optional — reach {kind === "server" ? "this server" : kind === "kube" ? "the API server" : "the database"} through an SSH bastion
            </span>
          )}
        </label>
        {value.enabled ? (
          <button
            type="button"
            onClick={removeJump}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <X size={13} /> Remove jump host
          </button>
        ) : null}
      </div>

      {value.enabled ? (
        <div className="grid gap-3 border-t border-edge px-4 py-3 md:grid-cols-2">
          {/* Pick a saved config, or "Enter details manually" to type one inline. */}
          <label className={`${labelClass} md:col-span-2`}>
            SSH configuration
            <div className="relative">
              <select
                value={value.configId}
                onChange={(e) => patch({ configId: e.target.value })}
                className={`${inputClass} appearance-none pr-10`}
              >
                <option value="">Enter details manually…</option>
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.username ? `${c.username}@` : ""}{c.host}:{c.port}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
            </div>
            {loadError ? <span className="text-[11px] font-normal normal-case text-danger">{loadError}</span> : null}
          </label>

          {/* Second hop (kube only): the tunnel host above may itself be behind a jump host — e.g. a
              control-plane node reachable only via a bastion. app -> jump -> node -> API. */}
          {kind === "kube" ? (
            <label className={`${labelClass} md:col-span-2`}>
              Reached through jump host (optional)
              <div className="relative">
                <select
                  value={value.jumpConfigId}
                  onChange={(e) => patch({ jumpConfigId: e.target.value })}
                  className={`${inputClass} appearance-none pr-10`}
                >
                  <option value="">Direct — no jump host</option>
                  {configs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — {c.username ? `${c.username}@` : ""}{c.host}:{c.port}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
              </div>
              <span className="text-[11px] font-normal normal-case text-muted">
                Pick a bastion (a saved SSH config) if the host above is only reachable through one. The app then hops app → jump → host → API server.
              </span>
            </label>
          ) : null}

          {selected ? (
            <p className="md:col-span-2 rounded-lg bg-surface px-3 py-2 text-xs font-normal normal-case text-muted ring-1 ring-edge">
              Using saved config <span className="font-semibold text-fg">{selected.name}</span> —{" "}
              {selected.username ? `${selected.username}@` : ""}
              {selected.host}:{selected.port}
              {selected.has_password || selected.has_private_key ? " · credentials stored" : " · no stored credentials"}.
              Manage saved configs under Master Data → SSH configs.
            </p>
          ) : (
            <>
              <label className={labelClass}>
                {hostLabel}
                <input
                  value={value.host}
                  onChange={(e) => patch({ host: e.target.value })}
                  placeholder="bastion.example"
                  className={inputClass}
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className={labelClass}>
                  SSH port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={value.port}
                    onChange={(e) => patch({ port: Number(e.target.value) })}
                    className={inputClass}
                  />
                </label>
                <label className={labelClass}>
                  SSH user
                  <input
                    value={value.username}
                    onChange={(e) => patch({ username: e.target.value })}
                    placeholder={userHint}
                    className={inputClass}
                  />
                </label>
              </div>
              <label className={labelClass}>
                SSH password{" "}
                <span className="font-normal normal-case text-muted">{value.hadStored ? "(stored — blank keeps it)" : "(optional)"}</span>
                <input
                  type="password"
                  value={value.password}
                  onChange={(e) => patch({ password: e.target.value })}
                  autoComplete="new-password"
                  placeholder={value.hadStored ? "••••••••" : "optional"}
                  className={inputClass}
                />
              </label>
              <label className={`${labelClass} md:col-span-2`}>
                SSH private key <span className="font-normal normal-case text-muted">(blank keeps stored)</span>
                <textarea
                  value={value.privateKey}
                  onChange={(e) => patch({ privateKey: e.target.value })}
                  placeholder="optional — paste an OpenSSH private key"
                  className="min-h-20 w-full rounded-xl border-none bg-surface px-4 py-2 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent"
                />
              </label>

              {/* Optionally persist what was just typed as a reusable config, so the next server or
                  connection can pick it from the dropdown instead of retyping. */}
              {savingName === null ? (
                <button
                  type="button"
                  onClick={() => { setSavingName(""); setSaveError(""); }}
                  className="md:col-span-2 inline-flex w-fit items-center gap-1.5 text-xs font-semibold text-accent transition-colors hover:text-accent/80"
                >
                  <Plus size={14} /> Save these as a reusable SSH config
                </button>
              ) : (
                <div className="md:col-span-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2 ring-1 ring-edge">
                  <input
                    value={savingName}
                    onChange={(e) => setSavingName(e.target.value)}
                    placeholder="Config name, e.g. EMS bastion"
                    className="h-9 min-w-48 flex-1 rounded-lg border-none bg-elevated px-3 text-sm font-medium text-fg outline-none ring-1 ring-edge focus:ring-2 focus:ring-accent"
                  />
                  <button
                    type="button"
                    onClick={() => void saveAsConfig()}
                    disabled={saveBusy}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
                  >
                    {saveBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSavingName(null); setSaveError(""); }}
                    className="inline-flex h-9 items-center rounded-lg px-2 text-sm font-semibold text-muted transition-colors hover:text-fg"
                  >
                    Cancel
                  </button>
                  {saveError ? <span className="w-full text-[11px] font-medium text-danger">{saveError}</span> : null}
                </div>
              )}
            </>
          )}

          {/* Probe the bastion in isolation — does it accept an SSH login? — before saving the
              server / connection that will ride on it. Works for a saved config or inline details. */}
          <div className="md:col-span-2 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void testBastion()}
              disabled={testing || !canTest}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
              Test bastion
            </button>
            {testNote ? (
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-medium ${
                  testNote.ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger"
                }`}
              >
                {testNote.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                <span className="break-words">{testNote.text}</span>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
