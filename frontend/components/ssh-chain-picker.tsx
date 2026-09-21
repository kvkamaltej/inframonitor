"use client";

// Dropdown-only builder for an ORDERED SSH access path (a chain of jump hosts) used to reach a
// Kubernetes API server that sits behind one or more bastions: app -> hop1 -> hop2 -> ... -> node
// -> API. Each hop is a reusable SSH config chosen from a dropdown (managed under Master Data ->
// SSH configs); there is no inline host/user/key entry here, keeping the form clean. Value is the
// ordered list of SSH config public_ids; [] means a direct connection.

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, Loader2, Plus, PlugZap, X } from "lucide-react";
import { getSshConfigs, testSshBastion, type SshConfig } from "@/lib/api";

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

export function SshChainPicker({
  token,
  value,
  onChange
}: {
  token: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [configs, setConfigs] = useState<SshConfig[]>([]);
  const [loadError, setLoadError] = useState("");
  const [testingIdx, setTestingIdx] = useState<number | null>(null);
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void getSshConfigs(token)
      .then((rows) => alive && setConfigs(rows))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : "Could not load saved SSH configs"));
    return () => { alive = false; };
  }, [token]);

  const enabled = value.length > 0;
  const nameOf = (id: string) => configs.find((c) => c.id === id)?.name ?? "(unknown)";
  const label = (c: SshConfig) => `${c.name} — ${c.username ? `${c.username}@` : ""}${c.host}:${c.port}`;

  function setHop(index: number, id: string) {
    setTestNote(null);
    onChange(value.map((v, i) => (i === index ? id : v)));
  }
  function addHop() {
    setTestNote(null);
    onChange([...value, ""]);
  }
  function removeHop(index: number) {
    setTestNote(null);
    onChange(value.filter((_, i) => i !== index));
  }
  function move(index: number, delta: number) {
    const j = index + delta;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[index], next[j]] = [next[j], next[index]];
    setTestNote(null);
    onChange(next);
  }

  async function testHop(index: number) {
    const id = value[index];
    if (!id) return;
    setTestingIdx(index);
    setTestNote(null);
    try {
      const res = await testSshBastion(token, { ssh_config_id: id });
      setTestNote({ ok: res.ok, text: `${nameOf(id)}: ${res.message}` });
    } catch (e) {
      setTestNote({ ok: false, text: e instanceof Error ? e.message : "Test failed" });
    } finally {
      setTestingIdx(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-edge">
      <label className="flex cursor-pointer items-center gap-2.5 px-4 py-2.5">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => { setTestNote(null); onChange(e.target.checked ? [""] : []); }}
          className="h-4 w-4 shrink-0 rounded border-edge text-accent focus:ring-accent"
        />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">SSH access path (jump hosts)</span>
        {enabled ? (
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
            {value.filter(Boolean).length} hop{value.filter(Boolean).length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-[11px] font-normal normal-case text-muted">optional — reach the API server through one or more bastions</span>
        )}
      </label>

      {enabled ? (
        <div className="grid gap-3 border-t border-edge px-4 py-3">
          <p className="text-[11px] font-normal text-muted">
            The API server is reached in order: <span className="font-semibold text-fg">app</span>
            {value.filter(Boolean).map((id, i) => (
              <span key={i}> → <span className="font-semibold text-fg">{nameOf(id)}</span></span>
            ))}
            {" → "}<span className="font-semibold text-fg">API server</span>. The last hop must be able to reach the API server.
          </p>

          {value.map((id, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="w-5 shrink-0 text-center text-xs font-semibold text-muted">{index + 1}</span>
              <div className="relative flex-1">
                <select value={id} onChange={(e) => setHop(index, e.target.value)} className={`${inputClass} appearance-none pr-10`}>
                  <option value="">Select a jump host…</option>
                  {configs.map((c) => (
                    <option key={c.id} value={c.id}>{label(c)}</option>
                  ))}
                </select>
                <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted" />
              </div>
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0} title="Move up" className="inline-flex h-9 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface disabled:opacity-30"><ArrowUp size={15} /></button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === value.length - 1} title="Move down" className="inline-flex h-9 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface disabled:opacity-30"><ArrowDown size={15} /></button>
              <button type="button" onClick={() => testHop(index)} disabled={!id || testingIdx !== null} title="Test SSH to this hop" className="inline-flex h-9 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-accent disabled:opacity-30">
                {testingIdx === index ? <Loader2 size={15} className="animate-spin" /> : <PlugZap size={15} />}
              </button>
              <button type="button" onClick={() => removeHop(index)} title="Remove this hop" className="inline-flex h-9 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger"><X size={15} /></button>
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={addHop} className="inline-flex h-9 w-fit items-center gap-1.5 rounded-lg bg-surface px-3 text-xs font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent">
              <Plus size={14} /> Add hop
            </button>
            {testNote ? (
              <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${testNote.ok ? "text-emerald-600 dark:text-emerald-400" : "text-danger"}`}>
                {testNote.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                <span className="break-words">{testNote.text}</span>
              </span>
            ) : null}
          </div>

          <p className="text-[11px] font-normal text-muted">
            Hops are reusable SSH configs. Add or edit them under <span className="font-semibold text-fg">Master Data → SSH configs</span>.
            {loadError ? <span className="text-danger"> {loadError}</span> : configs.length === 0 ? <span className="text-warn"> No saved SSH configs yet — create one there first.</span> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}
