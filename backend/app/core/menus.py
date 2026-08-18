"""Role -> sidebar-menu matrix: the fixed vocabulary and the default assignments.

This is the single source of truth shared by the seeder (app.main), the API
(app.api.routes) and, by mirroring, the frontend sidebar. The matrix drives which
sidebar entries a role SEES; it is not an authorization layer. Endpoint access stays
governed by the require_admin / require_admin_not_guest guards regardless of what the
matrix says, so adding "users" to the developer row shows the nav item but the /users
call still returns 403.
"""

# The AppSetting row the matrix is persisted under (JSON: role key -> list of item keys).
ROLE_MENUS_KEY = "role_menus"

# Fixed vocabulary of sidebar menu-item keys. A value outside this set is ignored on both
# read and write, so a typo in a stored matrix can never invent a menu entry.
MENU_ITEMS: list[str] = [
    "dashboard",       # Dashboard (/)
    "servers",         # Server Management (/servers)
    "databases",       # Database console (/databases) — Postgres/MySQL query tool
    "shell",           # Shell launcher flyout (host SSH sessions)
    "kubernetes",      # Kubernetes clusters (/kubernetes) — cluster nodes/pods/deployments
    "monitoring",      # Monitoring (/monitoring) — Prometheus/Loki/Alertmanager proxies (full profile)
    "users",           # Users (/users)
    "policies",        # Server Policies (/policies)
    "administration",  # Administration group (server-type / environment master data)
    "access",          # Access Control (/access) — this matrix editor itself
    "vault",           # Vault config (/vault) — HashiCorp Vault secrets backend
    "appdatabase",     # App Database (/app-database) — switch the app's own DB to Postgres/MySQL
    "appearance",      # Appearance / theme (/appearance)
    "profile",         # Profile (/profile)
]

# The effective role keys the matrix is keyed on. "admin" is the normalized form of the
# "administrator" enum value; a desktop guest session resolves to the "guest" row.
ROLE_KEYS: list[str] = ["admin", "developer", "support", "guest"]

# Sensible defaults that reproduce the sidebar's previous hardcoded behaviour, so seeding
# the matrix (or falling back to it) changes nothing visible until an admin edits it.
DEFAULT_ROLE_MENUS: dict[str, list[str]] = {
    "admin": ["dashboard", "servers", "databases", "shell", "kubernetes", "monitoring", "users", "policies", "administration", "access", "vault", "appdatabase", "appearance", "profile"],
    "developer": ["dashboard", "servers", "databases", "kubernetes", "monitoring", "profile"],
    "support": ["dashboard", "servers", "databases", "profile"],
    # guest is login-less and local-only: no database console (require_user_not_guest blocks it).
    "guest": ["dashboard", "servers", "databases", "kubernetes", "monitoring", "shell", "appearance", "appdatabase"],
}

# Last-resort row for a role that is somehow neither in the matrix nor in the defaults:
# never an empty sidebar, always at least the two universally safe reads.
_MINIMAL_MENUS: list[str] = ["dashboard", "servers"]


def normalize_role(role: str | None) -> str:
    value = (role or "").strip().lower()
    return "admin" if value == "administrator" else value


def _dedup_known(items: object) -> list[str]:
    if not isinstance(items, list):
        return []
    seen: list[str] = []
    for item in items:
        if item in MENU_ITEMS and item not in seen:
            seen.append(item)
    return seen


def menus_for_role(matrix: dict[str, list[str]], role: str | None, guest: bool = False) -> list[str]:
    """The effective menu list for a caller.

    A desktop guest uses the "guest" row regardless of the (admin) role its synthetic
    session carries. An empty or missing row falls back to the defaults so the sidebar is
    never blank — an admin can trim a role down but not black it out entirely.
    """
    key = "guest" if guest else normalize_role(role)
    row = _dedup_known(matrix.get(key))
    if not row:
        row = _dedup_known(DEFAULT_ROLE_MENUS.get(key)) or list(_MINIMAL_MENUS)
    return row
