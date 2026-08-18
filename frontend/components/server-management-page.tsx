"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, CircleDot, Cpu, ExternalLink, FileUp, Filter, Folder as FolderIcon, FolderPlus, FolderTree, HardDrive, List, Loader2, MonitorDot, MoreVertical, Pencil, Plus, RefreshCw, Search, Server as ServerIcon, TerminalSquare, Trash2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

// The family/package-manager detail (e.g. "debian / apt") now lives in the OS cell's hover
// tooltip rather than a second line. Empty when neither is known, so no bare " / " leaks out.
function osDetail(server: Server): string {
  return [server.os_family, server.package_manager].filter(Boolean).join(" / ");
}

// lucide has no distro logos, so map the OS family to a sensible generic glyph. Anything
// unrecognised (or missing) falls back to a plain server icon.
function osIcon(server: Server): LucideIcon {
  const family = `${server.os_family || server.os_distro || ""}`.toLowerCase();
  if (/(ubuntu|debian|mint)/.test(family)) return CircleDot;
  if (/(rhel|centos|fedora|rocky|alma|red\s*hat|suse)/.test(family)) return ServerIcon;
  if (/(alpine|arch|gentoo)/.test(family)) return Cpu;
  return HardDrive;
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

// Disk usage from discovered storage: prefer the root ("/") filesystem, else the first mount.
function rootDisk(server: Server): Record<string, string> | undefined {
  const rows = server.storage ?? [];
  return rows.find((r) => r.mount === "/") ?? rows.find((r) => (r.mount ?? "").length > 0) ?? rows[0];
}

function diskLabel(server: Server): string {
  const r = rootDisk(server);
  const toGb = (bytesStr?: string) => {
    const b = Number(bytesStr);
    return Number.isFinite(b) && b > 0 ? b / 1024 ** 3 : NaN;
  };
  if (r) {
    const used = toGb(r.used_bytes);
    const total = toGb(r.size_bytes);
    if (Number.isFinite(used) && Number.isFinite(total)) return `${used.toFixed(1)} / ${total.toFixed(0)} GB`;
  }
  return server.disk_gb ? `${server.disk_gb} GB` : "-";
}

function diskPercent(server: Server): number {
  const r = rootDisk(server);
  const n = r ? Number(r.used_percent_num) : NaN;
  return Number.isFinite(n) ? Math.round(n) : -1;
}

// -1 means never sampled, which must not render as a healthy 0%. Neutral tones now flow from
// the theme tokens (text-muted / text-fg) so the column re-skins with the palette; the
// danger/warn usage tints are intentionally kept fixed so a hot host reads the same everywhere.
function usageTone(percent: number): string {
  if (percent < 0) return "text-muted";
  if (percent >= 90) return "text-danger dark:text-red-400";
  if (percent >= 75) return "text-warn dark:text-amber-400";
  return "text-fg";
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
  // Dedupe case-insensitively — "Production" and "production" are the same environment, so the
  // filter dropdown must list it once. Keep the first display label seen for each value; a plain
  // Set keyed on the raw string would let case variants through as visible duplicates.
  const byKey = new Map<string, string>();
  servers.forEach((server) => {
    const value = (pick(server) || "").trim();
    if (value && !byKey.has(value.toLowerCase())) byKey.set(value.toLowerCase(), value);
  });
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

// Pure sort, returning a new array so it can be applied per-group without mutating shared state.
// A null key means "leave in the given order".
function sortRows(rows: Server[], sortKey: SortKey | null, sortDir: SortDir): Server[] {
  if (!sortKey) return rows;
  const factor = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => factor * (sortKey === "ip"
    ? compareIp(a.ip_address, b.ip_address)
    : (a.hostname || "").localeCompare(b.hostname || "", undefined, { numeric: true, sensitivity: "base" })));
}

type GroupSort = { key: SortKey | null; dir: SortDir };
const NO_SORT: GroupSort = { key: null, dir: "asc" };

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
    <th className={`px-3 py-3 font-semibold ${className ?? ""}`}>
      <button
        onClick={() => onSort(column)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-fg ${active ? "text-fg" : ""}`}
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

// Distinct sentinel for the "Unassigned" *filter* option. Kept separate from UNASSIGNED ("")
// so it never collides with the ALL sentinel, and from the wire value used for grouping.
const UNASSIGNED_FILTER = "__unassigned__";

// The vertical ⋮ row menu: Open / Edit / Refresh vitals / Shell, plus "Move to group…", which
// opens a searchable dialog rather than listing every group inline — an inline list does not
// scale to hundreds or thousands of groups. The dropdown is positioned `fixed` off the button's
// rect so the inventory card's `overflow-hidden` can never clip it, and it closes on scroll,
// resize or a click away.
function RowActions({ server, canShell, vitalsBusy, onShell, onRefreshVitals, onMoveToGroup }: {
  server: Server;
  canShell: boolean;
  vitalsBusy: boolean;
  onShell: () => void;
  onRefreshVitals: () => void;
  onMoveToGroup: () => void;
}) {
  const router = useRouter();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const WIDTH = 224;
  // Approx. height of the five items + divider; only used to decide whether to flip upward.
  const EST_HEIGHT = 236;

  function openMenu() {
    const box = btnRef.current?.getBoundingClientRect();
    if (!box) return;
    const x = Math.max(8, Math.min(box.right - WIDTH, window.innerWidth - WIDTH - 8));
    // Flip the menu above the button when there isn't room below it in the viewport.
    const openUp = box.bottom + 4 + EST_HEIGHT > window.innerHeight && box.top - 4 - EST_HEIGHT > 0;
    const y = openUp ? Math.max(8, box.top - 4 - EST_HEIGHT) : box.bottom + 4;
    setPos({ x, y });
  }

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  const item = "flex w-full items-center gap-2 px-4 py-2 text-left text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800";
  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (pos ? setPos(null) : openMenu())}
        aria-haspopup="menu"
        aria-expanded={Boolean(pos)}
        title={`Actions for ${server.hostname}`}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-700 dark:hover:text-slate-100"
      >
        {vitalsBusy ? <Loader2 size={16} className="animate-spin text-accent" /> : <MoreVertical size={16} />}
      </button>
      {pos ? (
        <>
          <button aria-label="Dismiss actions" onClick={() => setPos(null)} className="fixed inset-0 z-40 cursor-default" />
          <div role="menu" style={{ left: pos.x, top: pos.y, width: WIDTH }} className="fixed z-50 max-h-80 overflow-auto rounded-2xl border border-line bg-panel py-1 text-left shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <button role="menuitem" className={item} onClick={() => { setPos(null); router.push(`/server/?id=${encodeURIComponent(server.id)}`); }}>
              <ExternalLink size={14} className="text-accent" /> Open server
            </button>
            <button role="menuitem" className={item} onClick={() => { setPos(null); router.push(`/server/?id=${encodeURIComponent(server.id)}&edit=1`); }}>
              <Pencil size={14} className="text-accent" /> Edit details
            </button>
            <button role="menuitem" disabled={vitalsBusy} className={item} onClick={() => { setPos(null); onRefreshVitals(); }} title="Probe this server's live vitals over SSH">
              <RefreshCw size={14} className="text-accent" /> Refresh vitals
            </button>
            <button role="menuitem" disabled={!canShell} className={item} onClick={() => { setPos(null); onShell(); }} title={canShell ? "Open an interactive shell" : "No stored credentials for this server"}>
              <TerminalSquare size={14} className="text-accent" /> Open shell
            </button>
            <div className="my-1 border-t border-line dark:border-slate-700" />
            <button role="menuitem" className={item} onClick={() => { setPos(null); onMoveToGroup(); }}>
              <FolderIcon size={14} className="text-accent" /> Move to group…
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

// Searchable group-assignment dialog, opened from the row menu's "Move to group…". Filtering by
// name is what keeps this usable with a very large number of groups, where the old inline list
// would have been unnavigable. Enter assigns the single remaining match.
function GroupAssignDialog({ server, folders, onClose, onAssign }: {
  server: Server;
  folders: Folder[];
  onClose: () => void;
  onAssign: (folderId: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = needle ? folders.filter((folder) => folder.name.toLowerCase().includes(needle)) : folders;

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      // Enter assigns when the search has narrowed to exactly one group
      if (event.key === "Enter" && matches.length === 1) onAssign(matches[0].id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matches, onAssign, onClose]);

  const item = "flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800";
  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 p-4 pt-24" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default" />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-panel shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-line px-5 py-4 dark:border-slate-700">
          <h2 className="min-w-0 truncate font-semibold text-slate-900 dark:text-slate-100">Move <span className="text-accent">{server.hostname}</span> to a group</h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
        </div>
        <div className="p-3">
          <div className="relative mb-2">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${folders.length} group${folders.length === 1 ? "" : "s"}…`}
              className="h-10 w-full rounded-xl border border-line bg-white pl-9 pr-3 text-sm outline-none transition-colors focus:ring-2 focus:ring-accent dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </div>
          <div className="max-h-72 overflow-auto">
            <button className={item} onClick={() => onAssign(null)}>
              <span className="flex items-center gap-2"><MonitorDot size={14} className="text-slate-400" /> Unassigned</span>
              {!server.folder_id ? <Check size={14} className="text-accent" /> : null}
            </button>
            {matches.map((folder) => (
              <button key={folder.id} className={item} onClick={() => onAssign(folder.id)}>
                <span className="flex min-w-0 items-center gap-2"><FolderIcon size={14} className="shrink-0 text-accent" /> <span className="truncate">{folder.name}</span> <span className="shrink-0 text-xs text-slate-400">{folder.server_count}</span></span>
                {server.folder_id === folder.id ? <Check size={14} className="shrink-0 text-accent" /> : null}
              </button>
            ))}
            {folders.length === 0 ? (
              <p className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">No groups yet. Create one with “Manage groups”.</p>
            ) : matches.length === 0 ? (
              <p className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">No groups match “{query}”.</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ServerManagementContent({ token, role }: { token: string; role: string }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // The inventory toolbar keeps only Add Server visible; everything else lives behind a ⋮ menu.
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [shellFor, setShellFor] = useState<Server | null>(null);
  const [typeFilter, setTypeFilter] = useState(ALL);
  const [envFilter, setEnvFilter] = useState(ALL);
  const [groupFilter, setGroupFilter] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Grouped-by-folder is the default view the feature is meant to deliver; the toggle drops back
  // to the original flat "all servers" table for anyone who wants it.
  const [grouped, setGrouped] = useState(true);
  // Per-server vitals refresh in flight (ids), the row whose group-assignment dialog is open,
  // per-group sort overrides, and which group sections are collapsed. Sort and collapse are
  // keyed by group key ("" is the Unassigned bucket, same sentinel used everywhere else).
  const [vitalsBusyIds, setVitalsBusyIds] = useState<Set<string>>(new Set());
  const [assignFor, setAssignFor] = useState<Server | null>(null);
  const [groupSort, setGroupSort] = useState<Record<string, GroupSort>>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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

  // Probe one server's vitals (the row-menu action). Mirrors refreshAllVitals but for a single
  // host, with a per-id busy flag so only that row's control spins.
  async function refreshOneVitals(server: Server) {
    setVitalsBusyIds((current) => new Set(current).add(server.id));
    setLoadError("");
    try {
      const updated = await refreshVitals(token, server.id);
      setServers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch {
      setLoadError(`Vitals unavailable for ${server.hostname}`);
    } finally {
      setVitalsBusyIds((current) => {
        const next = new Set(current);
        next.delete(server.id);
        return next;
      });
    }
  }

  // Per-group sort: clicking a section's column header sorts only that section. Same column
  // flips direction; a new column starts ascending.
  function toggleGroupSort(groupKey: string, column: SortKey) {
    setGroupSort((current) => {
      const existing = current[groupKey] ?? NO_SORT;
      const dir: SortDir = existing.key === column ? (existing.dir === "asc" ? "desc" : "asc") : "asc";
      return { ...current, [groupKey]: { key: column, dir } };
    });
  }

  function toggleCollapse(groupKey: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
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
      title: `Delete group "${folder.name}"?`,
      message: folder.server_count > 0
        ? `Its ${folder.server_count} server${folder.server_count === 1 ? "" : "s"} will move to Unassigned. The servers themselves are not deleted.`
        : "This group is empty.",
      confirmLabel: "Delete group",
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

  const filtersActive = typeFilter !== ALL || envFilter !== ALL || groupFilter !== ALL;

  // Filter only — sorting is applied afterwards, globally for the flat view and per-section for
  // the grouped view, so each group can be sorted independently.
  const filteredServers = useMemo(() => {
    const folderIds = new Set(folders.map((folder) => folder.id));
    const inGroup = (server: Server) => {
      if (groupFilter === ALL) return true;
      const resolved = server.folder_id && folderIds.has(server.folder_id) ? server.folder_id : UNASSIGNED;
      if (groupFilter === UNASSIGNED_FILTER) return resolved === UNASSIGNED;
      return resolved === groupFilter;
    };
    return servers.filter((server) => (
      (typeFilter === ALL || server.server_type === typeFilter)
      && (envFilter === ALL || server.environment === envFilter)
      && inGroup(server)
    ));
  }, [servers, folders, typeFilter, envFilter, groupFilter]);

  // The flat view's sorted rows (also what "Refresh vitals" probes and what the count shows).
  const visibleServers = useMemo(() => sortRows(filteredServers, sortKey, sortDir), [filteredServers, sortKey, sortDir]);

  // Group the ALREADY filtered-and-sorted rows so the existing filter/sort/vitals behaviour is
  // preserved untouched within each section. Folders that have no visible row are omitted (a
  // section header with nothing under it is just noise, and admins assign into a folder from the
  // per-row picker, not by seeing an empty section). "Unassigned" is always rendered last.
  const groups = useMemo<ServerGroup[]>(() => {
    const folderIds = new Set(folders.map((folder) => folder.id));
    const byKey = new Map<string, Server[]>();
    for (const server of filteredServers) {
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
  }, [filteredServers, folders]);

  // A type or environment can disappear from the inventory (renamed, or its last server
  // deleted). Without this the table would silently show zero rows against a filter value
  // that no longer exists anywhere.
  useEffect(() => {
    if (typeFilter !== ALL && !serverTypes.includes(typeFilter)) setTypeFilter(ALL);
    if (envFilter !== ALL && !environments.includes(envFilter)) setEnvFilter(ALL);
    // a group filter pointing at a folder that was just deleted falls back to All groups
    if (groupFilter !== ALL && groupFilter !== UNASSIGNED_FILTER && !folders.some((folder) => folder.id === groupFilter)) setGroupFilter(ALL);
  }, [serverTypes, environments, folders, typeFilter, envFilter, groupFilter]);

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
    setGroupFilter(ALL);
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
  const selectClass = "h-9 cursor-pointer rounded-full border-none bg-slate-100 px-4 text-sm font-medium capitalize text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100";

  // One row renderer shared by the grouped and flat views, so the columns can never drift apart
  // between the two. Admin-only controls (Shell, folder assignment) live in the trailing cell.
  const renderRow = (server: Server) => {
    const OsGlyph = osIcon(server);
    return (
    <tr key={server.id} className="transition-colors hover:bg-page">
      <td className="px-3 py-3 align-top">
        <Link href={`/server/?id=${encodeURIComponent(server.id)}`} className="block truncate font-semibold text-accent" title={server.hostname}>{server.hostname}</Link>
        {server.tags.length ? <div className="mt-0.5 truncate text-xs font-medium text-muted" title={server.tags.join(", ")}>{server.tags.join(", ")}</div> : null}
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top font-medium text-fg">{server.ip_address}</td>
      <td className="px-3 py-3 align-top font-medium text-fg" title={osDetail(server) || undefined}>
        <span className="flex items-center gap-1.5">
          <OsGlyph size={14} className="shrink-0 text-muted" />
          <span className="truncate">{osLabel(server)}</span>
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-3 align-top font-medium text-fg">{uptimeLabel(server.uptime_seconds)}</td>
      <td className={`whitespace-nowrap px-3 py-3 align-top font-medium ${usageTone(server.cpu_percent)}`}>{server.cpu_percent < 0 ? "-" : `${server.cpu_percent}%`}{server.cpu ? <div className="mt-0.5 text-xs font-medium text-muted">{server.cpu} cores</div> : null}</td>
      <td className={`whitespace-nowrap px-3 py-3 align-top font-medium ${usageTone(ramPercent(server))}`}>{ramLabel(server)}{ramPercent(server) >= 0 ? <div className="mt-0.5 text-xs font-medium text-muted">{ramPercent(server)}% used</div> : null}</td>
      <td className={`whitespace-nowrap px-3 py-3 align-top font-medium ${usageTone(diskPercent(server))}`}>{diskLabel(server)}{diskPercent(server) >= 0 ? <div className="mt-0.5 text-xs font-medium text-muted">{diskPercent(server)}% used</div> : null}</td>
      <td className="px-3 py-3 align-top">
        <div className="flex flex-col items-start gap-1">
          {server.server_type ? <Chip label={server.server_type} tone="accent" /> : null}
          {server.environment ? <Chip label={server.environment} tone="slate" /> : null}
          {!server.server_type && !server.environment ? <span className="font-medium text-muted">-</span> : null}
        </div>
      </td>
      <td className="px-3 py-3 align-top"><StatusPill status={server.status} /></td>
      {isAdmin ? (
        <td className="px-3 py-3 align-top">
          <RowActions
            server={server}
            canShell={server.has_credentials}
            vitalsBusy={vitalsBusyIds.has(server.id)}
            onShell={() => setShellFor(shellFor?.id === server.id ? null : server)}
            onRefreshVitals={() => void refreshOneVitals(server)}
            onMoveToGroup={() => setAssignFor(server)}
          />
        </td>
      ) : null}
    </tr>
    );
  };

  // A full column-headed table for one set of rows, with its own sort context. Used once in the
  // flat view (global sort) and once per section in the grouped view (each section's own sort),
  // so a group's name renders as a *section heading above its own table* and each group sorts
  // independently of the others.
  const serverTable = (rows: Server[], sKey: SortKey | null, sDir: SortDir, onSort: (column: SortKey) => void) => (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-left text-sm">
        <colgroup>
          <col className="w-[16%]" />
          <col className="w-[11%]" />
          <col className="w-[13%]" />
          <col className="w-[8%]" />
          <col className="w-[8%]" />
          <col className="w-[12%]" />
          <col className="w-[12%]" />
          <col className="w-[11%]" />
          <col className="w-[9%]" />
          {isAdmin ? <col className="w-[6%]" /> : null}
        </colgroup>
        <thead className="bg-elevated text-xs uppercase tracking-wider text-muted">
          <tr>
            <SortHeader label="Host" column="hostname" sortKey={sKey} sortDir={sDir} onSort={onSort} />
            <SortHeader label="IP" column="ip" sortKey={sKey} sortDir={sDir} onSort={onSort} />
            <th className="px-3 py-3 font-semibold">OS</th>
            <th className="px-3 py-3 font-semibold">Uptime</th>
            <th className="px-3 py-3 font-semibold">CPU</th>
            <th className="px-3 py-3 font-semibold">RAM</th>
            <th className="px-3 py-3 font-semibold">Disk</th>
            <th className="px-3 py-3 font-semibold">Type / Env</th>
            <th className="px-3 py-3 font-semibold">Status</th>
            {isAdmin ? <th className="px-3 py-3 font-semibold">Actions</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {rows.map((server) => renderRow(server))}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="space-y-6 px-6 py-6">
      {confirmDialog}
      {assignFor ? (
        <GroupAssignDialog
          server={assignFor}
          folders={folders}
          onClose={() => setAssignFor(null)}
          onAssign={(folderId) => { void assignFolder(assignFor, folderId); setAssignFor(null); }}
        />
      ) : null}
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
      <div className="overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-edge">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-edge bg-elevated px-6 py-5 font-semibold text-fg">
          <div className="flex items-center gap-3">
            <MonitorDot size={18} className="text-accent" />
            <h2 className="text-base font-semibold">Server Inventory</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {role === "admin" && (
              <button onClick={() => { setShowAddForm(!showAddForm); setShowImport(false); }} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80">
                {showAddForm ? <><X size={16} /> Cancel</> : <><Plus size={16} /> Add Server</>}
              </button>
            )}
            {/* Everything else is tucked into a ⋮ menu to keep the inventory header minimal. */}
            <div className="relative">
              <button onClick={() => setActionsMenuOpen((v) => !v)} aria-label="Inventory actions" aria-expanded={actionsMenuOpen} title="Actions" className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
                <MoreVertical size={18} />
              </button>
              {actionsMenuOpen && (
                <>
                  <button aria-label="Close menu" onClick={() => setActionsMenuOpen(false)} className="fixed inset-0 z-30 cursor-default" />
                  <div className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-2xl bg-elevated py-1 text-fg shadow-xl ring-1 ring-edge">
                    <button disabled={refreshing || visibleServers.length === 0} onClick={() => { setActionsMenuOpen(false); void refreshAllVitals(); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-page disabled:opacity-50">
                      <Activity size={16} className={refreshing ? "animate-pulse text-accent" : "text-accent"} /> {refreshing ? "Probing…" : `Refresh vitals${filtersActive && visibleServers.length ? ` (${visibleServers.length})` : ""}`}
                    </button>
                    <button onClick={() => { setGrouped((value) => !value); setActionsMenuOpen(false); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-page">
                      {grouped ? <><List size={16} className="text-muted" /> Show all (flat)</> : <><FolderTree size={16} className="text-muted" /> Group view</>}
                    </button>
                    {role === "admin" && (
                      <>
                        <div className="my-1 border-t border-edge" />
                        <button onClick={() => { setShowFolderManager((value) => !value); setActionsMenuOpen(false); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-page">
                          <FolderIcon size={16} className="text-muted" /> {showFolderManager ? "Close groups" : "Manage groups"}
                        </button>
                        <button onClick={() => { setShowImport(!showImport); setShowAddForm(false); setActionsMenuOpen(false); }} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-medium transition-colors hover:bg-page">
                          <FileUp size={16} className="text-muted" /> {showImport ? "Cancel import" : "Import from CSV"}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {role === "admin" && showAddForm && (
          <div className="border-b border-edge bg-elevated p-6">
            <AddServerForm token={token} onAdded={() => { setShowAddForm(false); void load(); }} />
          </div>
        )}
        {role === "admin" && showImport && (
          <div className="border-b border-edge bg-elevated p-6">
            <CsvImportPanel token={token} onImported={() => void load()} />
          </div>
        )}
        {role === "admin" && showFolderManager && (
          <div className="space-y-4 border-b border-edge bg-elevated p-6">
            <form onSubmit={(event) => void submitNewFolder(event)} className="flex flex-wrap items-center gap-2">
              <input
                value={newFolderName}
                onChange={(event) => { setNewFolderName(event.target.value); setFolderError(""); }}
                placeholder="New group name (e.g. BH)"
                maxLength={128}
                aria-label="New group name"
                className="h-9 min-w-[14rem] flex-1 rounded-full border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700"
              />
              <button type="submit" disabled={folderBusy || !newFolderName.trim()} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
                <FolderPlus size={16} /> {folderBusy ? "Creating…" : "Create group"}
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
                    <button onClick={() => void removeFolder(folder)} title={`Delete group ${folder.name}`} className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-danger/10 hover:text-danger dark:hover:bg-red-500/10 dark:hover:text-red-400">
                      <Trash2 size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">No groups yet. Create one above, then assign servers from the inventory row menu.</p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-elevated px-6 py-3">
          <Filter size={16} className="text-muted" />
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by server type" className={selectClass}>
            <option value={ALL}>All types</option>
            {serverTypes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={envFilter} onChange={(event) => setEnvFilter(event.target.value)} aria-label="Filter by environment" className={selectClass}>
            <option value={ALL}>All environments</option>
            {environments.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="Filter by group" className={selectClass}>
            <option value={ALL}>All groups</option>
            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            <option value={UNASSIGNED_FILTER}>Unassigned</option>
          </select>
          {filtersActive ? (
            <button onClick={clearFilters} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-accent/10 px-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30">
              <X size={14} /> Clear
            </button>
          ) : null}
          <span className="text-xs font-medium text-muted">Showing {visibleServers.length} of {servers.length} {servers.length === 1 ? "server" : "servers"}</span>
        </div>
        {/* Empty states first, then the inventory itself. Grouped view renders one titled
            section per group (each with its own table), so a group name — Unassigned included —
            reads as a section heading, never as a row crammed under the column header. */}
        {servers.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted">{loadError ? `Unable to load inventory: ${loadError}` : "No servers in inventory yet."}</div>
        ) : visibleServers.length === 0 ? (
          <div className="px-6 py-6 text-sm text-muted">
            <span className="font-medium">No servers match the current filters.</span>{" "}
            <button onClick={clearFilters} className="font-semibold text-accent hover:underline">Clear filters</button> to see all {servers.length}.
          </div>
        ) : grouped ? (
          <div className="divide-y divide-edge">
            {groups.map((group) => {
              const gsort = groupSort[group.key] ?? NO_SORT;
              const isCollapsed = collapsed.has(group.key);
              return (
                <div key={group.key || "__unassigned__"}>
                  <button
                    type="button"
                    onClick={() => toggleCollapse(group.key)}
                    aria-expanded={!isCollapsed}
                    title={isCollapsed ? "Expand group" : "Collapse group"}
                    className="flex w-full items-center gap-2 px-6 py-3 text-left transition-colors hover:bg-page"
                  >
                    {isCollapsed ? <ChevronRight size={16} className="shrink-0 text-muted" /> : <ChevronDown size={16} className="shrink-0 text-muted" />}
                    {group.key ? <FolderIcon size={16} className="text-accent" /> : <MonitorDot size={16} className="text-muted" />}
                    <h3 className="text-sm font-semibold text-fg">{group.name}</h3>
                    <span className="rounded-full bg-page px-2 py-0.5 text-[11px] font-semibold text-muted">{group.count}</span>
                  </button>
                  {isCollapsed ? null : serverTable(sortRows(group.rows, gsort.key, gsort.dir), gsort.key, gsort.dir, (column) => toggleGroupSort(group.key, column))}
                </div>
              );
            })}
          </div>
        ) : (
          serverTable(visibleServers, sortKey, sortDir, toggleSort)
        )}
      </div>
    </section>
  );
}
