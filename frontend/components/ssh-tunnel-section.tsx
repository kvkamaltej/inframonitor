"use client";

// Dropdown-only picker for a server's jump host / a database connection's SSH tunnel: the bastion is
// chosen from the reusable SSH configs (managed under Master Data -> SSH configs). There is no inline
// host/user/key entry here — that keeps the add/edit forms clean and keeps every bastion defined in
// one place. (Kubernetes uses its own multi-hop SshChainPicker.)

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, PlugZap, X } from "lucide-react";
import {
  getSshConfigs,
  testSshBastion,
  type DbConnection,
  type Server,
  type SshConfig
} from "@/lib/api";

export type SshTunnelValue = {
  // section opened / a bastion is in use. false => direct connection.
  enabled: boolean;
  // referenced reusable SSH config id ("" = none selected).
  configId: string;
  // a legacy INLINE bastion host stored before the dropdown-only redesign, kept only so the UI can
  // warn about it; it is never edited here and is cleared on save unless a config is chosen.
  legacyHost: string;
};

export function emptySshTunnel(): SshTunnelValue {
  return { enabled: false, configId: "", legacyHost: "" };
}

export function sshTunnelFromServer(server: Server): SshTunnelValue {
  return {
    enabled: Boolean(server.ssh_config_id) || Boolean(server.jump_host),
    configId: server.ssh_config_id || "",
    legacyHost: server.ssh_config_id ? "" : server.jump_host || ""
  };
}

export function sshTunnelFromDbConnection(conn: DbConnection): SshTunnelValue {
  return {
    enabled: Boolean(conn.ssh_config_id) || Boolean(conn.ssh_host),
    configId: conn.ssh_config_id || "",
    legacyHost: conn.ssh_config_id ? "" : conn.ssh_host || ""
  };
}

// Payload for a server's jump-host fields. Disabled or no config selected => everything cleared
// (ssh_config_id "" unlinks any reference and blanks any legacy inline jump). A selected config wins.
export function serverJumpPayload(v: SshTunnelValue) {
  const configId = v.enabled ? v.configId : "";
  return { jump_host: "", jump_port: 22, jump_username: "", jump_password: "", jump_private_key: "", ssh_config_id: configId };
}

// Same, for a DB connection's ssh_* tunnel fields.
export function dbTunnelPayload(v: SshTunnelValue) {
  const configId = v.enabled ? v.configId : "";
  return { ssh_host: "", ssh_port: 22, ssh_username: "", ssh_password: "", ssh_private_key: "", ssh_config_id: configId };
}

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

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
  const [testing, setTesting] = useState(false);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);

  const title = kind === "server" ? "Jump host (bastion)" : "SSH tunnel (jump host)";

  useEffect(() => {
    let alive = true;
    void getSshConfigs(token)
      .then((rows) => alive && setConfigs(rows))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : "Could not load saved SSH configs"));
    return () => { alive = false; };
  }, [token]);

  const selected = configs.find((c) => c.id === value.configId);

  async function testBastion() {
    if (!value.configId) return;
    setTesting(true);
    setTestNote(null);
    try {
      const res = await testSshBastion(token, { ssh_config_id: value.configId });
      setTestNote({ ok: res.ok, text: res.message });
    } catch (e) {
      setTestNote({ ok: false, text: e instanceof Error ? e.message : "Bastion test failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-edge">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <label className="flex flex-1 cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => { setTestNote(null); onChange({ ...value, enabled: e.target.checked }); }}
            className="h-4 w-4 shrink-0 rounded border-edge text-accent focus:ring-accent"
          />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</span>
          {value.enabled ? (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
              {selected ? `via ${selected.name}` : "select a config"}
            </span>
          ) : (
            <span className="text-[11px] font-normal normal-case text-muted">
              optional — reach {kind === "server" ? "this server" : "the database"} through a saved SSH bastion
            </span>
          )}
        </label>
        {value.enabled ? (
          <button
            type="button"
            onClick={() => { setTestNote(null); onChange(emptySshTunnel()); }}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-muted transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <X size={13} /> Remove
          </button>
        ) : null}
      </div>

      {value.enabled ? (
        <div className="grid gap-3 border-t border-edge px-4 py-3">
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            SSH config
            <div className="relative">
              <select
                value={value.configId}
                onChange={(e) => { setTestNote(null); onChange({ ...value, configId: e.target.value }); }}
                className={`${inputClass} appearance-none pr-10`}
              >
                <option value="">Select a saved SSH config…</option>
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.username ? `${c.username}@` : ""}{c.host}:{c.port}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
            </div>
          </label>

          {value.legacyHost && !value.configId ? (
            <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs font-medium text-warn dark:text-amber-300">
              Currently using an inline jump host <span className="font-semibold">{value.legacyHost}</span>. Pick a saved SSH config to
              replace it, or turn this off to remove the jump host.
            </p>
          ) : null}

          {selected ? (
            <p className="rounded-lg bg-surface px-3 py-2 text-xs font-normal text-muted ring-1 ring-edge">
              Using <span className="font-semibold text-fg">{selected.name}</span> — {selected.username ? `${selected.username}@` : ""}
              {selected.host}:{selected.port}
              {selected.has_password || selected.has_private_key ? " · credentials stored" : " · no stored credentials"}.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void testBastion()}
              disabled={testing || !value.configId}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-surface px-3 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : <PlugZap size={14} />}
              Test bastion
            </button>
            {testNote ? (
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${testNote.ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger"}`}>
                {testNote.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                <span className="break-words">{testNote.text}</span>
              </span>
            ) : null}
          </div>

          <p className="text-[11px] font-normal text-muted">
            Bastions are reusable SSH configs. Add or edit them under <span className="font-semibold text-fg">Master Data → SSH configs</span>.
            {loadError ? <span className="text-danger"> {loadError}</span> : configs.length === 0 ? <span className="text-warn"> No saved SSH configs yet — create one there first.</span> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
