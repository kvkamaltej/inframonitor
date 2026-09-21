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
import { ChevronDown, Loader2, Plus } from "lucide-react";
import {
  createSshConfig,
  getSshConfigs,
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
};

export function emptySshTunnel(): SshTunnelValue {
  return { enabled: false, configId: "", host: "", port: 22, username: "", password: "", privateKey: "", hadStored: false };
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
    hadStored: Boolean(server.has_jump_credentials)
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
    hadStored: Boolean(conn.has_ssh_credentials)
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

// Same, for a DB connection's ssh_* tunnel fields.
export function dbTunnelPayload(v: SshTunnelValue) {
  if (!v.enabled) {
    return { ssh_host: "", ssh_port: 22, ssh_username: "", ssh_password: "", ssh_private_key: "", ssh_config_id: "" };
  }
  if (v.configId) {
    return { ssh_host: "", ssh_port: 22, ssh_username: "", ssh_password: "", ssh_private_key: "", ssh_config_id: v.configId };
  }
  return {
    ssh_host: v.host.trim(),
    ssh_port: Number(v.port) || 22,
    ssh_username: v.username.trim(),
    ssh_password: v.password,
    ssh_private_key: v.privateKey,
    ssh_config_id: ""
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
  kind: "server" | "db";
}) {
  const [configs, setConfigs] = useState<SshConfig[]>([]);
  const [loadError, setLoadError] = useState("");
  // inline "save as reusable config" affordance
  const [savingName, setSavingName] = useState<string | null>(null); // null = closed
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState("");

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
    onChange({ ...value, ...partial });
  }

  const selected = configs.find((c) => c.id === value.configId);
  const inline = value.configId === "";

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
      <label className="flex cursor-pointer items-center gap-2.5 px-4 py-2.5">
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
            optional — reach {kind === "server" ? "this server" : "the database"} through an SSH bastion
          </span>
        )}
      </label>

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
        </div>
      ) : null}
    </div>
  );
}
