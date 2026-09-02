export type Summary = {
  server_count: number;
  healthy_servers: number;
  warning_servers: number;
  critical_servers: number;
  offline_servers: number;
  // servers never discovered or probed. The four buckets above exclude these, so without it
  // they add up to less than server_count and the dashboard's numbers do not reconcile.
  unknown_servers: number;
  // hosts with a container runtime, not a count of containers
  total_containers: number;
  databases: number;
  running_services: number;
  // averaged over measured_servers only
  average_health_score: number;
  measured_servers: number;
};

export type TomcatLogFile = {
  name: string;
  path: string;
  size_bytes: string;
  modified: string;
};

export type TomcatWebapp = {
  name: string;
  path: string;
  // war | dir
  type: string;
  // Discovery emits shell-parsed strings today; a Pydantic int would serialise as a
  // number. Accept both so the UI does not break on either shape.
  size_bytes: string | number;
  modified: string;
};

export type TomcatPrerequisiteStatus = "ok" | "missing" | "unsupported" | "unknown";

export type TomcatPrerequisite = {
  name: string;
  required: string;
  detected: string;
  status: TomcatPrerequisiteStatus | string;
};

export type TomcatInstance = {
  name: string;
  unit: string;
  source: string;
  status: string;
  enabled: string;
  pid: string;
  catalina_base: string;
  catalina_home: string;
  log_dir: string;
  version: string;
  java: string;
  ports: string;
  log_files: TomcatLogFile[];
  server_number: string;
  jvm_version: string;
  jvm_vendor: string;
  os_name: string;
  java_home: string;
  configured_log_dir: string;
  configured_log_prefix: string;
  primary_log_file: string;
  webapps: TomcatWebapp[];
  prerequisites: TomcatPrerequisite[];
};

export type Server = {
  id: string;
  hostname: string;
  alias: string;
  ip_address: string;
  ssh_port: number;
  username: string;
  environment: string;
  server_type: string;
  operating_system: string;
  kernel: string;
  // hardware facts from discovery; cpu is the core count as reported by nproc
  cpu: string;
  ram_mb: number;
  disk_gb: number;
  architecture: string;
  docker_version: string;
  podman_version: string;
  os_family: string;
  // "linux" | "windows" -- selects the probe set and enables the Remote Desktop button.
  os_kind: string;
  os_distro: string;
  os_version: string;
  package_manager: string;
  status: string;
  health_score: number;
  business_owner: string;
  support_contact: string;
  tags: string[];
  installed_services: string[];
  discovered_services: Array<Record<string, string>>;
  storage: Array<Record<string, string>>;
  database_logs: Array<Record<string, string>>;
  tomcat: TomcatInstance[];
  has_credentials: boolean;
  last_discovery: string | null;
  // vitals as of vitals_checked_at. cpu_percent is -1 when never sampled, which is not 0%.
  uptime_seconds: number;
  load_average: string;
  cpu_percent: number;
  ram_used_mb: number;
  process_count: number;
  vitals_checked_at: string | null;
  // EXPERIMENTAL (feature/server-folders): the public_id of the folder this server sits in, or
  // "" when unassigned. Matched against Folder.id to bucket rows under folder headers.
  folder_id: string;
};

// EXPERIMENTAL (feature/server-folders): a flat, optional grouping over servers ("BH", "MH",
// "EMS"). `id` is the folder's public_id (a uuid string), never a numeric id -- the whole API
// speaks in public_ids. server_count is computed server-side per request.
export type Folder = {
  id: string;
  name: string;
  server_count: number;   // servers assigned DIRECTLY to this group
  parent_id: string;      // parent group's id, or "" for a top-level group
  child_count: number;    // number of direct sub-groups
};

export type PrivilegedResult = {
  ok: boolean;
  message: string;
  needs_sudo_password: boolean;
  output: string;
};

export type ServerImportRow = {
  row: number;
  hostname: string;
  status: string;
  message: string;
  // public_id of a created server (empty otherwise); has_credentials gates auto-discovery,
  // since a credential-less server cannot be discovered
  server_id: string;
  has_credentials: boolean;
};

export type ServerImportResult = {
  dry_run: boolean;
  total: number;
  created: number;
  skipped: number;
  failed: number;
  rows: ServerImportRow[];
};

export type CredentialPayload = {
  password?: string;
  private_key?: string;
  tail?: number;
};

export type TomcatLogPayload = {
  instance: string;
  log_file: string;
  tail?: number;
};

export type TomcatActionPayload = {
  instance: string;
  action?: string;
  sudo_password?: string;
};

export type WarDeployResult = {
  ok: boolean;
  message: string;
  target_path: string;
  backup_path: string;
  bytes_written: number;
  restarted: boolean;
  needs_sudo_password: boolean;
};

export type WarDeployForm = {
  instance: string;
  file: File;
  filename?: string;
  restart?: boolean;
  sudo_password?: string;
};

export type ContainerInfo = {
  runtime: string;
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  // Externally reachable published host ports; each becomes an "open in browser"
  // link http://<server-ip>:<port>. Optional for backward compatibility.
  host_ports?: number[];
};

export type ImageInfo = {
  runtime: string;
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
};

export type Integration = {
  name: string;
  url: string;
  status: string;
};

export type Me = {
  email: string;
  full_name: string;
  role: "admin" | "developer" | "support" | string;
  using_default_password: boolean;
  // desktop guest session (no login). The UI shows a "Guest" state and a Sign-in affordance.
  guest?: boolean;
  // effective sidebar menu-item keys for this caller's role, from the role->menu matrix. The
  // sidebar renders from this rather than hardcoded role checks; absent/empty means "fall back
  // to the built-in per-role defaults" (see sidebar.tsx).
  menus?: string[];
};

// The role x menu-item matrix for the Access Control editor. `roles` and `items` are the full
// vocabularies (grid axes); `menus` holds the currently-saved selection per role.
export type RoleMenus = {
  roles: string[];
  items: string[];
  menus: Record<string, string[]>;
};

export type UserAccount = {
  id: number;
  email: string;
  full_name: string;
  role: string;
  created_at: string;
};

export type AccessPolicy = {
  id: number;
  name: string;
  description: string;
  environments: string[];
  server_types: string[];
  tags: string[];
  server_ids: string[];
  assigned_user_ids: number[];
};

export type OptionList = {
  environments: string[];
  server_types: string[];
  application_types: string[];
};

// Vault secrets backend config. The token is write-only: the API never echoes it back, so the
// read shape carries a `token_set` boolean instead of the value. On save, an empty `token` keeps
// whatever is already stored (the UI never re-shows the token, so a blank box means "unchanged").
export type VaultConfig = {
  enabled: boolean;
  address: string;
  kv_mount: string;
  path_prefix: string;
  token_set: boolean;
};

export type VaultConfigWrite = {
  enabled: boolean;
  address: string;
  kv_mount: string;
  path_prefix: string;
  // omit or leave empty to keep the stored token; a non-empty value replaces it
  token?: string;
};

export type VaultTestResult = {
  ok: boolean;
  message: string;
};

export type SftpEntryType = "file" | "dir" | "link";

export type SftpEntry = {
  name: string;
  path: string;
  // Widened the same way as TomcatPrerequisiteStatus: the union documents what the
  // backend emits without making an unexpected value a type error at the call site.
  type: SftpEntryType | string;
  // The SFTP layer emits shell-ish formatted strings while a Pydantic int would
  // serialise as a number. Accept both, exactly as TomcatWebapp does.
  size_bytes: string | number;
  modified: string;
  // Unix mtime as a JSON number (the schema types it `int`, and coerce_numbers_to_str only
  // affects `str` fields). Sort on this, never on the formatted `modified` string, which
  // orders wrongly as text. 0 means the host reported no usable mtime.
  modified_epoch: number;
  mode: string;
};

export type SftpListing = {
  path: string;
  parent: string;
  entries: SftpEntry[];
  // true when the backend hit its 2000-entry cap; the UI must say so rather than
  // present a partial directory as complete.
  truncated: boolean;
};

export type SftpUploadResult = {
  ok: boolean;
  message: string;
  path: string;
  bytes_written: number;
};

// What was removed. `link` matters to the caller: deleting a symlink unlinks the link and
// leaves its target alone, so the confirmation copy differs from a real directory delete.
export type SftpDeleteKind = "file" | "dir" | "link";

// Normalised shape handed to callers -- every field is present, so the UI never has to
// guard for undefined. sftpDelete() fills in anything the backend omits; see the wire type
// below for why that indirection exists.
export type SftpDeleteResult = {
  ok: boolean;
  path: string;
  // Widened like SftpEntryType: the union documents the expected values without making an
  // unexpected one a type error.
  deleted: SftpDeleteKind | string;
  entries_removed: number;
  message: string;
};

// The over-the-wire shape, all-optional. The service layer returns only
// {path, deleted, entries_removed}; the response model wraps that with ok/message, and
// `entries_removed` arrives as a string if it lands in a model with
// coerce_numbers_to_str set (as SftpEntry does). Parsing defensively here keeps a
// harmless naming or type difference from turning into a runtime crash in the file pane.
type SftpDeleteWire = {
  ok?: boolean;
  path?: string;
  deleted?: string;
  entries_removed?: number | string;
  message?: string;
};

export type ShellFavorite = {
  id: number;
  name: string;
  command: string;
  created_at: string;
};

// Carries the HTTP status alongside the body text. Callers that need to distinguish a 413
// from a 403 -- the SFTP pane shows a different remedy for each -- would otherwise have to
// pattern-match the response body, which silently misclassifies the moment a `detail`
// string is reworded.
//
// `message` is the human-readable reason: FastAPI errors arrive as `{"detail": "..."}` (or a
// validation array), so we unwrap that for display instead of showing the caller the raw JSON.
// The unparsed `body` is kept for anything that still needs it; `status` stays the way to
// classify an error.
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(ApiError.humanMessage(status, body));
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  private static humanMessage(status: number, body: string): string {
    const text = (body ?? "").trim();
    if (!text) return `Request failed with status ${status}`;
    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.detail;
      if (typeof detail === "string" && detail.trim()) return detail;
      // FastAPI request-validation errors put an array of {msg, loc} in `detail`.
      if (Array.isArray(detail)) {
        const msgs = detail.map((d) => (d && typeof d.msg === "string" ? d.msg : "")).filter(Boolean);
        if (msgs.length) return msgs.join("; ");
      }
      if (typeof parsed?.message === "string" && parsed.message.trim()) return parsed.message;
    } catch {
      // not JSON — the body is already a plain string, fall through
    }
    return text;
  }
}

// Relative by default: the static export is served same-origin by FastAPI, so the UI
// works on localhost, a LAN IP, or a hostname with no rebuild. The env override stays
// for anyone fronting the API separately.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json();
}

// Multipart sibling of request<T>. Deliberately separate rather than a flag on request<T>:
// a FormData body must NOT carry a hand-written Content-Type. The browser generates the
// multipart boundary and puts it in the header itself, so setting the header here (or
// letting request<T>'s "application/json" through) sends a boundary-less content type and
// the server fails to parse the body.
async function upload<T>(path: string, token: string, body: FormData): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
  return response.json();
}

export async function login(email: string, password: string): Promise<string> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error("Invalid login");
  const data = await response.json();
  return data.access_token;
}

export async function getMe(token: string): Promise<Me> {
  return request<Me>("/auth/me", token);
}

// --- Keycloak OIDC (additive; off unless the backend enables it) ----------------------------
// Unauthenticated status probe, mirroring login()'s tokenless fetch against API_URL. Any failure
// (endpoint absent, network error, non-2xx, bad JSON) is swallowed to { enabled: false } so the
// "Sign in with Keycloak" button simply never appears rather than breaking the login screen.
export async function getOidcStatus(): Promise<{ enabled: boolean; local_login: boolean }> {
  // Safe default is local_login:true so a failed probe (or an older backend) still shows the local
  // form rather than locking the operator out. enabled:false hides the Keycloak button.
  try {
    const response = await fetch(`${API_URL}/auth/oidc/status`, { cache: "no-store" });
    if (!response.ok) return { enabled: false, local_login: true };
    const data = await response.json();
    return { enabled: Boolean(data?.enabled), local_login: data?.local_login !== false };
  } catch {
    return { enabled: false, local_login: true };
  }
}

// The URL to send the browser to (full-page navigation, NOT fetch) to start the Keycloak flow.
// Same API_URL base every other call uses, so it works same-origin or behind the env override.
export function oidcLoginUrl(): string {
  return `${API_URL}/auth/oidc/login`;
}

// Full-page navigation target that ends BOTH the app session and the Keycloak SSO session
// (RP-initiated logout), then returns to the app. Navigating here (not fetch) is the point.
export function oidcLogoutUrl(): string {
  return `${API_URL}/auth/oidc/logout`;
}

export async function changePassword(token: string, currentPassword: string, newPassword: string): Promise<{ ok: boolean; message: string }> {
  return request("/auth/change-password", token, {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  });
}

// Update the signed-in account's display name. Returns the refreshed Me (so callers can
// re-render the header/profile). Not available to guests (403).
export async function updateProfile(token: string, fullName: string): Promise<Me> {
  return request<Me>("/auth/profile", token, { method: "PATCH", body: JSON.stringify({ full_name: fullName }) });
}

export async function getUsers(token: string): Promise<UserAccount[]> {
  return request<UserAccount[]>("/users", token);
}

export async function getOptions(token: string): Promise<OptionList> {
  return request<OptionList>("/settings/options", token);
}

export async function addEnvironment(token: string, value: string): Promise<OptionList> {
  return request<OptionList>("/settings/environments", token, { method: "POST", body: JSON.stringify({ value }) });
}

export async function addServerType(token: string, value: string): Promise<OptionList> {
  return request<OptionList>("/settings/server-types", token, { method: "POST", body: JSON.stringify({ value }) });
}

export async function addApplicationType(token: string, value: string): Promise<OptionList> {
  return request<OptionList>("/settings/application-types", token, { method: "POST", body: JSON.stringify({ value }) });
}

export async function removeEnvironment(token: string, value: string): Promise<OptionList> {
  return request<OptionList>(`/settings/environments/${encodeURIComponent(value)}`, token, { method: "DELETE" });
}

export async function removeServerType(token: string, value: string): Promise<OptionList> {
  return request<OptionList>(`/settings/server-types/${encodeURIComponent(value)}`, token, { method: "DELETE" });
}

export async function removeApplicationType(token: string, value: string): Promise<OptionList> {
  return request<OptionList>(`/settings/application-types/${encodeURIComponent(value)}`, token, { method: "DELETE" });
}

// --- Vault secrets backend (feature/vault-secrets) -----------------------------------------
// Admin-only (require_admin_not_guest on the backend). getVaultConfig never carries the token;
// saveVaultConfig only replaces the token when a non-empty one is supplied; testVault probes
// connectivity/auth with the form's values (falling back to the stored token when the box is
// left blank) without persisting anything.

export async function getVaultConfig(token: string): Promise<VaultConfig> {
  return request<VaultConfig>("/settings/vault", token);
}

export async function saveVaultConfig(token: string, payload: VaultConfigWrite): Promise<VaultConfig> {
  return request<VaultConfig>("/settings/vault", token, { method: "PUT", body: JSON.stringify(payload) });
}

export async function testVault(token: string, payload: VaultConfigWrite): Promise<VaultTestResult> {
  return request<VaultTestResult>("/settings/vault/test", token, { method: "POST", body: JSON.stringify(payload) });
}

// --- app database backend switch (feature/app-db-backend) ----------------------------------
// Admin-only (require_admin_not_guest). Switches Infra Monitor's OWN backing database from the
// built-in SQLite to an external PostgreSQL/MySQL. migrate COPIES all data across and writes an
// override the app reads on its NEXT start; nothing swaps live. The password is only ever sent
// (never returned): getAppDatabase reports the active backend with the password masked.

export type AppDbConfig = {
  // "SQLite" | "PostgreSQL" | "MySQL"
  backend: string;
  url_masked: string;
  // true when an override file is in force (i.e. running on a migrated external DB)
  is_override: boolean;
};

export type AppDbConnectionRequest = {
  engine: "postgres" | "mysql";
  host: string;
  port?: number | null;
  username: string;
  password: string;
  database: string;
};

export type AppDbTestResult = {
  ok: boolean;
  message: string;
};

export type AppDbMigrateResult = {
  ok: boolean;
  message: string;
  tables: Record<string, number>;
  restart_required: boolean;
};

export async function getAppDatabase(token: string): Promise<AppDbConfig> {
  return request<AppDbConfig>("/settings/database", token);
}

export async function testAppDatabase(token: string, payload: AppDbConnectionRequest): Promise<AppDbTestResult> {
  return request<AppDbTestResult>("/settings/database/test", token, { method: "POST", body: JSON.stringify(payload) });
}

export async function migrateAppDatabase(token: string, payload: AppDbConnectionRequest): Promise<AppDbMigrateResult> {
  return request<AppDbMigrateResult>("/settings/database/migrate", token, { method: "POST", body: JSON.stringify(payload) });
}

// Point at an existing database without copying anything (target already has the data).
export async function useAppDatabase(token: string, payload: AppDbConnectionRequest): Promise<AppDbMigrateResult> {
  return request<AppDbMigrateResult>("/settings/database/use", token, { method: "POST", body: JSON.stringify(payload) });
}

export async function resetAppDatabase(token: string): Promise<AppDbMigrateResult> {
  return request<AppDbMigrateResult>("/settings/database/reset", token, { method: "POST", body: JSON.stringify({}) });
}

export async function createUser(token: string, payload: unknown): Promise<UserAccount> {
  return request<UserAccount>("/users", token, { method: "POST", body: JSON.stringify(payload) });
}

export async function deleteUser(token: string, userId: number): Promise<void> {
  const response = await fetch(`${API_URL}/users/${userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
}

export async function getUserServerAccess(token: string, userId: number): Promise<{ user_id: number; server_ids: string[] }> {
  return request(`/users/${userId}/server-access`, token);
}

export async function updateUserServerAccess(token: string, userId: number, serverIds: string[]): Promise<{ user_id: number; server_ids: string[] }> {
  return request(`/users/${userId}/server-access`, token, { method: "PUT", body: JSON.stringify({ server_ids: serverIds }) });
}

export async function getPolicies(token: string): Promise<AccessPolicy[]> {
  return request<AccessPolicy[]>("/policies", token);
}

export async function createPolicy(token: string, payload: unknown): Promise<AccessPolicy> {
  return request<AccessPolicy>("/policies", token, { method: "POST", body: JSON.stringify(payload) });
}

export async function assignPolicyUsers(token: string, policyId: number, userIds: number[]): Promise<AccessPolicy> {
  return request<AccessPolicy>(`/policies/${policyId}/users`, token, { method: "PUT", body: JSON.stringify({ user_ids: userIds }) });
}

// Reads the role->menu matrix. require_user, so any signed-in caller (and the desktop guest)
// may read it; the Access Control editor fetches the full grid, individual pages do not need to.
export async function getRoleMenus(token: string): Promise<RoleMenus> {
  return request<RoleMenus>("/settings/role-menus", token);
}

// Saves the matrix. Admin-only (require_admin_not_guest): a desktop guest gets 403. A role
// omitted from `menus` is reset to its default row server-side.
export async function updateRoleMenus(token: string, menus: Record<string, string[]>): Promise<RoleMenus> {
  return request<RoleMenus>("/settings/role-menus", token, { method: "PUT", body: JSON.stringify({ menus }) });
}

export async function getSummary(token: string): Promise<Summary> {
  return request<Summary>("/dashboard/summary", token);
}

export async function getServers(token: string): Promise<Server[]> {
  return request<Server[]>("/servers", token);
}

export async function getServer(token: string, id: string): Promise<Server> {
  return request<Server>(`/servers/${id}`, token);
}

export async function getIntegrations(token: string): Promise<Integration[]> {
  return request<Integration[]>("/integrations", token);
}

// --- folders (EXPERIMENTAL: feature/server-folders) ---------------------------------------
// Reads follow the inventory's require_user rule; create/rename/delete/assign are admin-only
// and come back 403 for anyone else. A duplicate folder name (case-insensitive) is a 409,
// which request<T> surfaces as an ApiError carrying the body text.

export async function getFolders(token: string): Promise<Folder[]> {
  return request<Folder[]>("/folders", token);
}

export async function createFolder(token: string, name: string, parentId?: string | null): Promise<Folder> {
  return request<Folder>("/folders", token, { method: "POST", body: JSON.stringify({ name, parent_id: parentId ?? null }) });
}

export async function renameFolder(token: string, folderId: string, name: string): Promise<Folder> {
  return request<Folder>(`/folders/${encodeURIComponent(folderId)}`, token, { method: "PATCH", body: JSON.stringify({ name }) });
}

// Move a group under a new parent (parentId=null moves it to the top level).
export async function moveFolder(token: string, folderId: string, parentId: string | null): Promise<Folder> {
  return request<Folder>(`/folders/${encodeURIComponent(folderId)}`, token, { method: "PATCH", body: JSON.stringify({ parent_id: parentId }) });
}

export async function deleteFolder(token: string, folderId: string): Promise<void> {
  // 204 No Content, so request<T> is wrong here: response.json() throws on an empty body.
  const response = await fetch(`${API_URL}/folders/${encodeURIComponent(folderId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
}

// Passing null (or "") unassigns the server; a folder public_id assigns it. Returns the
// updated server so the caller can patch it into local state without a full reload.
export async function assignServerFolder(token: string, serverId: string, folderId: string | null): Promise<Server> {
  return request<Server>(`/servers/${encodeURIComponent(serverId)}/folder`, token, {
    method: "PUT",
    body: JSON.stringify({ folder_id: folderId })
  });
}

export async function addServer(token: string, payload: unknown): Promise<Server> {
  return request<Server>("/servers", token, { method: "POST", body: JSON.stringify(payload) });
}

// Partial edit of a server's metadata (rename, re-tag, fix an IP). Send only the fields that
// changed; the backend PATCH leaves omitted fields untouched. A bad IP comes back 400 and an
// hostname/IP clash with another server comes back 409, both surfaced as ApiError.
export type ServerUpdate = Partial<{
  hostname: string;
  alias: string;
  ip_address: string;
  username: string;
  ssh_port: number;
  environment: string;
  server_type: string;
  tags: string[];
  business_owner: string;
  support_contact: string;
  os_kind: string;
}>;

export async function updateServer(token: string, serverId: string, payload: ServerUpdate): Promise<Server> {
  return request<Server>(`/servers/${encodeURIComponent(serverId)}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export async function deleteServer(token: string, serverId: string): Promise<void> {
  await fetch(`${API_URL}/servers/${serverId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  }).then(async (response) => {
    if (!response.ok) throw new ApiError(response.status, await response.text());
  });
}

export async function testConnection(token: string, serverId: string, credentials: unknown): Promise<{ ok: boolean; message: string }> {
  return request(`/servers/${serverId}/test-connection`, token, { method: "POST", body: JSON.stringify(credentials) });
}

export async function discoverServer(token: string, serverId: string, credentials: unknown): Promise<{ ok: boolean; message: string }> {
  return request(`/servers/${serverId}/discover`, token, { method: "POST", body: JSON.stringify(credentials) });
}

export async function saveCredentials(token: string, serverId: string, credentials: unknown): Promise<{ ok: boolean; message: string }> {
  return request(`/servers/${serverId}/credentials`, token, { method: "PUT", body: JSON.stringify(credentials) });
}

export async function getContainers(token: string, serverId: string, runtime: string, credentials: unknown): Promise<ContainerInfo[]> {
  return request<ContainerInfo[]>(`/servers/${serverId}/containers/${runtime}`, token, { method: "POST", body: JSON.stringify(credentials) });
}

export async function getImages(token: string, serverId: string, runtime: string, credentials: unknown): Promise<ImageInfo[]> {
  return request<ImageInfo[]>(`/servers/${serverId}/images/${runtime}`, token, { method: "POST", body: JSON.stringify(credentials) });
}

export async function getContainerLogs(token: string, serverId: string, runtime: string, container: string, credentials: unknown): Promise<string[]> {
  const data = await request<{ lines: string[] }>(`/servers/${serverId}/logs/${runtime}/${encodeURIComponent(container)}`, token, {
    method: "POST",
    body: JSON.stringify(credentials)
  });
  return data.lines;
}

// Reads the container's .env file (checking the usual app working dirs), falling back to the
// container's live runtime environment when no file is found. Returns the lines to display.
export async function getContainerEnv(token: string, serverId: string, runtime: string, container: string, credentials: unknown): Promise<string[]> {
  const data = await request<{ lines: string[] }>(`/servers/${serverId}/containers/${runtime}/${encodeURIComponent(container)}/env`, token, {
    method: "POST",
    body: JSON.stringify(credentials)
  });
  return data.lines;
}

export async function getServiceLogs(token: string, serverId: string, payload: unknown): Promise<string[]> {
  const data = await request<{ lines: string[] }>(`/servers/${serverId}/logs/service`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return data.lines;
}

export async function restartContainer(token: string, serverId: string, payload: unknown): Promise<{ ok: boolean; message: string }> {
  return request(`/servers/${serverId}/container-restart`, token, { method: "POST", body: JSON.stringify(payload) });
}

export async function removeContainer(token: string, serverId: string, payload: unknown): Promise<{ ok: boolean; message: string }> {
  return request(`/servers/${serverId}/container-remove`, token, { method: "POST", body: JSON.stringify(payload) });
}

export async function removeImage(token: string, serverId: string, payload: unknown): Promise<{ ok: boolean; message: string }> {
  return request(`/servers/${serverId}/image-remove`, token, { method: "POST", body: JSON.stringify(payload) });
}

export async function restartService(token: string, serverId: string, name: string, sudoPassword = ""): Promise<PrivilegedResult> {
  return request<PrivilegedResult>(`/servers/${serverId}/services/restart`, token, {
    method: "POST",
    body: JSON.stringify({ name, sudo_password: sudoPassword })
  });
}

export async function getTomcatInstances(token: string, serverId: string, credentials: CredentialPayload): Promise<TomcatInstance[]> {
  return request<TomcatInstance[]>(`/servers/${serverId}/tomcat`, token, { method: "POST", body: JSON.stringify(credentials) });
}

export async function getTomcatLogs(token: string, serverId: string, payload: TomcatLogPayload): Promise<string[]> {
  const data = await request<{ lines: string[] }>(`/servers/${serverId}/tomcat/logs`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  return data.lines;
}

export async function tomcatAction(token: string, serverId: string, payload: TomcatActionPayload): Promise<PrivilegedResult> {
  return request<PrivilegedResult>(`/servers/${serverId}/tomcat/action`, token, { method: "POST", body: JSON.stringify(payload) });
}

export async function deployWar(token: string, serverId: string, form: WarDeployForm): Promise<WarDeployResult> {
  const body = new FormData();
  body.append("instance", form.instance);
  // Third argument sets the part filename. The backend prefers the explicit `filename`
  // field but falls back to the upload's own name, so keep the two consistent.
  body.append("file", form.file, form.filename || form.file.name);
  if (form.filename) body.append("filename", form.filename);
  body.append("restart", form.restart ? "true" : "false");
  if (form.sudo_password) body.append("sudo_password", form.sudo_password);
  return upload<WarDeployResult>(`/servers/${serverId}/tomcat/deploy`, token, body);
}

export async function importServers(token: string, csvText: string, dryRun: boolean): Promise<ServerImportResult> {
  return request<ServerImportResult>("/servers/import", token, {
    method: "POST",
    body: JSON.stringify({ csv_text: csvText, dry_run: dryRun })
  });
}

export async function refreshVitals(token: string, serverId: string): Promise<Server> {
  return request<Server>(`/servers/${serverId}/vitals`, token, { method: "POST" });
}

// Websockets cannot carry an Authorization header, so the token goes in the first frame
// (see shellHandshake) rather than the URL, which would land in access logs.
export function shellSocketUrl(serverId: string): string {
  const base = API_URL.startsWith("http")
    ? API_URL
    : `${window.location.origin}${API_URL.startsWith("/") ? "" : "/"}${API_URL}`;
  return `${base.replace(/^http/, "ws")}/servers/${encodeURIComponent(serverId)}/shell`;
}

export function shellHandshake(token: string, cols: number, rows: number): string {
  return JSON.stringify({ token, cols, rows });
}

export async function sftpList(token: string, serverId: string, path = ""): Promise<SftpListing> {
  // An empty path means "the SSH user's home"; the backend resolves it over SFTP rather
  // than guessing /home/<user>, so do not substitute a default here.
  return request<SftpListing>(`/servers/${encodeURIComponent(serverId)}/sftp/list`, token, {
    method: "POST",
    body: JSON.stringify({ path })
  });
}

export async function sftpUpload(token: string, serverId: string, targetDir: string, file: File): Promise<SftpUploadResult> {
  const body = new FormData();
  body.append("path", targetDir);
  // Third argument sets the part filename, which is what the backend writes into the
  // target directory.
  body.append("file", file, file.name);
  return upload<SftpUploadResult>(`/servers/${encodeURIComponent(serverId)}/sftp/upload`, token, body);
}

// Destructive: this is the only call in the client that removes data from a managed host.
// `recursive` is opt-in and the backend rejects a directory without it, so a caller that
// forgets the flag gets a 400 it can explain rather than a surprise tree delete.
//
// The guard failures (empty path, `/`, a shallow path with recursive=true, NUL bytes) come
// back as 400 with the operator-facing message intact, and request<T> surfaces those as an
// ApiError carrying both status and body -- so the pane can separate "you may not" (403)
// from "that path is refused" (400) without matching on body text.
export async function sftpDelete(
  token: string,
  serverId: string,
  path: string,
  recursive = false
): Promise<SftpDeleteResult> {
  const raw = await request<SftpDeleteWire>(`/servers/${encodeURIComponent(serverId)}/sftp/delete`, token, {
    method: "POST",
    body: JSON.stringify({ path, recursive })
  });
  const entries = Number(raw?.entries_removed);
  return {
    // Absent means success: an HTTP 200 already happened, and an SSH-level failure is
    // signalled by an explicit `ok: false`. Defaulting to false instead would report every
    // successful delete as a failure if the response model happens not to carry the field.
    ok: raw?.ok !== false,
    // Echo the requested path when the response omits it, so the "removed X" message the
    // UI shows is never blank.
    path: typeof raw?.path === "string" && raw.path ? raw.path : path,
    deleted: typeof raw?.deleted === "string" ? raw.deleted : "",
    entries_removed: Number.isFinite(entries) ? entries : 0,
    message: typeof raw?.message === "string" ? raw.message : ""
  };
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  return name || "download";
}

// Content-Disposition is the server's own opinion of the filename and beats a basename
// guess. Handles the RFC 5987 `filename*=UTF-8''...` form first because when both are
// present the extended one carries the non-ASCII characters.
function filenameFromDisposition(header: string | null): string {
  if (!header) return "";
  const extended = /filename\*\s*=\s*(?:UTF-8|ISO-8859-1)?''?([^;]+)/i.exec(header);
  if (extended) {
    const raw = extended[1].trim().replace(/^"|"$/g, "");
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded) return basenameOf(decoded);
    } catch {
      // A malformed percent-escape is not worth failing the download over; fall through
      // to the plain `filename=` form below.
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/i.exec(header);
  if (quoted && quoted[1].trim()) return basenameOf(quoted[1].trim());
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare && bare[1].trim()) return basenameOf(bare[1].trim());
  return "";
}

// Deliberately NOT routed through request<T>: the response body is raw file bytes, so
// response.json() would throw on it. Streams to a Blob and hands it to the browser via a
// temporary object URL.
export async function sftpDownload(token: string, serverId: string, path: string): Promise<void> {
  const response = await fetch(`${API_URL}/servers/${encodeURIComponent(serverId)}/sftp/download`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ path }),
    cache: "no-store"
  });
  // Errors (403 ACL, 413 over max_download_mb, 404) come back as JSON or text, not bytes.
  if (!response.ok) throw new ApiError(response.status, await response.text());

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filenameFromDisposition(response.headers.get("Content-Disposition")) || basenameOf(path);
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    // Must be revoked or the Blob is pinned in memory for the lifetime of the tab, and
    // one leaked copy per download adds up fast on multi-hundred-MB files. Deferred by a
    // macrotask rather than revoked inline: the click starts the download asynchronously
    // in some browsers, and pulling the URL out from under it cancels the transfer.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

// Downloads the whole visible inventory as an .xlsx. Same blob-download shape as sftpDownload,
// and for the same reason: the body is spreadsheet bytes, not JSON.
export async function exportServersXlsx(token: string): Promise<void> {
  const response = await fetch(`${API_URL}/servers/export.xlsx`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filenameFromDisposition(response.headers.get("Content-Disposition")) || "server-inventory.xlsx";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

// --- database console (feature/db-connect) -------------------------------------------------
// A standalone SQL console: the caller supplies connection params + credentials on every call,
// and the backend opens a fresh PostgreSQL/MySQL connection, runs the work, and closes it.
// Nothing is stored. Both endpoints are blocked for desktop guests (403) — sign in to use them.

export type DbEngine = "postgres" | "mysql";

// Stored connections additionally support file-backed SQLite (its `database` field carries a FILE
// PATH; host/port/username/password are unused) and SQL Server (mssql, default port 1433, same
// host/port/user/password shape as postgres). Kept separate from DbEngine so the ad-hoc console,
// which only opens postgres/mysql, is unaffected.
export type DbConnEngine = "postgres" | "mysql" | "sqlite" | "mssql";

export type DbConnectionParams = {
  engine: DbEngine;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
};

export type DbConnectionResult = {
  ok: boolean;
  message: string;
};

export type DbQueryResult = {
  columns: string[];
  // row-major, aligned to `columns`; cells are JSON scalars (the backend stringifies anything else)
  rows: Array<Array<string | number | boolean | null>>;
  row_count: number;
  // true when the result was cut to the row cap, so the UI can say "showing the first N rows"
  truncated: boolean;
  elapsed_ms: number;
};

export async function dbTestConnection(token: string, params: DbConnectionParams): Promise<DbConnectionResult> {
  return request<DbConnectionResult>("/db/test-connection", token, { method: "POST", body: JSON.stringify(params) });
}

// A bad query or unreachable host comes back 400 with the DB error text in the body, which
// request<T> surfaces as an ApiError the console can display; a guest hitting this gets 403.
export async function dbQuery(token: string, params: DbConnectionParams & { sql: string; limit?: number }): Promise<DbQueryResult> {
  return request<DbQueryResult>("/db/query", token, { method: "POST", body: JSON.stringify(params) });
}

// --- stored database connections (feature/db-connections) ----------------------------------
// Persistent, named PostgreSQL/MySQL connections. Unlike the ad-hoc console above, the
// credentials are stored server-side and the password is write-only: the read shape reports
// `has_password` instead of the value. Blocked for desktop guests (403); sign in to use them.

export type DbConnection = {
  id: string;
  name: string;
  // typed DbEngine for backward compatibility with the ad-hoc console call sites; stored sqlite/
  // mssql connections carry those literal values at runtime (the navigator reads engine as a string)
  engine: DbEngine;
  host: string;
  port: number;
  username: string;
  database: string;
  group: string | null;
  // deployment tier for this connection ("", "dev", "qa", "uat", "prod"). Drives the env badge and
  // the production-safety guardrails in the workspace: a "prod" connection warns before executing
  // and requires a typed database-name confirmation for destructive statements.
  environment: string;
  // persisted default for the navigator's "Show all databases" mode: when true the connection
  // expands to every database on the server rather than only its stored default database.
  show_all_databases: boolean;
  has_password: boolean;
  created_at: string;
};

export type DbConnectionInput = {
  name: string;
  engine: DbConnEngine;
  host: string;
  port: number;
  username?: string;
  // write-only: send a non-empty value to set/replace it; leave blank on edit to keep the stored one
  password?: string;
  database?: string;
  group?: string | null;
  environment?: string;
  // persisted "Show all databases" default; optional so older callers stay backward-compatible
  show_all_databases?: boolean;
};

export type DbTable = {
  schema: string;
  name: string;
  type: string;
};

// --- database metadata (feature/db-workspace) ----------------------------------------------
// The lazy-tree navigator drills schema -> tables/views/routines -> columns/indexes/constraints/
// foreign-keys. Each level is its own endpoint so a big database's tree only fetches what the user
// actually expands. All are scoped to a stored connection and use its saved credentials.

export type DbDatabase = { name: string };
export type DbSchema = { name: string };
export type DbObject = { schema: string; name: string; type: string };
export type DbRoutine = { schema: string; name: string; kind: string };
export type DbColumn = {
  name: string;
  data_type: string;
  nullable: boolean;
  default: string;
  is_primary_key: boolean;
  ordinal: number;
};
export type DbIndex = { name: string; columns: string[]; unique: boolean; primary: boolean };
export type DbConstraint = { name: string; type: string; definition: string };
export type DbForeignKey = {
  name: string;
  columns: string[];
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
};

// A row in the per-user query-history log. connection_id is null when the connection it ran against
// has since been deleted (connection_name still holds the name it had at the time).
export type DbQueryHistory = {
  id: number;
  connection_id: number | null;
  connection_name: string;
  engine: string;
  database: string;
  user_email: string;
  sql: string;
  status: string;
  error: string;
  row_count: number;
  elapsed_ms: number;
  created_at: string;
};

export async function getDbConnections(token: string): Promise<DbConnection[]> {
  return request<DbConnection[]>("/db/connections", token);
}

export async function createDbConnection(token: string, input: DbConnectionInput): Promise<DbConnection> {
  return request<DbConnection>("/db/connections", token, { method: "POST", body: JSON.stringify(input) });
}

export async function updateDbConnection(token: string, id: string, input: Partial<DbConnectionInput>): Promise<DbConnection> {
  return request<DbConnection>(`/db/connections/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify(input) });
}

export async function deleteDbConnection(token: string, id: string): Promise<void> {
  // 204 No Content, so request<T> is wrong here: response.json() throws on an empty body.
  const response = await fetch(`${API_URL}/db/connections/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
}

// Probes an UNSAVED connection's params (the create/edit form's values) without storing anything.
export async function testDbConnection(token: string, input: DbConnectionInput): Promise<DbConnectionResult> {
  return request<DbConnectionResult>("/db/connections/test", token, { method: "POST", body: JSON.stringify(input) });
}

// Probes a stored connection by id, using its saved credentials.
export async function testDbConnectionById(token: string, id: string): Promise<DbConnectionResult> {
  return request<DbConnectionResult>(`/db/connections/${encodeURIComponent(id)}/test`, token, { method: "POST" });
}

export async function getDbTables(token: string, id: string): Promise<DbTable[]> {
  return request<DbTable[]>(`/db/connections/${encodeURIComponent(id)}/tables`, token);
}

export async function runConnectionQuery(token: string, id: string, sql: string, limit?: number): Promise<DbQueryResult> {
  return request<DbQueryResult>(`/db/connections/${encodeURIComponent(id)}/query`, token, {
    method: "POST",
    body: JSON.stringify({ sql, limit })
  });
}

// Renames a schema on a stored connection. Postgres-only server-side; the navigator only offers it
// for schemas under a connection whose engine supports it.
export async function renameDbSchema(
  token: string,
  id: string,
  schema: string,
  newName: string
): Promise<{ ok: boolean; message: string }> {
  return request(`/db/connections/${encodeURIComponent(id)}/schemas/${encodeURIComponent(schema)}/rename`, token, {
    method: "POST",
    body: JSON.stringify({ new_name: newName })
  });
}

// Streams a database dump as a file download. Deliberately NOT routed through request<T>: the body
// is raw dump bytes, so response.json() would throw. Mirrors sftpDownload's blob-download pattern;
// the filename honours the server's Content-Disposition when present.
export async function backupDbConnection(token: string, id: string, database?: string): Promise<void> {
  const suffix = database ? `?database=${encodeURIComponent(database)}` : "";
  const response = await fetch(`${API_URL}/db/connections/${encodeURIComponent(id)}/backup${suffix}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  // Errors (403, 400 for a non-postgres engine, 500 from pg_dump) come back as JSON/text, not bytes.
  if (!response.ok) throw new ApiError(response.status, await response.text());

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filenameFromDisposition(response.headers.get("Content-Disposition")) || `${database || "database"}.dump.sql`;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

// Restores a database from an uploaded dump. Multipart (field "file"), like the other upload
// helpers. Destructive: the caller guards it behind a confirmation.
export async function restoreDbConnection(
  token: string,
  id: string,
  file: File,
  database?: string
): Promise<{ ok: boolean; message: string }> {
  const suffix = database ? `?database=${encodeURIComponent(database)}` : "";
  const body = new FormData();
  body.append("file", file, file.name);
  return upload(`/db/connections/${encodeURIComponent(id)}/restore${suffix}`, token, body);
}

// --- database metadata + query history (feature/db-workspace) ------------------------------
// The navigator's lazy tree. Every path segment is encoded because schema/table names can carry
// characters (dots, spaces, slashes) that would otherwise corrupt the URL.

// Builds an optional `?database=<db>` suffix. When present it tells the backend to browse a
// DIFFERENT database on the same connection than the connection's stored default; omitted, the
// stored database is used. Kept as `?...` since these metadata routes carry no other query args.
function dbQuerySuffix(database?: string): string {
  return database ? `?database=${encodeURIComponent(database)}` : "";
}

// Lists the databases available on a connection's server, for the navigator's "Show all databases"
// mode. Returns an empty-ish list for engines with a single database (e.g. sqlite).
export async function getDbDatabases(token: string, id: string): Promise<DbDatabase[]> {
  return request<DbDatabase[]>(`/db/connections/${encodeURIComponent(id)}/databases`, token);
}

export async function getDbSchemas(token: string, id: string, database?: string): Promise<DbSchema[]> {
  return request<DbSchema[]>(`/db/connections/${encodeURIComponent(id)}/schemas${dbQuerySuffix(database)}`, token);
}

export async function getDbSchemaTables(token: string, id: string, schema: string, database?: string): Promise<DbObject[]> {
  return request<DbObject[]>(
    `/db/connections/${encodeURIComponent(id)}/schemas/${encodeURIComponent(schema)}/tables${dbQuerySuffix(database)}`,
    token
  );
}

export async function getDbSchemaRoutines(token: string, id: string, schema: string, database?: string): Promise<DbRoutine[]> {
  return request<DbRoutine[]>(
    `/db/connections/${encodeURIComponent(id)}/schemas/${encodeURIComponent(schema)}/routines${dbQuerySuffix(database)}`,
    token
  );
}

export async function getDbColumns(token: string, id: string, schema: string, table: string, database?: string): Promise<DbColumn[]> {
  return request<DbColumn[]>(
    `/db/connections/${encodeURIComponent(id)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/columns${dbQuerySuffix(database)}`,
    token
  );
}

export async function getDbIndexes(token: string, id: string, schema: string, table: string, database?: string): Promise<DbIndex[]> {
  return request<DbIndex[]>(
    `/db/connections/${encodeURIComponent(id)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/indexes${dbQuerySuffix(database)}`,
    token
  );
}

export async function getDbConstraints(token: string, id: string, schema: string, table: string, database?: string): Promise<DbConstraint[]> {
  return request<DbConstraint[]>(
    `/db/connections/${encodeURIComponent(id)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/constraints${dbQuerySuffix(database)}`,
    token
  );
}

export async function getDbForeignKeys(token: string, id: string, schema: string, table: string, database?: string): Promise<DbForeignKey[]> {
  return request<DbForeignKey[]>(
    `/db/connections/${encodeURIComponent(id)}/tables/${encodeURIComponent(schema)}/${encodeURIComponent(table)}/foreign-keys${dbQuerySuffix(database)}`,
    token
  );
}

// Server-side SQL generation for a table: SELECT/INSERT/UPDATE/DELETE/CREATE. Returns the text the
// workspace drops into a new editor tab (write kinds are never auto-run).
export async function generateDbSql(
  token: string,
  id: string,
  payload: { schema: string; table: string; kind: string; database?: string }
): Promise<{ sql: string }> {
  return request<{ sql: string }>(`/db/connections/${encodeURIComponent(id)}/generate-sql`, token, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

// The signed-in user's query history, most-recent first. Optional filters narrow by connection,
// status ("ok"/"error"), or a free-text search over the SQL.
export async function getDbQueryHistory(
  token: string,
  opts?: { connection_id?: number; status?: string; search?: string }
): Promise<DbQueryHistory[]> {
  const params = new URLSearchParams();
  if (opts?.connection_id != null) params.set("connection_id", String(opts.connection_id));
  if (opts?.status) params.set("status", opts.status);
  if (opts?.search) params.set("search", opts.search);
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<DbQueryHistory[]>(`/db/query-history${query}`, token);
}

export async function clearDbQueryHistory(token: string): Promise<void> {
  // 204 No Content on success, so request<T> is wrong here: response.json() throws on an empty body.
  const response = await fetch(`${API_URL}/db/query-history`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
}

// Edit a user's details (admin-only). full_name/role update the row; a non-empty password resets
// it, a blank/omitted password keeps the stored one. Returns the refreshed UserAccount.
export async function updateUser(
  token: string,
  id: number,
  payload: { full_name?: string; role?: string; password?: string }
): Promise<UserAccount> {
  return request<UserAccount>(`/users/${encodeURIComponent(String(id))}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export async function getShellFavorites(token: string): Promise<ShellFavorite[]> {
  return request<ShellFavorite[]>("/shell/favorites", token);
}

export async function createShellFavorite(token: string, name: string, command: string): Promise<ShellFavorite> {
  // A duplicate name for this user comes back 409, which request<T> surfaces as a thrown
  // Error carrying the body text.
  return request<ShellFavorite>("/shell/favorites", token, {
    method: "POST",
    body: JSON.stringify({ name, command })
  });
}

export async function deleteShellFavorite(token: string, id: number): Promise<void> {
  // 204 No Content, so request<T> is wrong here: response.json() throws on an empty body.
  const response = await fetch(`${API_URL}/shell/favorites/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
}

// --- kubernetes (feature/kube-clusters) ----------------------------------------------------
// A registry of Kubernetes clusters plus a read/act API over each one. Clusters are stored with
// their credentials (kubeconfig or a bearer token + CA) server-side; the credential material is
// write-only, so the read shape carries `has_credentials` instead of the secret. The overview /
// nodes / pods / logs / health endpoints proxy read-only calls to the cluster's API server, and
// the restart/scale/cordon endpoints perform the corresponding mutations (needs an RBAC role
// that permits them). Blocked for desktop guests (403); sign in to use them.

export type KubeCluster = {
  id: string;
  name: string;
  api_server_url: string;
  auth_method: "kubeconfig" | "token";
  verify_tls: boolean;
  default_namespace: string;
  group: string | null;
  // credentials are write-only: the API never echoes the kubeconfig/token back, so the read
  // shape reports whether any are stored rather than the values themselves
  has_credentials: boolean;
  // feature/k8s-log-shipping: whether this cluster's pod logs are tailed into Loki, and which
  // namespaces ([] = all).
  log_shipping_enabled: boolean;
  log_namespaces: string[];
  created_at: string;
};

export type KubeClusterInput = {
  name: string;
  api_server_url?: string;
  auth_method: "kubeconfig" | "token";
  kubeconfig?: string;
  token?: string;
  ca_cert?: string;
  verify_tls?: boolean;
  default_namespace?: string;
  group?: string | null;
};

export type KubeTestResult = {
  ok: boolean;
  message: string;
  version?: string;
};

export type KubeNode = {
  name: string;
  status: string;
  roles: string[];
  kubelet_version: string;
  os_image: string;
  internal_ip: string;
  cpu_capacity: string;
  memory_capacity: string;
  cpu_allocatable: string;
  memory_allocatable: string;
  age: string;
  schedulable: boolean;
  conditions: { type: string; status: string }[];
  // when the node maps to a monitored host in the inventory, the link back to it (else null)
  linked_server_id: string | null;
  linked_server_alias: string | null;
};

export type KubePod = {
  name: string;
  namespace: string;
  phase: string;
  ready: string;
  restarts: number;
  node: string;
  pod_ip: string;
  age: string;
  containers: string[];
};

export type KubePodLogs = {
  container: string;
  log: string;
  tail: number;
};

export type KubeDeployment = {
  name: string;
  namespace: string;
  ready: string;
  replicas: number;
  available: number;
  updated: number;
  age: string;
};

export type KubeHealth = {
  livez_ok: boolean;
  readyz_ok: boolean;
  readyz: { name: string; ok: boolean }[];
  component_statuses: { name: string; healthy: boolean; message: string }[];
  control_plane_pods: { name: string; namespace: string; phase: string; ready: boolean; restarts: number }[];
  addons: { name: string; healthy: boolean; detail: string }[];
};

export type KubeEvent = {
  type: string;
  reason: string;
  message: string;
  object: string;
  namespace: string;
  count: number;
  last_seen: string;
};

export type KubeOverview = {
  version: string;
  platform: string;
  node_count: number;
  nodes_ready: number;
  namespace_count: number;
  pod_count: number;
  pods_by_phase: { Running: number; Pending: number; Failed: number; Succeeded: number; Unknown: number };
  cpu_capacity: string;
  memory_capacity: string;
  health_ok: boolean;
  warnings: KubeEvent[];
};

// Result of a mutating action (restart/scale/cordon/delete-pod). Same shape the backend returns
// for each, so one type covers them all.
export type ActionResult = {
  ok: boolean;
  message: string;
};

export async function getKubeClusters(token: string): Promise<KubeCluster[]> {
  return request<KubeCluster[]>("/kube/clusters", token);
}

export async function getKubeCluster(token: string, id: string): Promise<KubeCluster> {
  return request<KubeCluster>(`/kube/clusters/${encodeURIComponent(id)}`, token);
}

export async function createKubeCluster(token: string, payload: KubeClusterInput): Promise<KubeCluster> {
  return request<KubeCluster>("/kube/clusters", token, { method: "POST", body: JSON.stringify(payload) });
}

export async function updateKubeCluster(token: string, id: string, payload: Partial<KubeClusterInput>): Promise<KubeCluster> {
  return request<KubeCluster>(`/kube/clusters/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify(payload) });
}

export async function deleteKubeCluster(token: string, id: string): Promise<void> {
  // 204 No Content, so request<T> is wrong here: response.json() throws on an empty body.
  const response = await fetch(`${API_URL}/kube/clusters/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  });
  if (!response.ok) throw new ApiError(response.status, await response.text());
}

// Probes connectivity/auth with the form's values (kubeconfig or url+token+ca) without storing
// anything, so the user can validate before saving. A bad config comes back ok:false (or an
// ApiError for a 4xx), both carrying a human-readable message.
export async function testKubeCluster(token: string, payload: KubeClusterInput): Promise<KubeTestResult> {
  return request<KubeTestResult>("/kube/clusters/test", token, { method: "POST", body: JSON.stringify(payload) });
}

export async function getKubeOverview(token: string, id: string): Promise<KubeOverview> {
  return request<KubeOverview>(`/kube/clusters/${encodeURIComponent(id)}/overview`, token);
}

export async function getKubeNodes(token: string, id: string): Promise<KubeNode[]> {
  return request<KubeNode[]>(`/kube/clusters/${encodeURIComponent(id)}/nodes`, token);
}

export async function getKubeNamespaces(token: string, id: string): Promise<string[]> {
  return request<string[]>(`/kube/clusters/${encodeURIComponent(id)}/namespaces`, token);
}

// An absent/empty namespace means "all namespaces" (the backend defaults accordingly); a value
// scopes the listing to that namespace.
export async function getKubePods(token: string, id: string, namespace?: string): Promise<KubePod[]> {
  const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  return request<KubePod[]>(`/kube/clusters/${encodeURIComponent(id)}/pods${query}`, token);
}

export async function getKubePodLogs(
  token: string,
  id: string,
  namespace: string,
  pod: string,
  opts?: { container?: string; tail?: number; previous?: boolean }
): Promise<KubePodLogs> {
  const params = new URLSearchParams();
  if (opts?.container) params.set("container", opts.container);
  if (opts?.tail != null) params.set("tail", String(opts.tail));
  if (opts?.previous) params.set("previous", "true");
  const query = params.toString() ? `?${params.toString()}` : "";
  return request<KubePodLogs>(
    `/kube/clusters/${encodeURIComponent(id)}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/logs${query}`,
    token
  );
}

export async function getKubeDeployments(token: string, id: string, namespace?: string): Promise<KubeDeployment[]> {
  const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  return request<KubeDeployment[]>(`/kube/clusters/${encodeURIComponent(id)}/deployments${query}`, token);
}

export async function getKubeHealth(token: string, id: string): Promise<KubeHealth> {
  return request<KubeHealth>(`/kube/clusters/${encodeURIComponent(id)}/health`, token);
}

export async function getKubeEvents(token: string, id: string, namespace?: string): Promise<KubeEvent[]> {
  const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  return request<KubeEvent[]>(`/kube/clusters/${encodeURIComponent(id)}/events${query}`, token);
}

export async function restartKubePod(token: string, id: string, namespace: string, pod: string): Promise<ActionResult> {
  return request<ActionResult>(
    `/kube/clusters/${encodeURIComponent(id)}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}/restart`,
    token,
    { method: "POST" }
  );
}

export async function deleteKubePod(token: string, id: string, namespace: string, pod: string): Promise<ActionResult> {
  // Unlike the cluster delete, this endpoint returns a JSON ActionResult body, so request<T> is
  // the right helper here.
  return request<ActionResult>(
    `/kube/clusters/${encodeURIComponent(id)}/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(pod)}`,
    token,
    { method: "DELETE" }
  );
}

export async function scaleKubeDeployment(
  token: string,
  id: string,
  namespace: string,
  name: string,
  replicas: number
): Promise<ActionResult> {
  return request<ActionResult>(
    `/kube/clusters/${encodeURIComponent(id)}/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/scale`,
    token,
    { method: "POST", body: JSON.stringify({ replicas }) }
  );
}

export async function restartKubeDeployment(token: string, id: string, namespace: string, name: string): Promise<ActionResult> {
  return request<ActionResult>(
    `/kube/clusters/${encodeURIComponent(id)}/deployments/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/restart`,
    token,
    { method: "POST" }
  );
}

export async function cordonKubeNode(token: string, id: string, name: string, cordon: boolean): Promise<ActionResult> {
  return request<ActionResult>(
    `/kube/clusters/${encodeURIComponent(id)}/nodes/${encodeURIComponent(name)}/cordon`,
    token,
    { method: "POST", body: JSON.stringify({ cordon }) }
  );
}

// --- monitoring (feature/monitoring-page) --------------------------------------------------
// Surfaces the Prometheus / Loki / Alertmanager stack INSIDE the app. Every call is a GET that
// proxies through the app's own backend (never straight to Prometheus/Loki), so the same
// signed-in-or-guest auth applies. Payloads are raw Prometheus/Loki JSON, kept loosely typed.

export type MonitoringEnabled = {
  prometheus: boolean;
  loki: boolean;
  alertmanager: boolean;
  grafana_url: string;
};

// Prometheus instant/range query envelope. `result` is a matrix (query_range, `values`) or a
// vector (query, `value`); both variants are accepted so one type covers both endpoints.
export type PromResult = {
  metric: Record<string, string>;
  // instant query: a single [unixSeconds, "value"] pair
  value?: [number, string];
  // range query: many [unixSeconds, "value"] pairs
  values?: Array<[number, string]>;
};

export type PromResponse = {
  status: string;
  data: {
    resultType: string;
    result: PromResult[];
  };
};

// Loki query_range envelope. `values` are [nanoTimestampString, logLine] pairs, newest last as
// returned; the UI reverses them for newest-first display.
export type LokiStream = {
  stream: Record<string, string>;
  values: Array<[string, string]>;
};

export type LokiResponse = {
  status: string;
  data: {
    resultType: string;
    result: LokiStream[];
  };
};

// Alertmanager v2 alert. Kept loose — only the fields the UI reads are named; the rest ride along.
export type AlertmanagerAlert = {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  status: { state: string; [key: string]: unknown };
  startsAt: string;
  endsAt?: string;
  [key: string]: unknown;
};

export async function getMonitoringEnabled(token: string): Promise<MonitoringEnabled> {
  return request<MonitoringEnabled>("/monitoring/enabled", token);
}

export async function promQuery(token: string, query: string): Promise<PromResponse> {
  const params = new URLSearchParams({ query });
  return request<PromResponse>(`/monitoring/prometheus/query?${params.toString()}`, token);
}

// start/end/step are UNIX seconds; Prometheus expects seconds, so no conversion here.
export async function promQueryRange(
  token: string,
  query: string,
  startSec: number,
  endSec: number,
  stepSec: number
): Promise<PromResponse> {
  const params = new URLSearchParams({
    query,
    start: String(Math.floor(startSec)),
    end: String(Math.floor(endSec)),
    step: String(Math.max(1, Math.floor(stepSec)))
  });
  return request<PromResponse>(`/monitoring/prometheus/query_range?${params.toString()}`, token);
}

// Callers pass seconds; Loki wants NANOSECONDS, so convert here (as integer strings, since a
// nanosecond epoch overflows the precision a JS number keeps as a plain integer past ~ms).
export async function lokiQueryRange(
  token: string,
  query: string,
  startSec: number,
  endSec: number,
  opts?: { limit?: number; direction?: string }
): Promise<LokiResponse> {
  const params = new URLSearchParams({
    query,
    start: `${Math.floor(startSec)}000000000`,
    end: `${Math.floor(endSec)}000000000`,
    limit: String(opts?.limit ?? 200),
    direction: opts?.direction ?? "backward"
  });
  return request<LokiResponse>(`/monitoring/loki/query_range?${params.toString()}`, token);
}

export async function getMonitoringAlerts(token: string): Promise<AlertmanagerAlert[]> {
  return request<AlertmanagerAlert[]>("/monitoring/alerts", token);
}

export async function lokiLabels(token: string): Promise<{ data: string[] }> {
  return request<{ data: string[] }>("/monitoring/loki/labels", token);
}

export async function lokiLabelValues(token: string, name: string): Promise<{ data: string[] }> {
  return request<{ data: string[] }>(`/monitoring/loki/label/${encodeURIComponent(name)}/values`, token);
}

// --- per-server monitoring (feature/server-monitoring) -------------------------------------
// Enable/disable a node_exporter metrics agent and log shipping for a single managed host, and
// read back its current state. Installing the agent runs commands on the real host over SSH, so
// it may come back needing a sudo password (mirrors the PrivilegedResult flow used for tomcat /
// service restarts); the caller retries with `sudoPassword` set. log_sources is the list of
// discovered log sources currently shipped to Loki; setServerLogShipping replaces the whole set.

export type ServerLogSource = { source: string; name_or_path: string };

export type ServerMonitoring = {
  metrics_enabled: boolean;
  node_exporter_port: number;
  // whether Prometheus is actually scraping this host's exporter yet (vs. merely installed)
  scraped: boolean;
  log_shipping_enabled: boolean;
  log_sources: ServerLogSource[];
};

// Result of install-metrics: same shape as PrivilegedResult minus `output` — carries
// needs_sudo_password so the caller can prompt and retry, exactly like tomcatAction.
export type ServerMonitoringActionResult = {
  ok: boolean;
  message: string;
  needs_sudo_password: boolean;
};

export async function getServerMonitoring(token: string, serverId: string): Promise<ServerMonitoring> {
  return request<ServerMonitoring>(`/servers/${encodeURIComponent(serverId)}/monitoring`, token);
}

// Installs node_exporter on the host over SSH. Omit sudoPassword on the first attempt; if the
// result carries needs_sudo_password, prompt for it and call again with the value.
export async function installServerMetrics(
  token: string,
  serverId: string,
  sudoPassword?: string
): Promise<ServerMonitoringActionResult> {
  return request<ServerMonitoringActionResult>(`/servers/${encodeURIComponent(serverId)}/monitoring/install-metrics`, token, {
    method: "POST",
    body: JSON.stringify(sudoPassword ? { sudo_password: sudoPassword } : {})
  });
}

export async function uninstallServerMetrics(token: string, serverId: string): Promise<ServerMonitoringActionResult> {
  return request<ServerMonitoringActionResult>(`/servers/${encodeURIComponent(serverId)}/monitoring/uninstall-metrics`, token, {
    method: "POST"
  });
}

export async function setServerLogShipping(
  token: string,
  serverId: string,
  enabled: boolean,
  sources: ServerLogSource[]
): Promise<ServerMonitoringActionResult> {
  return request<ServerMonitoringActionResult>(`/servers/${encodeURIComponent(serverId)}/monitoring/log-shipping`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled, sources })
  });
}

// --- detected log capabilities (feature/log-capabilities) ----------------------------------
// One SSH probe per server: which log-producing systems it runs, plus suggested log sources
// (e.g. nginx access/error files) the log-shipping picker can offer.
export type ServerLogCapabilities = {
  nginx: boolean;
  docker: boolean;
  podman: boolean;
  kubernetes: boolean;
  suggested_sources: ServerLogSource[];
};

export async function getServerLogCapabilities(token: string, serverId: string): Promise<ServerLogCapabilities> {
  return request<ServerLogCapabilities>(`/servers/${encodeURIComponent(serverId)}/log-capabilities`, token);
}

// --- user-defined Prometheus alert rules (feature/custom-alerts) ----------------------------
export type AlertRule = {
  name: string;
  expr: string;
  for: string;
  severity: string;
  summary: string;
  description: string;
};

// A prefillable template returned by the API. `requires` is present when the rule needs an
// exporter that may not be installed (e.g. the nginx timeout rule).
export type AlertTemplate = {
  key: string;
  name: string;
  expr: string;
  for: string;
  severity: string;
  summary: string;
  description: string;
  requires?: string;
};

export async function listAlertRules(token: string): Promise<AlertRule[]> {
  return request<AlertRule[]>("/monitoring/alerts/rules", token);
}

export async function getAlertTemplates(token: string): Promise<AlertTemplate[]> {
  return request<AlertTemplate[]>("/monitoring/alerts/templates", token);
}

export async function addAlertRule(
  token: string,
  rule: { name: string; expr: string; for_duration: string; severity: string; summary: string; description: string }
): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>("/monitoring/alerts/rules", token, {
    method: "POST",
    body: JSON.stringify(rule)
  });
}

export async function deleteAlertRule(token: string, name: string): Promise<{ ok: boolean; message: string }> {
  return request<{ ok: boolean; message: string }>(`/monitoring/alerts/rules/${encodeURIComponent(name)}`, token, {
    method: "DELETE"
  });
}

// --- kubernetes cluster log shipping (feature/k8s-log-shipping) ------------------------------
export async function setClusterLogShipping(
  token: string,
  clusterId: string,
  enabled: boolean,
  namespaces: string[]
): Promise<KubeCluster> {
  return request<KubeCluster>(`/kube/clusters/${encodeURIComponent(clusterId)}/log-shipping`, token, {
    method: "PUT",
    body: JSON.stringify({ enabled, namespaces })
  });
}
