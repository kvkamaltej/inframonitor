"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
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
  Search,
  Server,
  Table2
} from "lucide-react";
import {
  backupDbConnection,
  createDbConnection,
  deleteDbConnection,
  getDbColumns,
  getDbConnections,
  getDbConstraints,
  getDbDatabases,
  getDbForeignKeys,
  getDbIndexes,
  getDbSchemas,
  getDbSchemaRoutines,
  getDbSchemaTables,
  renameDbSchema,
  restoreDbConnection,
  testDbConnection,
  testDbConnectionById,
  updateDbConnection,
  type DbConnection,
  type DbConnectionInput,
  type DbConnEngine
} from "@/lib/api";
import { useConfirm } from "@/components/confirm-dialog";

// The context object every navigator callback receives. schema/table are present only on the nodes
// where they make sense (a table node carries both; a connection node neither).
export type DbNavigatorCtx = {
  connectionId: string;
  connectionName: string;
  engine: string;
  environment: string;
  // set only when browsing a NON-default database via "Show all databases"; threaded into every
  // metadata call and the generate-SQL body so the whole subtree targets that database.
  database?: string;
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

// sqlite is file-backed and has no port; 0 stands in and is never sent for a sqlite connection.
const DEFAULT_PORTS: Record<DbConnEngine, number> = { postgres: 5432, mysql: 3306, sqlite: 0, mssql: 1433 };

const inputClass =
  "h-11 w-full rounded-xl border-none bg-surface px-4 text-sm font-medium text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent";

// --- shared navigator context ---------------------------------------------------------------
// Lifted so a node can invoke a workspace callback, open the connection dialog, or find out which
// menu is currently open without threading a dozen props through every recursion level.

type MenuKind = "connection" | "database" | "schema" | "table" | null;

type NavContextValue = {
  token: string;
  onOpenEditor: (ctx: DbNavigatorCtx) => void;
  onViewData: (ctx: DbNavigatorCtx) => void;
  onGenerate: (ctx: DbNavigatorCtx, kind: string) => void;
  statuses: Record<string, ConnStatus>;
  testConnection: (id: string) => void;
  openConnDialog: (conn: DbConnection | null) => void;
  deleteConnection: (conn: DbConnection) => void;
  // postgres-only maintenance: dump a database to a file, or restore one from an uploaded dump
  backupConnection: (connId: string, database?: string) => void;
  restoreConnection: (connId: string, database?: string) => void;
  // prompt-and-rename a schema, then reload the owning connection's subtree
  renameSchema: (connId: string, schema: string) => void;
  // force a connection node to drop its cached children and refetch (schema rename, reconnect)
  reloadKeys: Record<string, number>;
  reloadConnection: (connId: string) => void;
  // which node's context menu is open (a node's stable id), and its cursor anchor
  openMenuId: string | null;
  menuAnchor: { x: number; y: number };
  openMenu: (id: string, x: number, y: number) => void;
  closeMenu: () => void;
  // lowercased object-name filter; when non-empty the tree hides table/view/routine nodes whose
  // label does not contain it. Structural nodes (schemas, folders, columns) are never filtered out.
  filter: string;
  // per-connection "Show all databases" flag and its toggle
  showAllDb: Record<string, boolean>;
  toggleShowAllDb: (id: string) => void;
};

const NavContext = createContext<NavContextValue | null>(null);
function useNav() {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error("NavContext missing");
  return ctx;
}

// --- tree node descriptor -------------------------------------------------------------------

type NodeKind =
  | "database"
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
    case "database":
      return <Server size={15} className="shrink-0 text-cyan-500" />;
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
  // Threaded so a table opened under a non-default database queries THAT database's metadata.
  const database = ctx.database;
  const base = database ? `${connId}:${database}:${schema}:${table}` : `${connId}:${schema}:${table}`;
  const childCtx: DbNavigatorCtx = { ...ctx, schema, table };
  return [
    {
      id: `${base}:columns`,
      kind: "folder",
      label: "Columns",
      ctx: childCtx,
      loadChildren: async () => {
        const cols = await getDbColumns(token, connId, schema, table, database);
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
        const idx = await getDbIndexes(token, connId, schema, table, database);
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
        const cons = await getDbConstraints(token, connId, schema, table, database);
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
        const fks = await getDbForeignKeys(token, connId, schema, table, database);
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
  const database = ctx.database;
  // Namespace node ids by database so identically-named schemas across databases don't collide.
  const base = database ? `${connId}:${database}:${schema}` : `${connId}:${schema}`;
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
        const objs = await getDbSchemaTables(token, connId, schema, database);
        return objs.filter((o) => o.type !== "view").map(makeObject("table"));
      }
    },
    {
      id: `${base}:views`,
      kind: "folder",
      label: "Views",
      ctx: childCtx,
      loadChildren: async () => {
        const objs = await getDbSchemaTables(token, connId, schema, database);
        return objs.filter((o) => o.type === "view").map(makeObject("view"));
      }
    },
    {
      id: `${base}:routines`,
      kind: "folder",
      label: "Routines",
      ctx: childCtx,
      loadChildren: async () => {
        const routines = await getDbSchemaRoutines(token, connId, schema, database);
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

// Fetches a connection's (or a specific database's) schemas and turns them into schema nodes. The
// database override, when present, rides on `ctx.database` and is threaded to getDbSchemas and on
// into every schema/table metadata call below it.
async function buildSchemaNodes(token: string, connId: string, ctx: DbNavigatorCtx): Promise<TreeNodeDescriptor[]> {
  const schemas = await getDbSchemas(token, connId, ctx.database);
  const prefix = ctx.database ? `${connId}:${ctx.database}` : connId;
  return schemas.map((s) => ({
    id: `${prefix}:${s.name}`,
    kind: "schema" as NodeKind,
    label: s.name,
    ctx: { ...ctx, schema: s.name },
    menuKind: "schema" as MenuKind,
    loadChildren: () => Promise.resolve(buildSchemaFolders(token, connId, ctx, s.name))
  }));
}

// A "Show all databases" node: a database on the server, expanding to its schemas. Its ctx carries
// `database` so the whole subtree targets that database rather than the connection's stored default.
function buildDatabaseNode(token: string, connId: string, connCtx: DbNavigatorCtx, dbName: string): TreeNodeDescriptor {
  const dbCtx: DbNavigatorCtx = { ...connCtx, database: dbName };
  return {
    id: `${connId}:db:${dbName}`,
    kind: "database",
    label: dbName,
    ctx: dbCtx,
    menuKind: "database",
    loadChildren: () => buildSchemaNodes(token, connId, dbCtx)
  };
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

  // Object-name filter: hide table/view/routine children whose label doesn't match. Structural
  // nodes (folders, columns, indexes, …) pass through untouched so the tree shape stays intact.
  const filter = nav.filter.trim().toLowerCase();
  const visibleChildren =
    children && filter
      ? children.filter((c) =>
          c.kind === "table" || c.kind === "view" || c.kind === "routine" ? c.label.toLowerCase().includes(filter) : true
        )
      : children;

  const menuItems: MenuItem[] = useMemo(() => {
    if (node.menuKind === "database") {
      const items: MenuItem[] = [
        { label: "Open SQL Editor", onClick: () => nav.onOpenEditor(node.ctx) },
        { label: "Refresh", onClick: refresh }
      ];
      // Backup/restore are postgres-only (pg_dump/pg_restore); hide them for other engines.
      if (node.ctx.engine === "postgres") {
        items.push({ label: "Backup", onClick: () => nav.backupConnection(node.ctx.connectionId, node.ctx.database) });
        items.push({ label: "Restore", danger: true, onClick: () => nav.restoreConnection(node.ctx.connectionId, node.ctx.database) });
      }
      return items;
    }
    if (node.menuKind === "schema") {
      const items: MenuItem[] = [
        { label: "Open SQL Editor", onClick: () => nav.onOpenEditor(node.ctx) }
      ];
      // Rename schema is postgres-only server-side; offer it only where it can succeed.
      if (node.ctx.engine === "postgres") {
        items.push({ label: "Rename schema", onClick: () => nav.renameSchema(node.ctx.connectionId, node.ctx.schema || "") });
      }
      items.push({ label: "Refresh", onClick: refresh });
      return items;
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
          ) : visibleChildren && visibleChildren.length === 0 && !loading ? (
            <div className="py-1 text-xs italic text-muted" style={{ paddingLeft: (depth + 1) * 14 + 8 }}>
              {children && children.length > 0 ? "(no match)" : "(empty)"}
            </div>
          ) : (
            visibleChildren?.map((child) => <TreeNode key={child.id} node={child} depth={depth + 1} />)
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
      return "bg-muted/60";
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
  const showAll = nav.showAllDb[conn.id] ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (showAll) {
        // Under the connection, list the server's databases; each expands to its own schemas.
        const dbs = await getDbDatabases(nav.token, conn.id);
        setChildren(dbs.map((d) => buildDatabaseNode(nav.token, conn.id, ctx, d.name)));
      } else {
        // Default: the connection's stored database, schemas directly under the connection.
        setChildren(await buildSchemaNodes(nav.token, conn.id, ctx));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : showAll ? "Failed to load databases" : "Failed to load schemas");
      setChildren([]);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, nav.token, showAll]);

  // Toggling "Show all databases" invalidates the cached subtree; drop it and refetch if open.
  useEffect(() => {
    setChildren(null);
    if (expanded) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  // Reconnect / schema-rename bump this key: drop cached metadata and re-establish the subtree so a
  // stale or closed connection is re-opened. Skip the first run (mount) so nothing loads unbidden.
  const reloadKey = nav.reloadKeys[conn.id] ?? 0;
  const firstReloadRef = useRef(true);
  useEffect(() => {
    if (firstReloadRef.current) {
      firstReloadRef.current = false;
      return;
    }
    setChildren(null);
    setExpanded(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

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
    // Reconnect: re-probe the stored credentials (updates the status dot) and rebuild the subtree.
    { label: "Reconnect", onClick: () => { nav.testConnection(conn.id); refresh(); } },
    { label: "Test connection", onClick: () => nav.testConnection(conn.id) },
    { label: showAll ? "Show only default database" : "Show all databases", onClick: () => nav.toggleShowAllDb(conn.id) },
    { label: "Refresh", onClick: refresh },
    // Backup/restore are postgres-only (pg_dump/pg_restore); hide them for other engines.
    ...(conn.engine === "postgres"
      ? [
          { label: "Backup", onClick: () => nav.backupConnection(conn.id, conn.database) },
          { label: "Restore", danger: true, onClick: () => nav.restoreConnection(conn.id, conn.database) }
        ]
      : []),
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
            <div className="py-1 pl-6 text-xs italic text-muted">{showAll ? "(no databases)" : "(no schemas)"}</div>
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
  const [engine, setEngine] = useState<DbConnEngine>(editing?.engine ?? "postgres");
  const [host, setHost] = useState(editing?.host ?? "");
  const [port, setPort] = useState<number>(editing?.port ?? DEFAULT_PORTS.postgres);
  const [username, setUsername] = useState(editing?.username ?? "");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(editing?.database ?? "");
  const [environment, setEnvironment] = useState(editing?.environment ?? "");
  const [group, setGroup] = useState(editing?.group ?? "");
  const [showAllDatabases, setShowAllDatabases] = useState<boolean>(editing?.show_all_databases ?? false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [error, setError] = useState("");

  const isSqlite = engine === "sqlite";

  function changeEngine(next: DbConnEngine) {
    setPort((current) => (current === DEFAULT_PORTS[engine] ? DEFAULT_PORTS[next] : current));
    setEngine(next);
    setNote(null);
  }

  function input(): DbConnectionInput {
    // SQLite is file-backed: `database` is the file path and host/port/username are unused.
    if (engine === "sqlite") {
      return {
        name: name.trim(),
        engine,
        host: "",
        port: 0,
        username: "",
        database: database.trim(),
        environment: environment || "",
        group: group.trim() ? group.trim() : null,
        show_all_databases: showAllDatabases
      };
    }
    return {
      name: name.trim(),
      engine,
      host: host.trim(),
      port: Number(port) || DEFAULT_PORTS[engine],
      username,
      database: database.trim(),
      environment: environment || "",
      group: group.trim() ? group.trim() : null,
      show_all_databases: showAllDatabases
    };
  }

  // Whether the form has enough to save/test: sqlite needs a file path, others need a host.
  const hasTarget = isSqlite ? database.trim().length > 0 : host.trim().length > 0;

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
          <select value={engine} onChange={(e) => changeEngine(e.target.value as DbConnEngine)} className={inputClass}>
            <option value="postgres">PostgreSQL</option>
            <option value="mysql">MySQL</option>
            <option value="mssql">SQL Server</option>
            <option value="sqlite">SQLite</option>
          </select>
        </label>
        {isSqlite ? (
          <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted md:col-span-2">
            Database file path
            <input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              placeholder="/var/lib/app/data.db"
              spellCheck={false}
              className={inputClass}
            />
          </label>
        ) : (
          <>
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
          </>
        )}
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
        {!isSqlite && (
          <label className="flex items-center gap-2.5 md:col-span-2">
            <input
              type="checkbox"
              checked={showAllDatabases}
              onChange={(e) => setShowAllDatabases(e.target.checked)}
              className="h-4 w-4 shrink-0 rounded border-edge text-accent focus:ring-accent"
            />
            <span className="text-sm font-medium text-fg">
              Show all databases
              <span className="ml-1.5 font-normal text-muted">— browse every database on the server, not just the default</span>
            </span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <button
            type="submit"
            disabled={saving || !name.trim() || !hasTarget}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            {editing ? "Save changes" : "Save connection"}
          </button>
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || !hasTarget}
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

  const [filter, setFilter] = useState("");
  const [showAllDb, setShowAllDb] = useState<Record<string, boolean>>({});
  const toggleShowAllDb = useCallback((id: string) => {
    setShowAllDb((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Bumped per-connection to force a connection node to drop its cached metadata and reconnect.
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({});
  const reloadConnection = useCallback((id: string) => {
    setReloadKeys((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }, []);

  // Transient status toast for backup/restore/rename results (success + failure).
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const showNotice = useCallback((kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 5000);
  }, []);

  // Hidden file input drives the restore flow: an action stashes its target here, then clicks it.
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const restoreTargetRef = useRef<{ connId: string; database?: string } | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      const conns = await getDbConnections(token);
      setConnections(conns);
      // Seed each connection's "Show all databases" navigator state from its persisted default,
      // without clobbering any explicit in-session toggle the user has already made.
      setShowAllDb((prev) => {
        const next = { ...prev };
        for (const c of conns) if (!(c.id in next)) next[c.id] = c.show_all_databases;
        return next;
      });
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

  const backupConnection = useCallback(
    async (connId: string, database?: string) => {
      showNotice("ok", "Preparing backup…");
      try {
        await backupDbConnection(token, connId, database);
        showNotice("ok", "Backup downloaded.");
      } catch (e) {
        showNotice("error", e instanceof Error ? e.message : "Backup failed");
      }
    },
    [token, showNotice]
  );

  // Opening the restore picker: stash the target, then click the hidden input. The upload happens in
  // onRestoreFile once a file is chosen (and confirmed).
  const restoreConnection = useCallback((connId: string, database?: string) => {
    restoreTargetRef.current = { connId, database };
    restoreInputRef.current?.click();
  }, []);

  const onRestoreFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so picking the same file twice still fires a change event next time.
      event.target.value = "";
      const target = restoreTargetRef.current;
      restoreTargetRef.current = null;
      if (!file || !target) return;
      const label = target.database ? ` "${target.database}"` : "";
      if (
        !(await confirm({
          title: "Restore database?",
          message: `This OVERWRITES the current contents of${label || " the database"} with the uploaded dump. This cannot be undone.`,
          confirmLabel: "Restore",
          danger: true
        }))
      )
        return;
      showNotice("ok", "Restoring…");
      try {
        const res = await restoreDbConnection(token, target.connId, file, target.database);
        showNotice(res.ok ? "ok" : "error", res.message || (res.ok ? "Restore complete." : "Restore failed"));
        if (res.ok) reloadConnection(target.connId);
      } catch (e) {
        showNotice("error", e instanceof Error ? e.message : "Restore failed");
      }
    },
    [confirm, token, showNotice, reloadConnection]
  );

  const renameSchema = useCallback(
    async (connId: string, schema: string) => {
      const next = window.prompt(`Rename schema "${schema}" to:`, schema);
      if (next === null) return;
      const trimmed = next.trim();
      if (!trimmed || trimmed === schema) return;
      try {
        const res = await renameDbSchema(token, connId, schema, trimmed);
        showNotice(res.ok ? "ok" : "error", res.message || (res.ok ? "Schema renamed." : "Rename failed"));
        if (res.ok) reloadConnection(connId);
      } catch (e) {
        showNotice("error", e instanceof Error ? e.message : "Rename failed");
      }
    },
    [token, showNotice, reloadConnection]
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
      backupConnection,
      restoreConnection,
      renameSchema,
      reloadKeys,
      reloadConnection,
      openMenuId,
      menuAnchor,
      openMenu: (id, x, y) => {
        setMenuAnchor({ x, y });
        setOpenMenuId(id);
      },
      closeMenu: () => setOpenMenuId(null),
      filter,
      showAllDb,
      toggleShowAllDb
    }),
    [
      token,
      onOpenEditor,
      onViewData,
      onGenerate,
      statuses,
      testConnection,
      openConnDialog,
      deleteConnection,
      backupConnection,
      restoreConnection,
      renameSchema,
      reloadKeys,
      reloadConnection,
      openMenuId,
      menuAnchor,
      filter,
      showAllDb,
      toggleShowAllDb
    ]
  );

  return (
    <NavContext.Provider value={navValue}>
      {confirmDialog}
      {/* hidden picker for the postgres restore flow */}
      <input
        ref={restoreInputRef}
        type="file"
        accept=".sql,.dump,.tar,.gz,.backup"
        className="hidden"
        onChange={onRestoreFile}
      />
      {notice && (
        <div
          className={`fixed bottom-4 left-1/2 z-[97] flex max-w-md -translate-x-1/2 items-start gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-xl ring-1 ${
            notice.kind === "ok" ? "bg-elevated text-fg ring-edge" : "bg-danger/10 text-danger ring-danger/40"
          }`}
        >
          {notice.kind === "ok" ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-500" />
          ) : (
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          )}
          <span className="break-words">{notice.text}</span>
        </div>
      )}
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

        <div className="border-b border-edge px-2 py-2">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tables, views, routines…"
              spellCheck={false}
              className="h-8 w-full rounded-lg bg-surface pl-7 pr-2 text-xs text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent"
            />
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
