"use client";

import Link from "next/link";
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, FileUp, Filter, Folder as FolderIcon, FolderPlus, FolderTree, List, MonitorDot, Plus, TerminalSquare, Trash2, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { AddServerForm } from "@/components/add-server-form";
import { AppShell } from "@/components/app-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { CsvImportPanel } from "@/components/csv-import-panel";
import { ShellPanel } from "@/components/shell-panel";
import { StatusPill } from "@/components/status-pill";
import { assignServerFolder, createFolder, deleteFolder, getFolders, getServers, refreshVitals, Folder, Server } from "@/lib/api";

const ALL = "__all__";

type SortKey = "hostname" | "ip";
type SortDir = "asc" | "desc";

export function ServerManagementPage() {
  return (
    <AppShell title="Server Management" subtitle="Onboard, discover, and operate managed servers">
      {({ token, me }) => <ServerManagementContent token={token} role={me.role} />}
    </AppShell>
  );
}

function osLabel(server: Server): string {
  const distro = server.os_distro ? server.os_distro.charAt(0).toUpperCase() + server.os_distro.slice(1) : "";
  const flavour = [distro, server.os_version].filter(Boolean).join(" ");
  return flavour || server.operating_system || "Unknown";
}

function uptimeLabel(seconds: number): string {
  if (!seconds || seconds < 0) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function ramLabel(server: Server): string {
  if (!server.ram_mb) return "-";
  const toGb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
  if (!server.ram_used_mb) return toGb(server.ram_mb);
  return `${toGb(server.ram_used_mb)} / ${toGb(server.ram_mb)}`;
}

function ramPercent(server: Server): number {
  if (!server.ram_mb || !server.ram_used_mb) return -1;
  return Math.round((server.ram_used_mb / server.ram_mb) * 100);
}

// -1 means never sampled, which must not render as a healthy 0%
function usageTone(percent: number): string {
  if (percent < 0) return "text-slate-400 dark:text-slate-500";
  if (percent >= 90) return "text-danger dark:text-red-400";
  if (percent >= 75) return "text-warn dark:text-amber-400";
  return "text-slate-700 dark:text-slate-300";
}

// Returns the four octets when value is a dotted-quad IPv4 literal, otherwise null.
function ipv4Octets(value: string): number[] | null {
  const parts = (value || "").trim().split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;
  return octets;
}

// ip_address is free text in this product: usually a dotted quad, but a hostname or a
// container name is accepted too, and IPv6 is possible. Compare octet by octet when both
// sides parse as IPv4 (so 10.0.0.9 sorts before 10.0.0.10, which a string sort gets
// wrong), keep real addresses ahead of non-numeric values, and fall back to a
// natural-order string compare rather than throwing on anything else.
function compareIp(left: string, right: string): number {
  const a = ipv4Octets(left);
  const b = ipv4Octets(right);
  if (a && b) {
    for (let index = 0; index < 4; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }
  if (a) return -1;
  if (b) return 1;
  return (left || "").localeCompare(right || "", undefined, { numeric: true, sensitivity: "base" });
}

function distinctValues(servers: Server[], pick: (server: Server) => string): string[] {
  const seen = new Set<string>();
  servers.forEach((server) => {
    const value = (pick(server) || "").trim();
    if (value) seen.add(value);
  });
  return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

function Chip({ label, tone }: { label: string; tone: "accent" | "slate" }) {
  const styles = tone === "accent"
    ? "bg-accent/10 text-accent dark:bg-accent/20"
    : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-xs font-semibold capitalize ${styles}`}>
      {label}
    </span>
  );
}

function SortHeader({ label, column, sortKey, sortDir, onSort, className }: { label: string; column: SortKey; sortKey: SortKey | null; sortDir: SortDir; onSort: (column: SortKey) => void; className?: string }) {
  const active = sortKey === column;
  const Icon = active ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th className={`px-6 py-4 font-semibold ${className ?? ""}`}>
      <button
        onClick={() => onSort(column)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-slate-700 dark:hover:text-slate-200 ${active ? "text-slate-700 dark:text-slate-200" : ""}`}
      >
        {label}
        <Icon size={12} className={active ? "text-accent" : "opacity-40"} />
      </button>
    </th>
  );
}

// EXPERIMENTAL (feature/server-folders): the "Unassigned" bucket has no folder public_id, so it
// is keyed by the empty string throughout — the same value ServerRead.folder_id carries when a
// server is in no folder. Keeping the sentinel identical to the wire value means grouping never
// has to translate between "" and some other placeholder.
const UNASSIGNED = "";

type ServerGroup = { key: string; name: string; count: number; rows: Server[] };

function ServerManagementContent({ token, role }: { token: string; role: string }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [shellFor, setShellFor] = useState<Server | null>(null);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [envFilter, setEnvFilter] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Grouped-by-folder is the default view the feature is meant to deliver; the toggle drops back
  // to the original flat "all servers" table for anyone who wants it.
  const [grouped, setGrouped] = useState(true);
  const [showFolderManager, setShowFolderManager] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const isAdmin = role === "admin";
  const { confirm, confirmDialog } = useConfirm();

  async function load() {
    try {
      // folders are needed by every role for the grouped view, and both endpoints are cheap, so
      // load them together — a failure of either surfaces as one inventory-load error
      const [nextServers, nextFolders] = await Promise.all([getServers(token), getFolders(token)]);
      setServers(nextServers);
      setFolders(nextFolders);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to load servers");
    }
  }

  // Re-fetch just the folder list after a membership or folder change, so the counts on the
  // section headers stay honest without a full inventory reload.
  async function reloadFolders() {
    try {
      setFolders(await getFolders(token));
    } catch {
      // a stale count is not worth surfacing an error banner over; the next full load corrects it
    }
  }

  async function assignFolder(server: Server, folderId: string | null) {
    try {
      const updated = await assignServerFolder(token, server.id, folderId);
      setServers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      void reloadFolders();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Unable to move server");
    }
  }

  async function submitNewFolder(event: React.FormEvent) {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    setFolderBusy(true);
    setFolderError("");
    try {
      await createFolder(token, name);
      setNewFolderName("");
      await reloadFolders();
    } catch (error) {
      // a duplicate name comes back 409; show the server's message rather than a generic one
      setFolderError(error instanceof Error ? error.message : "Unable to create folder");
    } finally {
      setFolderBusy(false);
    }
  }

  async function removeFolder(folder: Folder) {
    const ok = await confirm({
      title: `Delete folder "${folder.name}"?`,
      message: folder.server_count > 0
        ? `Its ${folder.server_count} server${folder.server_count === 1 ? "" : "s"} will move to Unassigned. The servers themselves are not deleted.`
        : "This folder is empty.",
      confirmLabel: "Delete folder",
      danger: true
    });
    if (!ok) return;
    setFolderError("");
    try {
      await deleteFolder(token, folder.id);
      // servers that were in the folder now report folder_id "", so reload both lists
      await load();
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Unable to delete folder");
    }
  }

  // Server types and environments are user-managed master data, so the filter options are
  // whatever the loaded inventory actually contains rather than a hardcoded list.
  const serverTypes = useMemo(() => distinctValues(servers, (server) => server.server_type), [servers]);
  const environments = useMemo(() => distinctValues(servers, (server) => server.environment), [servers]);

  const filtersActive = typeFilter !== ALL || envFilter !== ALL;

  const visibleServers = useMemo(() => {
    const rows = servers.filter((server) => (
      (typeFilter === ALL || server.server_type === typeFilter)
      && (envFilter === ALL || server.environment === envFilter)
    ));
    if (!sortKey) return rows;
    const factor = sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => factor * (sortKey === "ip"
      ? compareIp(a.ip_address, b.ip_address)
      : (a.hostname || "").localeCompare(b.hostname || "", undefined, { numeric: true, sensitivity: "base" })));
  }, [servers, typeFilter, envFilter, sortKey, sortDir]);

  // Group the ALREADY filtered-and-sorted rows so the existing filter/sort/vitals behaviour is
  // preserved untouched within each section. Folders that have no visible row are omitted (a
  // section header with nothing under it is just noise, and admins assign into a folder from the
  // per-row picker, not by seeing an empty section). "Unassigned" is always rendered last.
  const groups = useMemo<ServerGroup[]>(() => {
    const folderIds = new Set(folders.map((folder) => folder.id));
    const byKey = new Map<string, Server[]>();
    for (const server of visibleServers) {
      // a folder_id that no longer resolves (folder deleted out from under a cached row) falls
      // back to Unassigned rather than creating a ghost section
      const key = server.folder_id && folderIds.has(server.folder_id) ? server.folder_id : UNASSIGNED;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(server);
      else byKey.set(key, [server]);
    }
    // folders come from the API already ordered case-insensitively by name; keep that order
    const result: ServerGroup[] = folders
      .filter((folder) => byKey.has(folder.id))
      .map((folder) => ({ key: folder.id, name: folder.name, count: byKey.get(folder.id)!.length, rows: byKey.get(folder.id)! }));
    const unassigned = byKey.get(UNASSIGNED);
    if (unassigned && unassigned.length) {
      result.push({ key: UNASSIGNED, name: "Unassigned", count: unassigned.length, rows: unassigned });
    }
    return result;
  }, [visibleServers, folders]);

  // A type or environment can disappear from the inventory (renamed, or its last server
  // deleted). Without this the table would silently show zero rows against a filter value
  // that no longer exists anywhere.
  useEffect(() => {
    if (typeFilter !== ALL && !serverTypes.includes(typeFilter)) setTypeFilter(ALL);
    if (envFilter !== ALL && !environments.includes(envFilter)) setEnvFilter(ALL);
  }, [serverTypes, environments, typeFilter, envFilter]);

  function toggleSort(column: SortKey) {
    if (sortKey === column) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(column);
    setSortDir("asc");
  }

  function clearFilters() {
    setTypeFilter(ALL);
    setEnvFilter(ALL);
  }

  // Vitals are a live SSH probe (~2s per host), so this is an explicit action rather than
  // something the page does on load. It probes the rows currently visible: an operator who
  // has narrowed to one environment means those hosts, and probing hidden rows would spend
  // SSH connections on servers they cannot see the result for. Bounded concurrency keeps a
  // large inventory from opening dozens of SSH connections at once.
  async function refreshAllVitals() {
    setRefreshing(true);
    setLoadError("");
    const queue = [...visibleServers];
    const failures: string[] = [];
    async function worker() {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try {
          const updated = await refreshVitals(token, next.id);
          setServers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        } catch {
          failures.push(next.hostname);
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, worker));
      if (failures.length) setLoadError(`Vitals unavailable for: ${failures.join(", ")}`);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  const shellHidden = shellFor !== null && !visibleServers.some((server) => server.id === shellFor.id);
  const columnCount = isAdmin ? 10 : 9;
  const selectClass = "h-9 cursor-pointer rounded-full border-none bg-slate-100 px-4 text-sm font-medium capitalize text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100";
  // Compact folder picker for a single row. Kept in the Actions column so grouping does not need
  // an extra table column; it doubles as the assignment control in both grouped and flat views.
  const rowFolderSelectClass = "h-8 max-w-[10rem] cursor-pointer rounded-full border-none bg-slate-100 px-3 text-xs font-medium text-slate-700 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/60 dark:text-slate-200";

  // One row renderer shared by the grouped and flat views, so the columns can never drift apart
  // between the two. Admin-only controls (Shell, folder assignment) live in the trailing cell.
  const renderRow = (server: Server) => (
    <tr key={server.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
      <td className="px-6 py-4"><Link href={`/server/?id=${encodeURIComponent(server.id)}`} className="font-semibold text-accent">{server.hostname}</Link><div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{server.tags.join(", ")}</div></td>
      <td className="whitespace-nowrap px-6 py-4 font-medium text-slate-700 dark:text-slate-300">{server.ip_address}</td>
      <td className="px-6 py-4 font-medium text-slate-700 dark:text-slate-300">{osLabel(server)}<div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{[server.os_family, server.package_manager].filter(Boolean).join(" / ")}</div></td>
      <td className="whitespace-nowrap px-6 py-4 font-medium text-slate-700 dark:text-slate-300">{uptimeLabel(server.uptime_seconds)}{server.load_average ? <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">load {server.load_average}</div> : null}</td>
      <td className={`whitespace-nowrap px-6 py-4 font-medium ${usageTone(server.cpu_percent)}`}>{server.cpu_percent < 0 ? "-" : `${server.cpu_percent}%`}{server.cpu ? <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{server.cpu} cores</div> : null}</td>
      <td className={`whitespace-nowrap px-6 py-4 font-medium ${usageTone(ramPercent(server))}`}>{ramLabel(server)}{ramPercent(server) >= 0 ? <div className="mt-0.5 text-xs font-medium text-slate-500 dark:text-slate-400">{ramPercent(server)}% used</div> : null}</td>
      <td className="whitespace-nowrap px-6 py-4 font-medium text-slate-700 dark:text-slate-300">{server.process_count || "-"}</td>
      <td className="px-6 py-4">
        <div className="flex flex-col items-start gap-1">
          {server.server_type ? <Chip label={server.server_type} tone="accent" /> : null}
          {server.environment ? <Chip label={server.environment} tone="slate" /> : null}
          {!server.server_type && !server.environment ? <span className="font-medium text-slate-400 dark:text-slate-500">-</span> : null}
        </div>
      </td>
      <td className="px-6 py-4"><StatusPill status={server.status} /></td>
      {isAdmin ? (
        <td className="px-6 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setShellFor(shellFor?.id === server.id ? null : server)} disabled={!server.has_credentials} title={server.has_credentials ? "Open an interactive shell" : "No stored credentials for this server"} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:opacity-40 dark:bg-accent/20 dark:hover:bg-accent/30">
              <TerminalSquare size={14} /> Shell
            </button>
            {/* Empty value is the Unassigned option, which maps to a null assignment on the wire. */}
            <select value={server.folder_id || ""} onChange={(event) => void assignFolder(server, event.target.value || null)} aria-label={`Folder for ${server.hostname}`} title="Move this server to a folder" className={rowFolderSelectClass}>
              <option value="">Unassigned</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </div>
        </td>
      ) : null}
    </tr>
  );

  return (
    <section className="space-y-6 px-6 py-6">
      {confirmDialog}
      {role !== "admin" && (
        <div className="rounded-2xl bg-slate-50 p-4 text-sm font-medium text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">Developer/support roles can view inventory, containers, and logs. Ask an admin to add or update servers.</div>
      )}
      {loadError && servers.length > 0 ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">{loadError}</div>
      ) : null}
      {/* An open shell is a live PTY, so a filter change must not tear it down as a side
          effect. Keep the session and say plainly that its host is hidden. */}
      {shellHidden ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-slate-50 p-4 text-sm font-medium text-slate-600 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700">
          <span>The open shell on <span className="font-semibold text-slate-900 dark:text-slate-100">{shellFor?.hostname}</span> is hidden by the current filters. The session is still connected.</span>
          <button onClick={clearFilters} className="inline-flex h-8 items-center rounded-full bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30">Clear filters</button>
          <button onClick={() => setShellFor(null)} className="inline-flex h-8 items-center rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600">Close shell</button>
        </div>
      ) : null}
      {shellFor ? (
        <ShellPanel
          // deliberately NOT keyed on the server id: with tabs, remounting on every Shell
          // click would tear down every open session just because the operator picked a
          // different host. The workspace reacts to a serverId change by opening a new tab.
          token={token}
          serverId={shellFor.id}
          hostname={shellFor.hostname}
          username={shellFor.username}
          onClose={() => setShellFor(null)}
          // the New-tab picker needs the inventory to offer other hosts; only servers with
          // stored credentials can actually open a session
          servers={servers.filter((server) => server.has_credentials)}
        />
      ) : null}
      <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-white px-6 py-5 font-semibold text-slate-900 dark:border-slate-800 dark:bg-[#1e1e1e] dark:text-slate-100">
          <div className="flex items-center gap-3">
            <MonitorDot size={18} className="text-accent" />
            <h2 className="text-base font-semibold">Server Inventory</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button disabled={refreshing || visibleServers.length === 0} onClick={() => void refreshAllVitals()} title={filtersActive ? "Probe the servers matching the current filters" : "Probe every server in the inventory"} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
              <Activity size={16} className={refreshing ? "animate-pulse" : ""} /> {refreshing ? "Probing…" : `Refresh vitals${filtersActive && visibleServers.length ? ` (${visibleServers.length})` : ""}`}
            </button>
            {/* The view toggle is available to every role: grouping is a read affordance, not an
                admin one. Grouped is the default the feature ships with. */}
            <button onClick={() => setGrouped((value) => !value)} title={grouped ? "Switch to a single flat list of all servers" : "Group the inventory by folder"} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
              {grouped ? <><List size={16} /> All servers</> : <><FolderTree size={16} /> Group by folder</>}
            </button>
            {role === "admin" && (
              <>
                <button onClick={() => setShowFolderManager((value) => !value)} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
                  {showFolderManager ? <><X size={16} /> Close folders</> : <><FolderIcon size={16} /> Manage folders</>}
                </button>
                <button onClick={() => { setShowImport(!showImport); setShowAddForm(false); }} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-slate-100 px-4 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
                  {showImport ? <><X size={16} /> Cancel</> : <><FileUp size={16} /> Import from CSV</>}
                </button>
                <button onClick={() => { setShowAddForm(!showAddForm); setShowImport(false); }} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80">
                  {showAddForm ? <><X size={16} /> Cancel</> : <><Plus size={16} /> Add Server</>}
                </button>
              </>
            )}
          </div>
        </div>

        {role === "admin" && showAddForm && (
          <div className="border-b border-slate-100 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <AddServerForm token={token} onAdded={() => { setShowAddForm(false); void load(); }} />
          </div>
        )}
        {role === "admin" && showImport && (
          <div className="border-b border-slate-100 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <CsvImportPanel token={token} onImported={() => void load()} />
          </div>
        )}
        {role === "admin" && showFolderManager && (
          <div className="space-y-4 border-b border-slate-100 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <form onSubmit={(event) => void submitNewFolder(event)} className="flex flex-wrap items-center gap-2">
              <input
                value={newFolderName}
                onChange={(event) => { setNewFolderName(event.target.value); setFolderError(""); }}
                placeholder="New folder name (e.g. BH)"
                maxLength={128}
                aria-label="New folder name"
                className="h-9 min-w-[14rem] flex-1 rounded-full border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
              />
              <button type="submit" disabled={folderBusy || !newFolderName.trim()} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
                <FolderPlus size={16} /> {folderBusy ? "Creating…" : "Create folder"}
              </button>
            </form>
            {folderError ? <p className="text-xs font-medium text-danger dark:text-red-400">{folderError}</p> : null}
            {folders.length ? (
              <div className="flex flex-wrap gap-2">
                {folders.map((folder) => (
                  <span key={folder.id} className="inline-flex h-8 items-center gap-2 rounded-full bg-white px-3 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700">
                    <FolderIcon size={13} className="text-accent" />
                    {folder.name}
                    <span className="text-slate-400 dark:text-slate-500">{folder.server_count}</span>
                    <button onClick={() => void removeFolder(folder)} title={`Delete folder ${folder.name}`} className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-danger/10 hover:text-danger dark:hover:bg-red-500/10 dark:hover:text-red-400">
                      <Trash2 size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">No folders yet. Create one above, then assign servers from the inventory rows.</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-6 py-3 dark:border-slate-800 dark:bg-slate-800/50">
          <Filter size={16} className="text-slate-400 dark:text-slate-500" />
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by server type" className={selectClass}>
            <option value={ALL}>All types</option>
            {serverTypes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={envFilter} onChange={(event) => setEnvFilter(event.target.value)} aria-label="Filter by environment" className={selectClass}>
            <option value={ALL}>All environments</option>
            {environments.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          {filtersActive ? (
            <button onClick={clearFilters} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent/10 px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30">
              <X size={14} /> Clear
            </button>
          ) : null}
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Showing {visibleServers.length} of {servers.length} {servers.length === 1 ? "server" : "servers"}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <SortHeader label="Host" column="hostname" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHeader label="IP" column="ip" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <th className="px-6 py-4 font-semibold">OS</th>
                <th className="whitespace-nowrap px-6 py-4 font-semibold">Uptime</th>
                <th className="whitespace-nowrap px-6 py-4 font-semibold">CPU</th>
                <th className="whitespace-nowrap px-6 py-4 font-semibold">RAM</th>
                <th className="whitespace-nowrap px-6 py-4 font-semibold">Procs</th>
                <th className="whitespace-nowrap px-6 py-4 font-semibold">Type / Env</th>
                <th className="px-6 py-4 font-semibold">Status</th>
                {isAdmin ? <th className="px-6 py-4 font-semibold">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {/* Grouped view: a header row per folder (with its visible count), sections in the
                  order the API returned folders, Unassigned last. Flat view: the original single
                  list. Both reuse renderRow so the columns stay identical. */}
              {grouped
                ? groups.map((group) => (
                    <Fragment key={group.key || "__unassigned__"}>
                      <tr className="bg-slate-50 dark:bg-slate-800/40">
                        <td colSpan={columnCount} className="px-6 py-2.5">
                          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                            {group.key ? <FolderIcon size={14} className="text-accent" /> : <MonitorDot size={14} className="text-slate-400 dark:text-slate-500" />}
                            <span className="text-slate-700 dark:text-slate-200">{group.name}</span>
                            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{group.count}</span>
                          </div>
                        </td>
                      </tr>
                      {group.rows.map((server) => renderRow(server))}
                    </Fragment>
                  ))
                : visibleServers.map((server) => renderRow(server))}
              {servers.length === 0 ? (
                <tr><td className="px-6 py-6 text-slate-500 dark:text-slate-400" colSpan={columnCount}>{loadError ? `Unable to load inventory: ${loadError}` : "No servers in inventory yet."}</td></tr>
              ) : null}
              {servers.length > 0 && visibleServers.length === 0 ? (
                <tr>
                  <td className="px-6 py-6 text-slate-500 dark:text-slate-400" colSpan={columnCount}>
                    <span className="font-medium">No servers match the current filters.</span>{" "}
                    <button onClick={clearFilters} className="font-semibold text-accent hover:underline">Clear filters</button> to see all {servers.length}.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
