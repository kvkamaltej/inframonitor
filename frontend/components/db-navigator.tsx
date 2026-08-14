"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns,
  Database,
  Eye,
  Folder,
  FolderOpen,
  FunctionSquare,
  Hash,
  KeyRound,
  Link as LinkIcon,
  Loader2,
  PlugZap,
  Plus,
  RefreshCw,
  Table2
} from "lucide-react";
import {
  createDbConnection,
  deleteDbConnection,
  getDbColumns,
  getDbConnections,
  getDbConstraints,
  getDbForeignKeys,
  getDbIndexes,
  getDbSchemas,
  getDbSchemaRoutines,
  getDbSchemaTables,
  testDbConnection,
  testDbConnectionById,
  updateDbConnection,
  type DbConnection,
  type DbConnectionInput,
  type DbEngine
} from "@/lib/api";
import { useConfirm } from "@/components/confirm-dialog";

// The context object every navigator callback receives. schema/table are present only on the nodes
// where they make sense (a table node carries both; a connection node neither).
export type DbNavigatorCtx = {
  connectionId: string;
  connectionName: string;
  engine: string;
  environment: string;
  schema?: string;
  table?: string;
};

type DbNavigatorProps = {
  token: string;
  onOpenEditor: (ctx: DbNavigatorCtx) => void;
  onViewData: (ctx: DbNavigatorCtx) => void;
  onGenerate: (ctx: DbNavigatorCtx, kind: string) => void;
  // bump to force the top-level connection list to reload (e.g. after the workspace edits one)
  refreshKey?: number;
};

type ConnStatus = "unknown" | "testing" | "healthy" | "error";

const DEFAULT_PORTS: Record<DbEngine, number> = { postgres: 5432, mysql: 3306 };

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

// --- shared navigator context ---------------------------------------------------------------
// Lifted so a node can invoke a workspace callback, open the connection dialog, or find out which
// menu is currently open without threading a dozen props through every recursion level.

type MenuKind = "connection" | "schema" | "table" | null;

type NavContextValue = {
  token: string;
  onOpenEditor: (ctx: DbNavigatorCtx) => void;
  onViewData: (ctx: DbNavigatorCtx) => void;
  onGenerate: (ctx: DbNavigatorCtx, kind: string) => void;
  statuses: Record<string, ConnStatus>;
  testConnection: (id: string) => void;
  openConnDialog: (conn: DbConnection | null) => void;
  deleteConnection: (conn: DbConnection) => void;
  // which node's context menu is open (a node's stable id), and its cursor anchor
  openMenuId: string | null;
  menuAnchor: { x: number; y: number };
  openMenu: (id: string, x: number, y: number) => void;
  closeMenu: () => void;
};

const NavContext = createContext<NavContextValue | null>(null);
function useNav() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("NavContext missing");
  return ctx;
}

// --- tree node descriptor -------------------------------------------------------------------

type NodeKind =
  | "schema"
  | "folder"
  | "table"
  | "view"
  | "routine"
  | "column"
  | "index"
  | "constraint"
  | "fkey";

type TreeNodeDescriptor = {
  id: string;
  kind: NodeKind;
  label: string;
  sublabel?: string;
  ctx: DbNavigatorCtx;
  menuKind?: MenuKind;
  // undefined => a leaf that cannot expand
  loadChildren?: () => Promise<TreeNodeDescriptor[]>;
};

function iconFor(kind: NodeKind | "connection", open: boolean) {
  switch (kind) {
    case "connection":
      return <Database size={15} className="shrink-0 text-accent" />;
    case "schema":
      return <Database size={15} className="shrink-0 text-muted" />;
    case "folder":
      return open ? <FolderOpen size={15} className="shrink-0 text-amber-500" /> : <Folder size={15} className="shrink-0 text-amber-500" />;
    case "table":
      return <Table2 size={15} className="shrink-0 text-sky-500" />;
    case "view":
      return <Eye size={15} className="shrink-0 text-violet-500" />;
    case "routine":
      return <FunctionSquare size={15} className="shrink-0 text-emerald-500" />;
    case "column":
      return <Columns size={15} className="shrink-0 text-muted" />;
    case "index":
      return <Hash size={15} className="shrink-0 text-muted" />;
    case "constraint":
      return <KeyRound size={15} className="shrink-0 text-muted" />;
    case "fkey":
      return <LinkIcon size={15} className="shrink-0 text-muted" />;
    default:
      return <Folder size={15} className="shrink-0 text-muted" />;
  }
}

// --- children builders (one per drill level) ------------------------------------------------

function buildTableFolders(token: string, connId: string, ctx: DbNavigatorCtx, schema: string, table: string): TreeNodeDescriptor[] {
  const base = `${connId}:${schema}:${table}`;
  const childCtx: DbNavigatorCtx = { ...ctx, schema, table };
  return [
    {
      id: `${base}:columns`,
      kind: "folder",
      label: "Columns",
      ctx: childCtx,
      loadChildren: async () => {
        const cols = await getDbColumns(token, connId, schema, table);
        return cols.map((c) => ({
          id: `${base}:col:${c.name}`,
          kind: "column" as NodeKind,
          label: c.name,
          sublabel: `${c.data_type}${c.is_primary_key ? " · PK" : ""}${c.nullable ? "" : " · not null"}`,
          ctx: childCtx
        }));
      }
    },
    {
      id: `${base}:indexes`,
      kind: "folder",
      label: "Indexes",
      ctx: childCtx,
      loadChildren: async () => {
        const idx = await getDbIndexes(token, connId, schema, table);
        return idx.map((i) => ({
          id: `${base}:idx:${i.name}`,
          kind: "index" as NodeKind,
          label: i.name,
          sublabel: `${i.columns.join(", ")}${i.unique ? " · unique" : ""}${i.primary ? " · primary" : ""}`,
          ctx: childCtx
        }));
      }
    },
    {
      id: `${base}:constraints`,
      kind: "folder",
      label: "Constraints",
      ctx: childCtx,
      loadChildren: async () => {
        const cons = await getDbConstraints(token, connId, schema, table);
        return cons.map((c) => ({
          id: `${base}:con:${c.name}`,
          kind: "constraint" as NodeKind,
          label: c.name,
          sublabel: c.type,
          ctx: childCtx
        }));
      }
    },
    {
      id: `${base}:fkeys`,
      kind: "folder",
      label: "Foreign Keys",
      ctx: childCtx,
      loadChildren: async () => {
        const fks = await getDbForeignKeys(token, connId, schema, table);
        return fks.map((f) => ({
          id: `${base}:fk:${f.name}`,
          kind: "fkey" as NodeKind,
          label: f.name,
          sublabel: `${f.columns.join(", ")} → ${f.ref_schema}.${f.ref_table}(${f.ref_columns.join(", ")})`,
          ctx: childCtx
        }));
      }
    }
  ];
}

function buildSchemaFolders(token: string, connId: string, ctx: DbNavigatorCtx, schema: string): TreeNodeDescriptor[] {
  const base = `${connId}:${schema}`;
  const childCtx: DbNavigatorCtx = { ...ctx, schema };
  const makeObject = (kind: NodeKind) => (o: { schema: string; name: string; type: string }): TreeNodeDescriptor => ({
    id: `${base}:${kind}:${o.name}`,
    kind,
    label: o.name,
    ctx: { ...childCtx, table: o.name },
    menuKind: "table",
    loadChildren: () => Promise.resolve(buildTableFolders(token, connId, ctx, schema, o.name))
  });
  return [
    {
      id: `${base}:tables`,
      kind: "folder",
      label: "Tables",
      ctx: childCtx,
      loadChildren: async () => {
        const objs = await getDbSchemaTables(token, connId, schema);
        return objs.filter((o) => o.type !== "view").map(makeObject("table"));
      }
    },
    {
      id: `${base}:views`,
      kind: "folder",
      label: "Views",
      ctx: childCtx,
      loadChildren: async () => {
        const objs = await getDbSchemaTables(token, connId, schema);
        return objs.filter((o) => o.type === "view").map(makeObject("view"));
      }
    },
    {
      id: `${base}:routines`,
      kind: "folder",
      label: "Routines",
      ctx: childCtx,
      loadChildren: async () => {
        const routines = await getDbSchemaRoutines(token, connId, schema);
        return routines.map((r) => ({
          id: `${base}:routine:${r.name}`,
          kind: "routine" as NodeKind,
          label: r.name,
          sublabel: r.kind,
          ctx: childCtx
        }));
      }
    }
  ];
}

// --- context menu ---------------------------------------------------------------------------

type MenuItem = { label: string; danger?: boolean; onClick: () => void };

function ContextMenu({ items }: { items: MenuItem[] }) {
  const { menuAnchor, closeMenu } = useNav();
  // Keep the menu inside the viewport: clamp so a right-click near the bottom/right edge doesn't
  // push it off-screen.
  const x = Math.min(menuAnchor.x, (typeof window !== "undefined" ? window.innerWidth : 9999) - 210);
  const y = Math.min(menuAnchor.y, (typeof window !== "undefined" ? window.innerHeight : 9999) - (items.length * 34 + 16));
  return (
    <>
      <button aria-label="Close menu" className="fixed inset-0 z-[95] cursor-default" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
      <div
        className="fixed z-[96] min-w-[190px] overflow-hidden rounded-xl border border-edge bg-elevated py-1 shadow-xl"
        style={{ left: Math.max(4, x), top: Math.max(4, y) }}
      >
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            onClick={() => {
              closeMenu();
              item.onClick();
            }}
            className={`flex w-full items-center px-3 py-1.5 text-left text-sm font-medium transition-colors hover:bg-surface ${
              item.danger ? "text-danger" : "text-fg"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

// --- a single tree node ---------------------------------------------------------------------

function TreeNode({ node, depth }: { node: TreeNodeDescriptor; depth: number }) {
  const nav = useNav();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [children, setChildren] = useState<TreeNodeDescriptor[] | null>(null);

  const canExpand = Boolean(node.loadChildren);

  const load = useCallback(async () => {
    if (!node.loadChildren) return;
    setLoading(true);
    setError("");
    try {
      setChildren(await node.loadChildren());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [node]);

  const toggle = useCallback(() => {
    if (!canExpand) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) void load();
  }, [canExpand, expanded, children, load]);

  // Refresh from the context menu: drop cached children and refetch if currently open.
  const refresh = useCallback(() => {
    setChildren(null);
    setError("");
    if (expanded) void load();
    else {
      setExpanded(true);
      void load();
    }
  }, [expanded, load]);

  function onContextMenu(e: ReactMouseEvent) {
    if (!node.menuKind) return;
    e.preventDefault();
    e.stopPropagation();
    nav.openMenu(node.id, e.clientX, e.clientY);
  }

  function onLeftClick() {
    // Left-clicking a table (or view) opens a data tab; other nodes just toggle.
    if (node.kind === "table" || node.kind === "view") {
      nav.onViewData(node.ctx);
      return;
    }
    toggle();
  }

  const menuItems: MenuItem[] = useMemo(() => {
    if (node.menuKind === "schema") {
      return [
        { label: "Open SQL Editor", onClick: () => nav.onOpenEditor(node.ctx) },
        { label: "Refresh", onClick: refresh }
      ];
    }
    if (node.menuKind === "table") {
      return [
        { label: "View Data", onClick: () => nav.onViewData(node.ctx) },
        { label: "Open SQL Editor", onClick: () => nav.onOpenEditor(node.ctx) },
        { label: "Generate: SELECT", onClick: () => nav.onGenerate(node.ctx, "SELECT") },
        { label: "Generate: INSERT", onClick: () => nav.onGenerate(node.ctx, "INSERT") },
        { label: "Generate: UPDATE", onClick: () => nav.onGenerate(node.ctx, "UPDATE") },
        { label: "Generate: DELETE", onClick: () => nav.onGenerate(node.ctx, "DELETE") },
        { label: "Generate: CREATE", onClick: () => nav.onGenerate(node.ctx, "CREATE") },
        { label: "Refresh", onClick: refresh }
      ];
    }
    return [];
  }, [node, nav, refresh]);

  return (
    <div>
      <div
        onContextMenu={onContextMenu}
        className="group flex cursor-pointer select-none items-center gap-1 rounded-md py-1 pr-2 text-sm hover:bg-surface"
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={onLeftClick}
        title={node.sublabel ? `${node.label} — ${node.sublabel}` : node.label}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted" onClick={(e) => { e.stopPropagation(); toggle(); }}>
          {canExpand ? (
            loading ? <Loader2 size={12} className="animate-spin" /> : expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
          ) : null}
        </span>
        {iconFor(node.kind, expanded)}
        <span className="truncate font-medium text-fg">{node.label}</span>
        {node.sublabel && <span className="truncate text-xs text-muted">{node.sublabel}</span>}
      </div>

      {nav.openMenuId === node.id && menuItems.length > 0 && <ContextMenu items={menuItems} />}

      {expanded && (
        <div>
          {error ? (
            <div className="flex items-center gap-1.5 py-1 text-xs text-danger" style={{ paddingLeft: (depth + 1) * 14 + 8 }}>
              <AlertTriangle size={12} /> {error}
            </div>
          ) : children && children.length === 0 && !loading ? (
            <div className="py-1 text-xs italic text-muted" style={{ paddingLeft: (depth + 1) * 14 + 8 }}>
              (empty)
            </div>
          ) : (
            children?.map((child) => <TreeNode key={child.id} node={child} depth={depth + 1} />)
          )}
        </div>
      )}
    </div>
  );
}

// --- connection node (level 0) --------------------------------------------------------------

function statusDotClass(status: ConnStatus): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500";
    case "error":
      return "bg-danger";
    case "testing":
      return "bg-amber-400 animate-pulse";
    default:
      return "bg-slate-400/60";
  }
}

function EnvBadge({ environment }: { environment: string }) {
  const env = (environment || "").toLowerCase();
  if (!env) return null;
  const isProd = env === "prod";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide ${
        isProd ? "bg-danger/15 text-danger" : "bg-surface text-muted ring-1 ring-edge"
      }`}
    >
      {env}
    </span>
  );
}

function ConnectionNode({ conn }: { conn: DbConnection }) {
  const nav = useNav();
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [children, setChildren] = useState<TreeNodeDescriptor[] | null>(null);

  const ctx: DbNavigatorCtx = {
    connectionId: conn.id,
    connectionName: conn.name,
    engine: conn.engine,
    environment: conn.environment
  };
  const nodeId = `conn:${conn.id}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const schemas = await getDbSchemas(nav.token, conn.id);
      setChildren(
        schemas.map((s) => ({
          id: `${conn.id}:${s.name}`,
          kind: "schema" as NodeKind,
          label: s.name,
          ctx: { ...ctx, schema: s.name },
          menuKind: "schema" as MenuKind,
          loadChildren: () => Promise.resolve(buildSchemaFolders(nav.token, conn.id, ctx, s.name))
        }))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load schemas");
      setChildren([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, nav.token]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) void load();
  }, [expanded, children, load]);

  const refresh = useCallback(() => {
    setChildren(null);
    setExpanded(true);
    void load();
  }, [load]);

  const status = nav.statuses[conn.id] ?? "unknown";

  const menuItems: MenuItem[] = [
    { label: "Open SQL Editor", onClick: () => nav.onOpenEditor(ctx) },
    { label: "Test connection", onClick: () => nav.testConnection(conn.id) },
    { label: "Refresh", onClick: refresh },
    { label: "Edit", onClick: () => nav.openConnDialog(conn) },
    { label: "Delete", danger: true, onClick: () => nav.deleteConnection(conn) }
  ];

  return (
    <div>
      <div
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          nav.openMenu(nodeId, e.clientX, e.clientY);
        }}
        onClick={toggle}
        className="group flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1 py-1.5 text-sm hover:bg-surface"
        title={`${conn.name} — ${conn.username ? `${conn.username}@` : ""}${conn.host}:${conn.port}${conn.database ? `/${conn.database}` : ""}`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted">
          {loading ? <Loader2 size={12} className="animate-spin" /> : expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(status)}`} title={`Status: ${status}`} />
        <Database size={15} className="shrink-0 text-accent" />
        <span className="truncate font-semibold text-fg">{conn.name}</span>
        <EnvBadge environment={conn.environment} />
      </div>

      {nav.openMenuId === nodeId && <ContextMenu items={menuItems} />}

      {expanded && (
        <div>
          {error ? (
            <div className="flex items-center gap-1.5 py-1 pl-6 text-xs text-danger">
              <AlertTriangle size={12} /> {error}
            </div>
          ) : children && children.length === 0 && !loading ? (
            <div className="py-1 pl-6 text-xs italic text-muted">(no schemas)</div>
          ) : (
            children?.map((child) => <TreeNode key={child.id} node={child} depth={1} />)
          )}
        </div>
      )}
    </div>
  );
}

// --- connection create/edit dialog ----------------------------------------------------------

function ConnectionDialog({
  token,
  editing,
  onClose,
  onSaved
}: {
  token: string;
  editing: DbConnection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [engine, setEngine] = useState<DbEngine>(editing?.engine ?? "postgres");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState<number>(editing?.port ?? DEFAULT_PORTS.postgres);
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(editing?.database ?? "");
  const [environment, setEnvironment] = useState(editing?.environment ?? "");
  const [group, setGroup] = useState(editing?.group ?? "");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [error, setError] = useState("");

  function changeEngine(next: DbEngine) {
    setPort((current) => (current === DEFAULT_PORTS[engine] ? DEFAULT_PORTS[next] : current));
    setEngine(next);
    setNote(null);
  }

  function input(): DbConnectionInput {
    return {
      name: name.trim(),
      engine,
      host: host.trim(),
      port: Number(port) || DEFAULT_PORTS[engine],
      username,
      database: database.trim(),
      environment: environment || "",
      group: group.trim() ? group.trim() : null
    };
  }

  async function test() {
    setTesting(true);
    setNote(null);
    try {
      const res = await testDbConnection(token, { ...input(), password });
      setNote({ kind: res.ok ? "ok" : "error", text: res.message });
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : "Connection test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (editing) {
        const payload: Partial<DbConnectionInput> = { ...input() };
        // A blank password on edit keeps the stored one; only send it when the user typed one.
        if (password) payload.password = password;
        await updateDbConnection(token, editing.id, payload);
      } else {
        await createDbConnection(token, { ...input(), password });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save connection");
    } finally {
      setSaving(false);
    }
  }

  function engineButton(value: DbEngine, label: string) {
    const active = engine === value;
    return (
      <button
        type="button"
        onClick={() => changeEngine(value)}
        className={`h-11 flex-1 rounded-xl px-4 text-sm font-semibold transition-colors ${
          active ? "bg-accent text-white" : "bg-surface text-muted ring-1 ring-edge hover:text-fg"
        }`}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[92] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 cursor-default" />
      <form
        onSubmit={save}
        className="relative z-10 grid w-full max-w-2xl gap-4 overflow-hidden rounded-2xl bg-elevated p-6 shadow-xl ring-1 ring-edge md:grid-cols-2"
      >
        <div className="md:col-span-2">
          <h2 className="text-base font-semibold text-fg">{editing ? "Edit connection" : "New connection"}</h2>
        </div>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Reporting replica" className={inputClass} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
          Engine
          <div className="flex gap-2">
            {engineButton("postgres", "PostgreSQL")}
            {engineButton("mysql", "MySQL")}
          </div>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Host
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.example.internal" className={inputClass} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Port
          <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} className={inputClass} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="reader" className={inputClass} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder={editing ? "•••••••• (unchanged)" : "••••••••"}
            className={inputClass}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Database
          <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="app" className={inputClass} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
          Environment
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)} className={inputClass}>
            <option value="">None</option>
            <option value="dev">dev</option>
            <option value="qa">qa</option>
            <option value="uat">uat</option>
            <option value="prod">prod</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
          Group
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Optional" className={inputClass} />
        </label>

        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <button
            type="submit"
            disabled={saving || !name.trim() || !host.trim()}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            {editing ? "Save changes" : "Save connection"}
          </button>
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || !host.trim()}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-surface px-5 text-sm font-semibold text-fg ring-1 ring-edge transition-colors hover:text-accent disabled:opacity-50"
          >
            {testing ? <Loader2 size={16} className="animate-spin" /> : <PlugZap size={16} />}
            Test
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold text-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
        </div>
        {note && (
          <div
            className={`flex items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium md:col-span-2 ${
              note.kind === "ok" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-danger/10 text-danger dark:text-red-300"
            }`}
          >
            {note.kind === "ok" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
            <span className="break-words">{note.text}</span>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger dark:text-red-300 md:col-span-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
      </form>
    </div>
  );
}

// --- the navigator --------------------------------------------------------------------------

export function DbNavigator(props: DbNavigatorProps) {
  const { token, onOpenEditor, onViewData, onGenerate, refreshKey } = props;
  const { confirm, confirmDialog } = useConfirm();

  const [connections, setConnections] = useState<DbConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState("");
  const [statuses, setStatuses] = useState<Record<string, ConnStatus>>({});

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState({ x: 0, y: 0 });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DbConnection | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      setConnections(await getDbConnections(token));
      setListError("");
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Unable to load connections");
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections, refreshKey]);

  const testConnection = useCallback(
    async (id: string) => {
      setStatuses((s) => ({ ...s, [id]: "testing" }));
      try {
        const res = await testDbConnectionById(token, id);
        setStatuses((s) => ({ ...s, [id]: res.ok ? "healthy" : "error" }));
      } catch {
        setStatuses((s) => ({ ...s, [id]: "error" }));
      }
    },
    [token]
  );

  const openConnDialog = useCallback((conn: DbConnection | null) => {
    setEditing(conn);
    setDialogOpen(true);
  }, []);

  const deleteConnection = useCallback(
    async (conn: DbConnection) => {
      if (
        !(await confirm({
          title: `Delete ${conn.name}?`,
          message: "The stored connection and its credentials are removed. This cannot be undone.",
          confirmLabel: "Delete connection",
          danger: true
        }))
      )
        return;
      try {
        await deleteDbConnection(token, conn.id);
        await loadConnections();
      } catch (e) {
        setListError(e instanceof Error ? e.message : "Unable to delete connection");
      }
    },
    [confirm, token, loadConnections]
  );

  const navValue: NavContextValue = useMemo(
    () => ({
      token,
      onOpenEditor,
      onViewData,
      onGenerate,
      statuses,
      testConnection,
      openConnDialog,
      deleteConnection,
      openMenuId,
      menuAnchor,
      openMenu: (id, x, y) => {
        setMenuAnchor({ x, y });
        setOpenMenuId(id);
      },
      closeMenu: () => setOpenMenuId(null)
    }),
    [token, onOpenEditor, onViewData, onGenerate, statuses, testConnection, openConnDialog, deleteConnection, openMenuId, menuAnchor]
  );

  return (
    <NavContext.Provider value={navValue}>
      {confirmDialog}
      {dialogOpen && (
        <ConnectionDialog
          token={token}
          editing={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={() => {
            setDialogOpen(false);
            void loadConnections();
          }}
        />
      )}

      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-edge px-3 py-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Database size={16} className="text-accent" /> Connections
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void loadConnections()}
              title="Reload connections"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-fg"
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              onClick={() => openConnDialog(null)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-xs font-semibold text-white transition-colors hover:bg-accent/80"
            >
              <Plus size={14} /> New
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-2 py-2">
          {listError && (
            <div className="mb-2 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span className="break-words">{listError}</span>
            </div>
          )}
          {!loaded ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : connections.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted">No connections yet. Add one with “New”.</p>
          ) : (
            connections.map((conn) => <ConnectionNode key={conn.id} conn={conn} />)
          )}
        </div>
      </div>
    </NavContext.Provider>
  );
}
