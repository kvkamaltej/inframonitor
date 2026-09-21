"use client";

// Per-viewer, per-browser record of which servers were opened and how often, plus which groups the
// viewer pinned. Lives in localStorage only (a convenience, never authoritative) and every access is
// wrapped in try/catch so a private window / blocked storage never throws. Powers:
//   - the dashboard "Recent Servers" list (most-recently opened first),
//   - the "Most opened" server sort,
//   - the "favorite group" ordering (pinned groups first).

const ACCESS_KEY = "inframonitor-server-access-v1";
const FAV_GROUPS_KEY = "inframonitor-favorite-groups-v1";

export type ServerAccess = { count: number; last: number };
type AccessMap = Record<string, ServerAccess>;

function readAccess(): AccessMap {
  try {
    const raw = localStorage.getItem(ACCESS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as AccessMap) : {};
  } catch {
    return {};
  }
}

// Record that a server (by public_id) was opened: bump its count and its last-opened timestamp.
export function recordServerAccess(id: string): void {
  if (!id) return;
  try {
    const map = readAccess();
    const prev = map[id] ?? { count: 0, last: 0 };
    map[id] = { count: prev.count + 1, last: Date.now() };
    localStorage.setItem(ACCESS_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — recents are a convenience, so ignore */
  }
}

export function getServerAccess(): AccessMap {
  return readAccess();
}

// public_ids ordered by most-recently opened first (only ones actually opened).
export function recentServerIds(): string[] {
  const map = readAccess();
  return Object.keys(map)
    .filter((id) => (map[id]?.last ?? 0) > 0)
    .sort((a, b) => (map[b].last ?? 0) - (map[a].last ?? 0));
}

// --- favorite (pinned) groups ---------------------------------------------------------------

function readFavGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(FAV_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

export function getFavoriteGroups(): Set<string> {
  return readFavGroups();
}

// Toggle a group (folder public_id) as a favorite. Returns the new set so callers can update state.
export function toggleFavoriteGroup(id: string): Set<string> {
  const set = readFavGroups();
  if (set.has(id)) set.delete(id);
  else set.add(id);
  try {
    localStorage.setItem(FAV_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
  return set;
}
