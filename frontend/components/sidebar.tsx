"use client";

import Link from "next/link";
import { Boxes, ChevronDown, ChevronRight, Database, DatabaseZap, Folder as FolderIcon, Layers, Loader2, Menu, MonitorCog, Moon, Palette, Play, Server, Settings, Shield, SlidersHorizontal, Sun, Table2 as TableIcon, TerminalSquare, UserCircle, Users, Vault, X } from "lucide-react";
import { MouseEvent, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getDbConnections, getDbTables, getFolders, getServers, DbConnection, DbTable, Folder as FolderType, Server as ServerRow } from "@/lib/api";
import { applyTheme, DEFAULT_DARK, DEFAULT_LIGHT, resolveInitialTheme, themeMeta, THEME_EVENT, type ThemeName } from "@/lib/theme";

// Built-in per-role menu sets, used only as a fallback when the server sends no `menus` (or an
// empty one) so the rail is never blank. These mirror app.core.menus.DEFAULT_ROLE_MENUS and the
// sidebar's previous hardcoded behaviour: admins see everything, a desktop guest gets the shell
// and appearance but no account pages, and developer/support get the read-only pages.
function fallbackMenus(role?: string, guest?: boolean): string[] {
  if (guest) return ["dashboard", "servers", "shell", "appearance"];
  if (role === "admin") return ["dashboard", "servers", "shell", "kubernetes", "users", "policies", "administration", "access", "appdatabase", "appearance", "profile"];
  return ["dashboard", "servers", "profile"];
}

export function Sidebar({ role, guest = false, menus }: { role?: string; guest?: boolean; menus?: string[] }) {
  const [open, setOpen] = useState(true);
  // default the Administration group open: the admin account's core pages (Users, Access, Vault,
  // App Database) now live inside it, so hiding them behind a click each visit is friction.
  const [adminOpen, setAdminOpen] = useState(true);
  const [dark, setDark] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  // The rail now renders from the effective menu set (me.menus), not from role checks. An
  // absent/empty set falls back to the built-in per-role defaults so a missing config never
  // yields an empty sidebar. Menu VISIBILITY only: the backend still guards each endpoint by
  // role, so a role that is shown an item it cannot use will simply get a 403 on that page.
  const allowed = useMemo(() => {
    const fromConfig = (menus ?? []).filter(Boolean);
    return new Set(fromConfig.length ? fromConfig : fallbackMenus(role, guest));
  }, [menus, role, guest]);
  // The shell flyout fetches host lists and the shell socket is admin-only; drive its data load
  // off the same visibility flag so a role that is not shown "shell" never fetches for it.
  const canShell = allowed.has("shell");
  // The Administration group collects the admin-only pages. Show the header if the caller may see
  // any child; each item inside is still gated by its own menu key.
  const showAdmin = allowed.has("users") || allowed.has("policies") || allowed.has("access") || allowed.has("vault") || allowed.has("appdatabase") || allowed.has("administration");

  // EXPERIMENTAL (feature/server-folders): the Shell launcher flyout. It lists servers grouped by
  // folder and launches a host shell by navigating to the detail page with ?shell=1. Data is
  // fetched lazily the first time the flyout is opened, and only for admins — the shell socket is
  // admin-only, so there is nothing to launch for anyone else.
  const [shellOpen, setShellOpen] = useState(false);
  const [shellServers, setShellServers] = useState<ServerRow[]>([]);
  const [shellFolders, setShellFolders] = useState<FolderType[]>([]);
  const [shellLoading, setShellLoading] = useState(false);
  const [shellError, setShellError] = useState("");
  // folder public_ids the user has collapsed; everything is expanded by default so hosts are one
  // click away. "" is the Unassigned group.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  async function loadShellData() {
    // Empty token is fine: a desktop guest has no token, and getServers("")/getFolders("") are
    // served from loopback. Bailing on "" was why guest-added servers never appeared here.
    const token = window.localStorage.getItem("inframonitor-token") ?? "";
    setShellLoading(true);
    setShellError("");
    try {
      const [servers, folders] = await Promise.all([getServers(token), getFolders(token)]);
      // only credentialed hosts can actually open a session, so never offer the rest
      setShellServers(servers.filter((server) => server.has_credentials));
      setShellFolders(folders);
    } catch (error) {
      setShellError(error instanceof Error ? error.message : "Unable to load servers");
    } finally {
      setShellLoading(false);
    }
  }

  // Refetch each time the flyout opens so a newly onboarded or re-foldered host shows up without a
  // page reload.
  useEffect(() => {
    if (shellOpen && canShell) void loadShellData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellOpen, canShell]);

  // Group the credentialed hosts by folder, folders in the API's (case-insensitive) order, with
  // Unassigned last and any empty folder omitted — a shell launcher only shows what it can launch.
  const shellGroups = useMemo(() => {
    const folderIds = new Set(shellFolders.map((folder) => folder.id));
    const byKey = new Map<string, ServerRow[]>();
    for (const server of shellServers) {
      const key = server.folder_id && folderIds.has(server.folder_id) ? server.folder_id : "";
      const bucket = byKey.get(key);
      if (bucket) bucket.push(server);
      else byKey.set(key, [server]);
    }
    const groups = shellFolders
      .filter((folder) => byKey.has(folder.id))
      .map((folder) => ({ key: folder.id, name: folder.name, servers: byKey.get(folder.id)! }));
    const unassigned = byKey.get("");
    if (unassigned && unassigned.length) groups.push({ key: "", name: "Unassigned", servers: unassigned });
    return groups;
  }, [shellServers, shellFolders]);

  function toggleGroup(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function launchShell(server: ServerRow) {
    // the detail page auto-opens the host shell when it sees ?shell=1
    setShellOpen(false);
    router.push(`/server/?id=${encodeURIComponent(server.id)}&shell=1`);
  }

  // The Databases launcher flyout (mirrors the Shell one above): it lists the stored DB
  // connections and, on expanding a row, lazily lists that connection's tables so a table can be
  // opened straight into the console. Gated on the same menu key as the console page.
  const canDatabases = allowed.has("databases");
  const [dbOpen, setDbOpen] = useState(false);
  const [dbConnections, setDbConnections] = useState<DbConnection[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState("");
  // connection ids the user has expanded to reveal tables
  const [expandedConns, setExpandedConns] = useState<Set<string>>(new Set());
  // per-connection table load state; a bad/unreachable connection fails in its own row without
  // breaking the flyout
  const [tablesByConn, setTablesByConn] = useState<Record<string, { loading: boolean; error: string; tables: DbTable[] }>>({});
  // the right-click "Open query" context menu, positioned at the cursor
  const [dbMenu, setDbMenu] = useState<{ x: number; y: number; connId: string; table: DbTable } | null>(null);

  async function loadDbConnections() {
    const token = window.localStorage.getItem("inframonitor-token") ?? "";
    setDbLoading(true);
    setDbError("");
    try {
      setDbConnections(await getDbConnections(token));
    } catch (error) {
      setDbError(error instanceof Error ? error.message : "Unable to load connections");
    } finally {
      setDbLoading(false);
    }
  }

  // Refetch on each open so a newly added connection shows up without a reload.
  useEffect(() => {
    if (dbOpen && canDatabases) void loadDbConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbOpen, canDatabases]);

  async function loadTables(connId: string) {
    const token = window.localStorage.getItem("inframonitor-token") ?? "";
    setTablesByConn((current) => ({ ...current, [connId]: { loading: true, error: "", tables: [] } }));
    try {
      const tables = await getDbTables(token, connId);
      setTablesByConn((current) => ({ ...current, [connId]: { loading: false, error: "", tables } }));
    } catch (error) {
      setTablesByConn((current) => ({
        ...current,
        [connId]: { loading: false, error: error instanceof Error ? error.message : "Unable to load tables", tables: [] }
      }));
    }
  }

  function toggleConn(conn: DbConnection) {
    setExpandedConns((current) => {
      const next = new Set(current);
      if (next.has(conn.id)) {
        next.delete(conn.id);
      } else {
        next.add(conn.id);
        // lazily load tables the first time this row is opened
        if (!tablesByConn[conn.id]) void loadTables(conn.id);
      }
      return next;
    });
  }

  function openTable(connId: string, table: DbTable) {
    setDbMenu(null);
    setDbOpen(false);
    const tableParam = `${table.schema}.${table.name}`;
    router.push(`/databases?conn=${encodeURIComponent(connId)}&table=${encodeURIComponent(tableParam)}`);
  }

  function openTableMenu(event: MouseEvent, connId: string, table: DbTable) {
    event.preventDefault();
    setDbMenu({ x: event.clientX, y: event.clientY, connId, table });
  }

  useEffect(() => {
    const saved = localStorage.getItem("inframonitor-sidebar");
    if (saved) setOpen(saved === "open");
    // Apply the persisted theme and accent on mount. The inline script in layout.tsx has
    // already stamped `data-theme` + `dark` pre-paint; re-applying here is idempotent and
    // keeps this component's `dark` state in step with whatever was resolved. The sidebar
    // renders on every authenticated page, so it remains the one place that initialises the
    // look, but the resolution/persistence logic now lives in lib/theme.ts.
    const initial = resolveInitialTheme();
    applyTheme(initial);
    setDark(themeMeta(initial).isDark);
    const accent = localStorage.getItem("inframonitor-accent");
    if (accent) document.documentElement.style.setProperty("--inframonitor-accent", accent);
    // The theme can also change from the picker below (or the one on the appearance page);
    // keep the light/dark icon honest by following the shared theme-change event.
    function onThemeChange(event: Event) {
      const name = (event as CustomEvent<{ name: ThemeName }>).detail?.name;
      if (name) setDark(themeMeta(name).isDark);
    }
    document.documentElement.addEventListener(THEME_EVENT, onThemeChange);
    return () => document.documentElement.removeEventListener(THEME_EVENT, onThemeChange);
  }, []);

  // The plain toggle stays as a one-click shortcut between the two comfortable defaults
  // (Soft Light / Comfortable Dark); the picker underneath it offers the full set. Both
  // funnel through applyTheme, so they can never disagree.
  function toggleTheme() {
    applyTheme(dark ? DEFAULT_LIGHT : DEFAULT_DARK);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    localStorage.setItem("inframonitor-sidebar", next ? "open" : "closed");
  }

  function NavItem({ href, icon: Icon, label, active = false }: { href: string; icon: any; label: string; active?: boolean }) {
    const isActive = active || (pathname && pathname.startsWith(href) && href !== "/") || (href === "/" && pathname === "/");
    return (
      <Link href={href} className={`group flex h-12 items-center gap-4 rounded-full px-4 text-sm font-medium transition-colors ${isActive ? "bg-accent/10 text-accent dark:bg-accent/20" : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"}`} title={!open ? label : undefined}>
        <Icon size={20} className="shrink-0" />
        <span className={`transition-opacity duration-200 ${open ? "opacity-100 w-auto" : "opacity-0 w-0 hidden"}`}>{label}</span>
      </Link>
    );
  }

  return (
    <>
      <button
        onClick={toggle}
        className="fixed left-4 top-3 z-50 inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
        title="Toggle navigation"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>
      {/* Surface + border + brand now flow from the active theme's variables (bg-page /
          border-edge / text-fg) instead of the old hardcoded light/dark pair, so switching
          themes visibly re-skins the whole rail. */}
      <aside className={`${open ? "w-72" : "w-[72px]"} sticky top-0 flex h-screen shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-edge bg-page transition-all duration-300`}>
        <div className="flex h-16 shrink-0 items-center px-4 pl-16">
          <span className={`text-xl font-semibold tracking-tight text-fg transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 hidden"}`}>Infra Monitor Console</span>
        </div>
      <nav className="flex flex-1 flex-col px-2 py-4">
        <div className="grid gap-1">
          {allowed.has("dashboard") && <NavItem href="/" icon={MonitorCog} label="Dashboard" />}
          {allowed.has("servers") && <NavItem href="/servers" icon={Server} label="Servers" />}
          {/* Databases (feature/db-connections): a flyout of stored connections -> tables, mirroring
              the Shell launcher. Gated through the role->menu matrix; the backend also blocks guests
              (require_user_not_guest -> 403). Opening it also opens the rail so the flyout has an anchor. */}
          {canDatabases && (
            <button
              onClick={() => { if (!open) toggle(); setDbOpen((value) => !value); }}
              className={`group flex h-12 items-center gap-4 rounded-full px-4 text-sm font-medium transition-colors ${dbOpen ? "bg-accent/10 text-accent dark:bg-accent/20" : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"}`}
              title={!open ? "Databases" : undefined}
              aria-expanded={dbOpen}
            >
              <Database size={20} className="shrink-0" />
              <span className={`transition-opacity duration-200 ${open ? "opacity-100 w-auto" : "opacity-0 w-0 hidden"}`}>Databases</span>
            </button>
          )}
          {/* Kubernetes clusters (feature/kube-clusters): gated through the role->menu matrix; the
              backend also blocks guests (require_user_not_guest -> 403). */}
          {allowed.has("kubernetes") && <NavItem href="/kubernetes" icon={Boxes} label="Kubernetes" />}
          {/* EXPERIMENTAL (feature/server-folders): the Shell launcher. It is a button, not a
              route — it opens a flyout of hosts grouped by folder. Collapsing the sidebar first
              would hide the flyout's anchor, so opening it also opens the rail. */}
          {canShell && (
            <button
              onClick={() => { if (!open) toggle(); setShellOpen((value) => !value); }}
              className={`group flex h-12 items-center gap-4 rounded-full px-4 text-sm font-medium transition-colors ${shellOpen ? "bg-accent/10 text-accent dark:bg-accent/20" : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"}`}
              title={!open ? "Shell" : undefined}
              aria-expanded={shellOpen}
            >
              <TerminalSquare size={20} className="shrink-0" />
              <span className={`transition-opacity duration-200 ${open ? "opacity-100 w-auto" : "opacity-0 w-0 hidden"}`}>Shell</span>
            </button>
          )}
          {/* Administration groups the admin-only pages (Users, Policies, Access Control, Vault,
              App Database) plus the master-data lists. Each child stays gated by its own menu key;
              the backend endpoints remain require_admin(_not_guest). */}
          {showAdmin && (
            <div className="mt-2">
              <button onClick={() => { if (!open) toggle(); setAdminOpen(!adminOpen); }} className="flex h-12 w-full items-center justify-between rounded-full px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800" title={!open ? "Administration" : undefined}>
                <div className="flex items-center gap-4">
                  <Layers size={20} className="shrink-0" />
                  <span className={`transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 hidden"}`}>Administration</span>
                </div>
                {open && <span className="text-slate-400">{adminOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>}
              </button>
              {adminOpen && open && (
                <div className="mt-1 grid gap-1 pl-4">
                  {allowed.has("users") && <NavItem href="/users" icon={Users} label="Users" />}
                  {allowed.has("policies") && <NavItem href="/policies" icon={Shield} label="Policies" />}
                  {allowed.has("access") && <NavItem href="/access" icon={SlidersHorizontal} label="Access Control" />}
                  {allowed.has("vault") && <NavItem href="/vault" icon={Vault} label="Vault" />}
                  {allowed.has("appdatabase") && <NavItem href="/app-database" icon={DatabaseZap} label="App Database" />}
                  {allowed.has("administration") && <NavItem href="/master/server-types" icon={Settings} label="Server Types" />}
                  {allowed.has("administration") && <NavItem href="/master/environments" icon={Settings} label="Environments" />}
                </div>
              )}
            </div>
          )}
        </div>
        
        <div className="mt-auto grid gap-1 pt-4">
          {/* Profile is a real account's page; a guest has no account, so it stays hidden for a
              guest even if the matrix lists it — a structural guard on top of the menu set. */}
          {!guest && allowed.has("profile") && <NavItem href="/profile" icon={UserCircle} label="Profile" />}
          {allowed.has("appearance") && (
            <NavItem href="/appearance" icon={Palette} label="Appearance" />
          )}
          <button
            onClick={toggleTheme}
            className="group flex h-12 items-center gap-4 rounded-full px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            title={!open ? (dark ? "Light mode" : "Dark mode") : undefined}
            aria-pressed={dark}
          >
            {dark ? <Sun size={20} className="shrink-0" /> : <Moon size={20} className="shrink-0" />}
            <span className={`transition-opacity duration-200 ${open ? "opacity-100 w-auto" : "opacity-0 w-0 hidden"}`}>{dark ? "Light mode" : "Dark mode"}</span>
          </button>
          {/* Full theme selection lives on the Appearance page, not here — this rail keeps only
              the one-click light/dark shortcut above. */}
        </div>
      </nav>
    </aside>
    {/* Shell launcher flyout. Rendered as a fixed sibling (not a child of the overflow-hidden
        aside, which would clip it) and offset by the current rail width so it sits flush against
        the sidebar in both the expanded and collapsed states. */}
    {canShell && shellOpen && (
      <>
        <button aria-label="Close shell launcher" onClick={() => setShellOpen(false)} className="fixed inset-0 z-40 cursor-default" />
        <div style={{ left: open ? 288 : 72 }} className="fixed top-0 z-50 flex h-screen w-80 flex-col border-r border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#161616]">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4 dark:border-slate-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <TerminalSquare size={18} className="text-accent" /> Open a shell
            </div>
            <button onClick={() => setShellOpen(false)} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {shellLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-slate-500 dark:text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading servers…</div>
            ) : shellError ? (
              <div className="px-3 py-4 text-sm font-medium text-danger dark:text-red-400">{shellError}</div>
            ) : shellGroups.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">No servers with stored credentials to open a shell on.</div>
            ) : (
              <div className="grid gap-1">
                {shellGroups.map((group) => {
                  const isCollapsed = collapsed.has(group.key);
                  return (
                    <div key={group.key || "__unassigned__"}>
                      <button onClick={() => toggleGroup(group.key)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
                        {isCollapsed ? <ChevronRight size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                        {group.key ? <FolderIcon size={14} className="text-accent" /> : <Server size={14} className="text-slate-400" />}
                        <span className="flex-1 truncate text-slate-700 dark:text-slate-300">{group.name}</span>
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{group.servers.length}</span>
                      </button>
                      {!isCollapsed && (
                        <div className="mb-1 grid gap-0.5 pl-4">
                          {group.servers.map((server) => (
                            <button key={server.id} onClick={() => launchShell(server)} title={`Open a shell on ${server.hostname}`} className="group flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-accent/10 hover:text-accent dark:text-slate-300 dark:hover:bg-accent/20">
                              <TerminalSquare size={14} className="shrink-0 text-slate-400 transition-colors group-hover:text-accent" />
                              <span className="flex-1 truncate">{server.hostname}</span>
                              <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{server.ip_address}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </>
    )}
    {/* Databases launcher flyout. Same fixed-sibling pattern as the Shell flyout: offset by the
        current rail width, lists stored connections, each row expands to its tables. */}
    {canDatabases && dbOpen && (
      <>
        <button aria-label="Close databases launcher" onClick={() => { setDbOpen(false); setDbMenu(null); }} className="fixed inset-0 z-40 cursor-default" />
        <div style={{ left: open ? 288 : 72 }} className="fixed top-0 z-50 flex h-screen w-80 flex-col border-r border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-[#161616]">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-4 dark:border-slate-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <Database size={18} className="text-accent" /> Databases
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setDbOpen(false); setDbMenu(null); router.push("/databases"); }}
                className="rounded-full px-3 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/10 dark:hover:bg-accent/20"
              >
                Open console
              </button>
              <button onClick={() => { setDbOpen(false); setDbMenu(null); }} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {dbLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-slate-500 dark:text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading connections…</div>
            ) : dbError ? (
              <div className="px-3 py-4 text-sm font-medium text-danger dark:text-red-400">{dbError}</div>
            ) : dbConnections.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-500 dark:text-slate-400">No stored connections yet. Open the console to add one.</div>
            ) : (
              <div className="grid gap-1">
                {dbConnections.map((conn) => {
                  const isExpanded = expandedConns.has(conn.id);
                  const state = tablesByConn[conn.id];
                  return (
                    <div key={conn.id}>
                      <button onClick={() => toggleConn(conn)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors hover:bg-slate-100 dark:hover:bg-slate-800">
                        {isExpanded ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
                        <Database size={14} className="shrink-0 text-accent" />
                        <span className="flex-1 truncate text-slate-700 dark:text-slate-300">{conn.name}</span>
                        {state && !state.loading && !state.error && (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">{state.tables.length}</span>
                        )}
                      </button>
                      {isExpanded && (
                        <div className="mb-1 grid gap-0.5 pl-4">
                          {!state || state.loading ? (
                            <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-500 dark:text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading tables…</div>
                          ) : state.error ? (
                            <div className="px-3 py-2 text-xs font-medium text-danger dark:text-red-400">{state.error}</div>
                          ) : state.tables.length === 0 ? (
                            <div className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">No tables.</div>
                          ) : (
                            state.tables.map((table) => (
                              <button
                                key={`${table.schema}.${table.name}`}
                                onClick={() => openTable(conn.id, table)}
                                onContextMenu={(event) => openTableMenu(event, conn.id, table)}
                                title={`Open ${table.schema}.${table.name}`}
                                className="group flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-accent/10 hover:text-accent dark:text-slate-300 dark:hover:bg-accent/20"
                              >
                                <TableIcon size={13} className="shrink-0 text-slate-400 transition-colors group-hover:text-accent" />
                                <span className="flex-1 truncate">{table.schema}.{table.name}</span>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {dbMenu && (
          <>
            <button aria-label="Close menu" onClick={() => setDbMenu(null)} className="fixed inset-0 z-[60] cursor-default" />
            <div style={{ left: dbMenu.x, top: dbMenu.y }} className="fixed z-[61] min-w-[140px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-xl dark:border-slate-700 dark:bg-[#1e1e1e]">
              <button
                onClick={() => openTable(dbMenu.connId, dbMenu.table)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-accent/10 hover:text-accent dark:text-slate-300 dark:hover:bg-accent/20"
              >
                <Play size={13} className="shrink-0" /> Open query
              </button>
            </div>
          </>
        )}
      </>
    )}
    </>
  );
}
