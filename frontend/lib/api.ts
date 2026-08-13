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
  server_count: number;
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
};

export type Integration = {
  name: string;
  url: string;
  status: string;
};

export type Me = {
  email: string;
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
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(body || `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
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

export async function changePassword(token: string, currentPassword: string, newPassword: string): Promise<{ ok: boolean; message: string }> {
  return request("/auth/change-password", token, {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
  });
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

export async function createFolder(token: string, name: string): Promise<Folder> {
  return request<Folder>("/folders", token, { method: "POST", body: JSON.stringify({ name }) });
}

export async function renameFolder(token: string, folderId: string, name: string): Promise<Folder> {
  return request<Folder>(`/folders/${encodeURIComponent(folderId)}`, token, { method: "PATCH", body: JSON.stringify({ name }) });
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

// --- database console (feature/db-connect) -------------------------------------------------
// A standalone SQL console: the caller supplies connection params + credentials on every call,
// and the backend opens a fresh PostgreSQL/MySQL connection, runs the work, and closes it.
// Nothing is stored. Both endpoints are blocked for desktop guests (403) — sign in to use them.

export type DbEngine = "postgres" | "mysql";

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
