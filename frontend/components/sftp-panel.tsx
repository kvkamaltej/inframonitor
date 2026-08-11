"use client";

import {
  ChangeEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  CornerLeftUp,
  Copy,
  Download,
  File as FileIcon,
  Folder,
  FolderSearch,
  Home,
  Link2,
  Loader2,
  Lock,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  ApiError,
  SftpDeleteResult,
  SftpEntry,
  SftpListing,
  sftpDelete,
  sftpDownload,
  sftpList,
  sftpUpload
} from "@/lib/api";

export type SftpPanelProps = {
  token: string;
  serverId: string;
  hostname: string;
  onClose?: () => void;
  className?: string;
};

// Which operation failed, so the banner can name the right recovery. The backend caps
// listings at 2000 entries, so `truncated` is a normal outcome rather than a failure and is
// handled separately from these.
type Action = "list" | "download" | "upload" | "delete";

// The API client throws ApiError, which carries response.status; older paths only had the
// body text. Each kind gets its own message because the operator's next move differs: a 413
// means change the cap or split the file, a denial means change ownership on the host, a
// miss means the listing is stale, a non-empty directory means opt into the recursive form.
type FailureKind =
  | "toobig"
  | "denied"
  | "missing"
  | "notdir"
  | "notempty"
  | "needsrecursive"
  | "refused"
  | "acl"
  | "auth"
  | "offline"
  | "unknown";

type Failure = { kind: FailureKind; detail: string; path: string; label: string; action: Action };

type Pending = { kind: Action; label: string };

// Sorting is client-side over whatever the listing returned. "created" is deliberately
// absent: SFTP's attribute set carries mtime, atime, size, mode and ownership and nothing
// else, so there is no birth time to sort on and labelling mtime "created" would be a lie.
type SortKey = "name" | "size" | "modified";
type SortDir = "asc" | "desc";

// A row menu, opened either by right-click (at the pointer) or by the row's `⋯` button (at
// the button). `placed` flips once the menu has been measured and clamped into the viewport.
type RowMenu = { entry: SftpEntry; x: number; y: number; placed: boolean };

// The delete confirmation.
//
// A directory starts unescalated, where the only button sends recursive=false. The backend
// removes an empty directory that way and refuses a populated one without touching it, so that
// first click is incapable of destroying a tree however hard it is mashed. `escalated` flips
// only after such a refusal comes back, and it reveals `typed` — the operator has to write the
// directory's own name before the recursive call is permitted. `reason` carries the refusal that
// caused the escalation, shown in the dialog rather than in the banner behind it.
type Confirming = { entry: SftpEntry; typed: string; escalated: boolean; reason: string };

const COMMON_CAP_NOTE = "Nothing was transferred.";

const SORT_LABELS: Record<SortKey, string> = { name: "Name", size: "Size", modified: "Modified" };

function formatBytes(value: string | number | undefined) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let size = bytes;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

// `modified` is formatted by the backend as "YYYY-MM-DD HH:MM" in UTC. Date.parse() treats
// that space-separated form as local time in some engines and rejects it in others, so parse
// it explicitly and only fall back to Date.parse for a shape we did not anticipate.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseStamp(value: string): number | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  const match = STAMP.exec(trimmed);
  if (match) {
    const seconds = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0)
    );
    return Number.isFinite(seconds) ? Math.round(seconds / 1000) : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? Math.round(parsed / 1000) : null;
}

// Sort key for the modified column, in seconds, or null when the host gave no usable time.
//
// `modified_epoch` is the raw st_mtime and the only correct thing to sort on: `modified` is a
// formatted string, and ordering that as text puts every 2024 entry above every 2026 one only
// by luck of the digits. Two distinct absences are kept apart deliberately:
//
//   0       the SFTP server reported no usable mtime -> not 1970, and sorting it as 1970 would
//           bunch those rows at one extreme as if they were the oldest files in the directory
//   absent  the response did not carry the field at all, i.e. a backend older than this build
//
// Both fall back to parsing the formatted string, which is exact to the minute and is all that
// string carries anyway; it returns null when there is nothing to parse either. The typeof test
// rather than a comparison to undefined is deliberate: the field is declared `number`, so the
// compiler rejects `=== undefined` outright, but a stale server can still omit it at runtime
// and the control must not silently collapse to name order when it does.
function entryEpoch(entry: SftpEntry): number | null {
  const raw = entry.modified_epoch;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return parseStamp(entry.modified);
  return raw;
}

// Absolute-path depth, matching the backend's guard: it refuses a recursive delete of any
// path with fewer than two components, so `/etc` and `/var` cannot be removed by a mis-click.
// Checking it here too turns a doomed round trip into an explanation before the fact.
function pathDepth(path: string): number {
  return (path || "").split("/").filter(Boolean).length;
}

function basename(path: string, fallback: string): string {
  const trimmed = (path || "").replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  const name = cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
  return name || fallback;
}

// FastAPI answers with {"detail": ...}. Showing the operator a raw JSON blob is not an
// error message, so unwrap it — including the list form Pydantic emits for validation.
function detailText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const detail = (parsed as { detail?: unknown })?.detail;
    if (typeof detail === "string" && detail.trim()) return detail.trim();
    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          const msg = (item as { msg?: unknown })?.msg;
          return typeof msg === "string" ? msg : "";
        })
        .filter(Boolean);
      if (messages.length > 0) return messages.join("; ");
    }
    if (typeof (parsed as { message?: unknown })?.message === "string") return String((parsed as { message: string }).message);
  } catch {
    // Not JSON after all — fall through and show the body as-is.
  }
  return trimmed;
}

function classify(error: unknown): { kind: FailureKind; detail: string } {
  const detail = detailText(error);
  const probe = detail.toLowerCase();
  const has = (...needles: string[]) => needles.some((needle) => probe.includes(needle));

  // Prefer the real HTTP status when the client gave us one. Body-text matching below is
  // the fallback: it works, but it silently misclassifies the moment a `detail` string is
  // reworded, and 413-vs-403 pick different remedies for the operator.
  const status = error instanceof ApiError ? error.status : 0;
  if (status === 413) return { kind: "toobig", detail };
  if (status === 401) return { kind: "auth", detail };
  if (status === 403) {
    // both are 403: an access-policy refusal is ours, a filesystem denial is the host's
    return { kind: has("access policy", "not assigned", "acl") ? "acl" : "denied", detail };
  }
  // 400 is deliberately *not* short-circuited here. Every SshOperationError from the SFTP
  // routes becomes a 400 with the message intact, so a permission denial, a missing path, a
  // non-empty directory and a guard refusal all share that status and only the text separates
  // them. Status-first still pays off for 413/401/403, which the text cannot reliably tell.

  // Ordered most specific first: a 413 body often also contains the word "file", a guard
  // refusal contains "not permitted" which would otherwise read as a filesystem denial, and
  // an ACL refusal and a filesystem denial are both 403s that need different advice.
  if (has("413", "too large", "exceeds", "larger than", "download cap", "max_download", "size cap", "entity too large")) {
    return { kind: "toobig", detail };
  }
  if (has("not a directory", "notdir", "enotdir")) return { kind: "notdir", detail };
  // Before the "recursive" test below, and that order is load-bearing: the guard's own message
  // reads "Refusing a recursive delete of /tmp: a top-level path is too broad", so a check for
  // the word "recursive" would claim it first and tell the operator to opt into a recursion the
  // backend will never allow. Measured against the live endpoint, not guessed.
  if (has("refusing", "refuse to", "too broad", "too shallow", "filesystem root", "components deep", "path component")) {
    return { kind: "refused", detail };
  }
  if (has("not empty", "enotempty")) return { kind: "notempty", detail };
  // The real refusal for a populated directory is "…is a directory holding 2 entries. Pass
  // recursive=true to delete it and everything inside it." — it never says "not empty", so this
  // keyword rather than that one is what actually catches it.
  if (has("recursive")) return { kind: "needsrecursive", detail };
  if (has("no such file", "no such directory", "not found", "does not exist", "enoent", "404")) {
    return { kind: "missing", detail };
  }
  if (has("access policy", "not authorised for", "not authorized for", "no access to this server", "acl")) {
    return { kind: "acl", detail };
  }
  if (has("permission denied", "eacces", "forbidden", "403", "not permitted", "access denied")) {
    return { kind: "denied", detail };
  }
  if (has("401", "not authenticated", "could not validate credentials", "invalid token", "expired")) {
    return { kind: "auth", detail };
  }
  if (has("unable to connect", "connection refused", "connection reset", "timed out", "timeout", "unreachable", "no route to host", "authentication failed")) {
    return { kind: "offline", detail };
  }
  return { kind: "unknown", detail };
}

function headlineFor(failure: Failure, hostname: string): string {
  const what = failure.label || failure.path || "that path";
  switch (failure.kind) {
    case "toobig":
      return `${what} is over the download size cap`;
    case "denied":
      return `Permission denied on ${what}`;
    case "missing":
      return failure.action === "list"
        ? `No such directory: ${what}`
        : failure.action === "delete"
          ? `${what} is already gone`
          : `No such file: ${what}`;
    case "notdir":
      return `${what} is not a directory`;
    case "notempty":
      return `${what} is not empty`;
    case "needsrecursive":
      return `${what} is a directory, so the delete needs the recursive form`;
    case "refused":
      return `That delete was refused before it ran`;
    case "acl":
      return `You do not have access to ${hostname}`;
    case "auth":
      return "Your session has expired";
    case "offline":
      return `Cannot reach ${hostname} over SSH`;
    default:
      return failure.action === "list"
        ? `Unable to list ${what}`
        : failure.action === "download"
          ? `Unable to download ${what}`
          : failure.action === "delete"
            ? `Unable to delete ${what}`
            : `Unable to upload ${what}`;
  }
}

function deniedVerb(action: Action): string {
  switch (action) {
    case "list":
      return "read this directory";
    case "upload":
      return "write into this directory";
    case "delete":
      return "remove this entry, or cannot write to the directory holding it";
    default:
      return "read this file";
  }
}

function guidanceFor(failure: Failure, hostname: string): string {
  switch (failure.kind) {
    case "toobig":
      return `The server checked the size with stat and refused before sending any bytes, so ${COMMON_CAP_NOTE.toLowerCase()} Raise max_download_mb in settings, or compress or split the file on ${hostname} and fetch the parts.`;
    case "denied":
      return `The stored SSH user cannot ${deniedVerb(failure.action)}. This pane has no elevation — it holds exactly the rights the shell tab holds — so the fix is ownership or group membership on ${hostname}, not a retry.${
        failure.action === "delete" ? " Nothing was removed." : ""
      }`;
    case "missing":
      return failure.action === "delete"
        ? "Nothing was removed, because there was nothing there. Something else deleted or moved it since this listing was taken — reload the directory to see the current state."
        : "It may have been moved or deleted since this listing was taken. Reload the directory, or jump back to the home directory.";
    case "notdir":
      return "It is a file, or a link pointing at one. Download it instead of opening it.";
    case "notempty":
      return "The directory still holds entries, so it was left exactly as it was. Open the delete dialog again: once it knows the directory is not empty it offers the recursive form, which asks you to type the directory's name first.";
    case "needsrecursive":
      return "Removing a directory with anything inside it takes the recursive path, which the delete dialog unlocks after you confirm by typing the directory's name. Nothing was removed.";
    case "refused":
      return `The backend blocks deletes that are too broad to be recoverable from — the filesystem root, and anything only one level below it. Nothing was removed. Delete a specific path further down the tree, or use a shell tab on ${hostname} if this really is what you want.`;
    case "acl":
      return "Your access policy does not cover this server. An admin has to grant it before the file pane will open.";
    case "auth":
      return "Sign in again — the file pane needs a valid token for every listing and transfer.";
    case "offline":
      return "The file pane needs the same SSH connection the shell uses. Check the host is up and that the stored credentials still work.";
    default:
      return "";
  }
}

// Direction wording per column, because "ascending" says nothing useful about a size or a
// timestamp — "Largest first" and "Newest first" do.
function directionLabel(key: SortKey, dir: SortDir): string {
  if (key === "size") return dir === "asc" ? "Smallest first" : "Largest first";
  if (key === "modified") return dir === "asc" ? "Oldest first" : "Newest first";
  return dir === "asc" ? "A → Z" : "Z → A";
}

// Best-effort clipboard write. navigator.clipboard is undefined on a plain-http LAN origin
// (it needs a secure context) and can reject when the document is not focused, so fall back
// to the legacy selection copy and, failing that, to showing the path for a manual copy.
function legacyCopy(text: string): boolean {
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const done = document.execCommand("copy");
    document.body.removeChild(field);
    return done;
  } catch {
    return false;
  }
}

// A side pane for one server: browse, download, upload and delete as the stored SSH user.
// Sized by the caller; the row list scrolls internally so a fullscreen or short workspace
// both work.
export function SftpPanel({ token, serverId, hostname, onClose, className }: SftpPanelProps) {
  const [listing, setListing] = useState<SftpListing | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [filter, setFilter] = useState("");
  // The path is editable in place. `pathDraft` is null while the field simply mirrors the
  // current directory, and a string once the operator starts typing — so a listing that
  // finishes loading mid-edit cannot overwrite what they are halfway through typing.
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [dirsFirst, setDirsFirst] = useState(true);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Whatever opened the menu, so Escape and click-away can hand focus back instead of
  // dropping it on the document body.
  const menuOrigin = useRef<HTMLElement | null>(null);
  // Navigating twice quickly must not let the slower response win and land the pane in a
  // directory the operator already left.
  const ticketRef = useRef(0);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenu(null);
    const origin = menuOrigin.current;
    menuOrigin.current = null;
    if (restoreFocus && origin && document.contains(origin)) origin.focus();
  }, []);

  const load = useCallback(
    async (target: string, label: string) => {
      const ticket = ticketRef.current + 1;
      ticketRef.current = ticket;
      setPending({ kind: "list", label });
      setFailure(null);
      try {
        const next = await sftpList(token, serverId, target);
        if (ticket !== ticketRef.current) return;
        setListing(next);
        setFilter("");
      } catch (error) {
        if (ticket !== ticketRef.current) return;
        const { kind, detail } = classify(error);
        // Deliberately leaves `listing` alone: a denial on a subdirectory should not strand
        // the operator on a blank pane, it should leave them where they were.
        setFailure({ kind, detail, path: target, label, action: "list" });
      } finally {
        if (ticket === ticketRef.current) setPending(null);
      }
    },
    [serverId, token]
  );

  useEffect(() => {
    setListing(null);
    setFailure(null);
    setNotice("");
    setFilter("");
    setMenu(null);
    setConfirming(null);
    // An empty path means "the SSH user's home"; the backend resolves it over SFTP.
    void load("", "home");
  }, [load]);

  // fetch() reports no progress in either direction, so show honest elapsed seconds and an
  // indeterminate bar rather than inventing a percentage.
  const transferring = pending !== null && (pending.kind === "download" || pending.kind === "upload");
  useEffect(() => {
    if (!transferring) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [transferring, pending]);

  // A menu pinned to a row that no longer exists is a trap: it would act on a stale path.
  useEffect(() => {
    setMenu(null);
  }, [listing]);

  // Measure once, then clamp into the viewport. The menu renders with visibility:hidden until
  // it has been placed — which keeps its layout box measurable, unlike display:none — so the
  // first frame the operator actually sees is already inside the viewport. Done in a plain
  // effect rather than useLayoutEffect so this component does not warn when Next prerenders it.
  useEffect(() => {
    if (!menu || menu.placed) return;
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const pad = 8;
    const x = Math.max(pad, Math.min(menu.x, window.innerWidth - rect.width - pad));
    const y = Math.max(pad, Math.min(menu.y, window.innerHeight - rect.height - pad));
    setMenu({ ...menu, x, y, placed: true });
  }, [menu]);

  // Focus the first usable item so the menu is operable from the keyboard the moment it opens.
  useEffect(() => {
    if (!menu?.placed) return;
    const node = menuRef.current;
    if (!node) return;
    const first = node.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])');
    first?.focus();
  }, [menu?.placed]);

  // Dismiss on Escape, click-away, scroll and resize. Scroll is captured because the row list
  // scrolls internally and a scroll event on that element never bubbles to window.
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeMenu(true);
      }
    };
    const onDown = (event: Event) => {
      const node = menuRef.current;
      if (node && event.target instanceof Node && node.contains(event.target)) return;
      const origin = menuOrigin.current;
      // Leave the button that opened it alone. pointerdown fires before click, so closing here
      // would let the click that follows reopen the menu and the `⋯` button would never toggle
      // shut. Its own handler decides.
      if (origin && event.target instanceof Node && origin.contains(event.target)) return;
      closeMenu(false);
    };
    const away = () => closeMenu(false);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [menu, closeMenu]);

  // Move focus into the dialog when it opens. The escalated form autofocuses its confirmation
  // field; everything else lands on Cancel, deliberately not on the destructive button — the menu
  // item that opened the dialog has just unmounted, and leaving focus on document.body would mean
  // a stray Enter or Space does nothing at all.
  useEffect(() => {
    if (!confirming || confirming.escalated) return;
    cancelRef.current?.focus();
  }, [confirming]);

  // The dialog owns Escape while it is open; the menu is always closed before it opens, so
  // the two handlers can never both fire for one keypress.
  useEffect(() => {
    if (!confirming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // Never yank the dialog out from under an in-flight delete: the result still has to land
      // somewhere the operator can read it.
      setConfirming((current) => (pending?.kind === "delete" ? current : null));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [confirming, pending]);

  const entries = useMemo(() => {
    const rows = [...(listing?.entries ?? [])];
    const flip = sortDir === "desc" ? -1 : 1;
    const byName = (a: SftpEntry, b: SftpEntry) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    // The backend sorts dirs-first-then-name. Sorting here as well means a change or a partial
    // response on that side cannot silently scramble the pane, and it is what makes the column
    // controls work at all without a round trip.
    rows.sort((a, b) => {
      if (dirsFirst) {
        // Grouping is the toggle's job, not the sort's: reversing the direction reverses the
        // order inside each group and leaves directories at the top where they were asked for.
        const aDir = a.type === "dir" ? 0 : 1;
        const bDir = b.type === "dir" ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
      }
      if (sortKey === "size") {
        // Inside the directory group — which exists only because the toggle put it there — a
        // directory's st_size is its inode size, and this pane does not display it. Ordering rows
        // by a number nobody can see reads as broken, so directories fall back to name.
        //
        // With grouping off the operator asked for one flat ordering, so every row is compared on
        // its real byte count instead. Deciding that here rather than unconditionally hoisting
        // directories is the point: the sort must not quietly reimpose the grouping the toggle
        // just turned off.
        if (dirsFirst && a.type === "dir" && b.type === "dir") return byName(a, b) * flip;
        // size_bytes arrives as a string (the response model sets coerce_numbers_to_str), so
        // comparing it directly would order "9" after "10" and "9 KB" after "10 MB".
        const delta = Number(a.size_bytes) - Number(b.size_bytes);
        if (Number.isFinite(delta) && delta !== 0) return delta * flip;
        return byName(a, b);
      }
      if (sortKey === "modified") {
        const aEpoch = entryEpoch(a);
        const bEpoch = entryEpoch(b);
        // An unreadable mtime sinks to the bottom in both directions rather than pretending to
        // be the oldest entry in the directory.
        if (aEpoch === null && bEpoch === null) return byName(a, b);
        if (aEpoch === null) return 1;
        if (bEpoch === null) return -1;
        if (aEpoch !== bEpoch) return (aEpoch - bEpoch) * flip;
        return byName(a, b);
      }
      return byName(a, b) * flip;
    });
    const needle = filter.trim().toLowerCase();
    return needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows;
  }, [listing, filter, sortKey, sortDir, dirsFirst]);

  const crumbs = useMemo(() => {
    const path = listing?.path ?? "";
    if (!path) return [] as Array<{ label: string; path: string }>;
    if (!path.startsWith("/")) return [{ label: path, path }];
    const out = [{ label: "/", path: "/" }];
    let accumulated = "";
    for (const part of path.split("/").filter(Boolean)) {
      accumulated += `/${part}`;
      out.push({ label: part, path: accumulated });
    }
    return out;
  }, [listing]);

  const busy = pending !== null;
  const deleting = pending?.kind === "delete";

  async function download(entry: SftpEntry) {
    setFailure(null);
    setNotice("");
    setPending({ kind: "download", label: entry.name });
    try {
      await sftpDownload(token, serverId, entry.path);
      setNotice(`Downloaded ${entry.name}. Check your browser's downloads.`);
    } catch (error) {
      const { kind, detail } = classify(error);
      setFailure({ kind, detail, path: entry.path, label: entry.name, action: "download" });
    } finally {
      setPending(null);
    }
  }

  async function copyPath(entry: SftpEntry) {
    const path = entry.path || entry.name;
    setFailure(null);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(path);
        setNotice(`Copied ${path}`);
        return;
      }
    } catch {
      // Blocked by permissions or an unfocused document — try the legacy route below.
    }
    if (legacyCopy(path)) {
      setNotice(`Copied ${path}`);
      return;
    }
    setNotice(`This browser blocked the clipboard, so here is the path to copy by hand: ${path}`);
  }

  // Composed here rather than shown verbatim from the backend, because the sentence that
  // matters to the operator is what is now gone: the full path, the count, and — for a link —
  // that the target survived.
  function deleteNotice(entry: SftpEntry, outcome: SftpDeleteResult, recursive: boolean): string {
    const path = outcome.path || entry.path || entry.name;
    const kind = outcome.deleted || entry.type;
    const count = Number(outcome.entries_removed);
    if (kind === "link") {
      return `Unlinked ${path}. Only the link was removed — whatever it pointed at is untouched.`;
    }
    if (kind === "dir") {
      if (!recursive) return `Removed the empty directory ${path}.`;
      // The count includes the directory itself, so it is quoted as a total rather than as
      // "and N files inside", which would be off by one.
      const tail = Number.isFinite(count) && count > 0 ? ` ${count} entries removed in total, counting the directory itself.` : "";
      return `Deleted ${path} and everything inside it.${tail}`;
    }
    return `Deleted ${path}.`;
  }

  async function runDelete(entry: SftpEntry, recursive: boolean) {
    const targetDir = listing?.path ?? "";
    setFailure(null);
    setNotice("");
    setPending({ kind: "delete", label: entry.name });
    let removed = false;
    // Set when a non-recursive directory delete was refused because the directory has contents.
    // That is not an error to report and walk away from, it is the point at which the operator
    // has to decide about the tree — so the dialog stays open and asks.
    let escalate = "";
    try {
      const outcome = await sftpDelete(token, serverId, entry.path, recursive);
      // Every failure on this endpoint is a 4xx and lands in the catch below, so reaching here
      // already means success. `ok` is still checked rather than assumed: the client normalises
      // an absent field to true, and an explicit false must never be read as a deletion.
      if (!outcome.ok) {
        const { kind } = classify(new Error(outcome.message));
        setFailure({
          kind,
          detail: outcome.message || "The delete failed.",
          path: outcome.path || entry.path,
          label: entry.name,
          action: "delete"
        });
        return;
      }
      setNotice(deleteNotice(entry, outcome, recursive));
      removed = true;
    } catch (error) {
      const { kind, detail } = classify(error);
      if (!recursive && entry.type === "dir" && (kind === "notempty" || kind === "needsrecursive")) {
        escalate = detail || "This directory is not empty.";
      } else {
        setFailure({ kind, detail, path: entry.path, label: entry.name, action: "delete" });
      }
    } finally {
      // The dialog closes on every outcome except the escalation: the failure banner sits behind
      // it, and an explanation the operator cannot see is not an explanation. A retry after a
      // real failure re-types the acknowledgement, which for a recursive delete is the point.
      setConfirming((current) =>
        current && escalate ? { ...current, escalated: true, typed: "", reason: escalate } : null
      );
      setPending(null);
    }
    // Refreshed outside the try so a listing failure cannot be reported as a delete failure.
    if (removed) await load(targetDir, targetDir || "home");
  }

  async function runUpload(file: File) {
    const targetDir = listing?.path ?? "";
    if (!targetDir) return;
    setFailure(null);
    setNotice("");
    setPending({ kind: "upload", label: file.name });
    let uploaded = false;
    try {
      const outcome = await sftpUpload(token, serverId, targetDir, file);
      // The backend answers HTTP 200 with ok:false on an SSH-level failure, so the body is
      // the only thing that says whether this worked.
      if (!outcome.ok) {
        const { kind } = classify(new Error(outcome.message));
        setFailure({
          kind,
          detail: outcome.message || "The upload failed.",
          path: outcome.path || `${targetDir}/${file.name}`,
          label: file.name,
          action: "upload"
        });
        return;
      }
      const written = formatBytes(outcome.bytes_written);
      setNotice(`${outcome.message || `Uploaded ${file.name}`}${written ? ` · ${written}` : ""}`);
      uploaded = true;
    } catch (error) {
      const { kind, detail } = classify(error);
      setFailure({ kind, detail, path: `${targetDir}/${file.name}`, label: file.name, action: "upload" });
    } finally {
      // Cleared through the ref, never through event.currentTarget: the event is long gone
      // by now. Resetting the value also lets the same file be picked again.
      if (uploadInput.current) uploadInput.current.value = "";
      setPending(null);
    }
    // Refresh outside the try so a listing failure cannot be reported as an upload failure.
    if (uploaded) await load(targetDir, targetDir);
  }

  function pickUpload(event: ChangeEvent<HTMLInputElement>) {
    // Read the file synchronously. React nulls currentTarget once an async handler yields,
    // so nothing may touch the event after the first await.
    const file = event.currentTarget.files?.[0] ?? null;
    if (file) void runUpload(file);
  }

  function retryFailure() {
    if (!failure) return;
    if (failure.action === "list") {
      void load(failure.path, failure.label);
      return;
    }
    setFailure(null);
  }

  // Pointer coordinates are read synchronously — the event object is not touched after any
  // await, and there is no await on this path at all.
  function openMenuAtPointer(event: ReactMouseEvent<HTMLLIElement>, entry: SftpEntry) {
    // Only the row suppresses the browser menu. The rest of the pane keeps it, including the
    // breadcrumb and the path text, where "copy" from the native menu is genuinely useful.
    event.preventDefault();
    menuOrigin.current = null;
    setNotice("");
    setMenu({ entry, x: event.clientX, y: event.clientY, placed: false });
  }

  function openMenuAtButton(event: ReactMouseEvent<HTMLButtonElement>, entry: SftpEntry) {
    const button = event.currentTarget;
    if (menu && menu.entry.path === entry.path && menuOrigin.current === button) {
      closeMenu(true);
      return;
    }
    const rect = button.getBoundingClientRect();
    menuOrigin.current = button;
    setNotice("");
    // Hangs below the button's right edge; the clamp in the layout effect pulls it back inside
    // the viewport when the row is near the bottom or the pane is docked to the right.
    setMenu({ entry, x: rect.right, y: rect.bottom + 4, placed: false });
  }

  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const node = menuRef.current;
    if (!node) return;
    if (event.key === "Tab") {
      // Tabbing out of a transient menu should dismiss it, not leave it hanging over the list.
      closeMenu(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = Array.from(node.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])'));
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = 0;
    if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % items.length;
    else if (event.key === "ArrowUp") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function askDelete(entry: SftpEntry) {
    closeMenu(false);
    setFailure(null);
    setNotice("");
    setConfirming({ entry, typed: "", escalated: false, reason: "" });
  }

  const totalLoaded = listing?.entries.length ?? 0;
  const filtered = filter.trim().length > 0;
  // A parent row, shown as the first entry so navigating up is where the eye already is:
  // in the list, not only in a toolbar button above it. Deliberately outside `entries` so no
  // sort or filter can reorder it away or hide it.
  const parentPath = listing?.parent && listing.parent !== listing.path ? listing.parent : "";

  const menuEntry = menu?.entry ?? null;
  const menuIsDir = menuEntry?.type === "dir";

  const target = confirming?.entry ?? null;
  const targetIsDir = target?.type === "dir";
  const targetIsLink = target?.type === "link";
  const targetName = target ? basename(target.path, target.name) : "";
  // True only once the first, non-recursive attempt has come back saying the directory has
  // contents. Until then the dialog does not even offer the recursive form.
  const escalated = Boolean(targetIsDir && confirming?.escalated);
  // The backend refuses a *recursive* delete of any path with fewer than two components, so this
  // blocks the escalation and not the harmless empty-directory attempt. Saying so up front beats
  // sending a request that cannot succeed.
  const targetTooShallow = Boolean(escalated && target?.path.startsWith("/") && pathDepth(target.path) < 2);
  const ackOk = !escalated || confirming?.typed.trim() === targetName;
  const canDelete = Boolean(target) && ackOk && !targetTooShallow && !busy;

  return (
    // h-full covers a parent with a definite height; flex-1 with min-h-0 covers a flex parent
    // that stretches instead. The shell workspace does both, fullscreen and not.
    <div
      className={`relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel dark:border-slate-700 dark:bg-slate-900 ${className ?? ""}`}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 dark:border-slate-700">
        <div className="flex min-w-0 items-center gap-2 font-semibold">
          <FolderSearch size={18} className="shrink-0 text-accent" />
          <span className="truncate text-sm text-ink dark:text-slate-100">Files — {hostname}</span>
          {pending?.kind === "list" ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void load(listing?.path ?? "", listing?.path || "home")}
            disabled={busy}
            title="Reload this directory"
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            <RefreshCw size={14} /> Reload
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              title="Close the file pane"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2 dark:border-slate-700">
        <button
          type="button"
          onClick={() => void load("", "home")}
          disabled={busy}
          title="Home directory of the SSH user"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <Home size={15} />
        </button>
        <button
          type="button"
          onClick={() => parentPath && void load(parentPath, parentPath)}
          disabled={busy || !parentPath}
          title={parentPath ? `Up to ${parentPath}` : "Already at the top"}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <ArrowUp size={15} />
        </button>
        {/* Type a path directly. Breadcrumb chips were here before: in a pane this narrow they
            overflowed into a horizontal scroller, which is a poor way to reach /var/log, and
            they offered no way to jump somewhere not already on screen. Home and Up plus the
            ".." row cover walking upwards, so this field is the better use of the space. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const wanted = (pathDraft ?? "").trim();
            setPathDraft(null);
            if (wanted) void load(wanted, wanted);
          }}
          className="min-w-0 flex-1"
        >
          <input
            value={pathDraft ?? listing?.path ?? ""}
            onChange={(event) => setPathDraft(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setPathDraft(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPathDraft(null);
                event.currentTarget.blur();
              }
            }}
            spellCheck={false}
            autoComplete="off"
            placeholder={pending ? "Resolving home…" : "/absolute/path"}
            aria-label="Remote path — type one and press Enter to go there"
            title="Type a path and press Enter. Escape reverts."
            className="h-8 w-full rounded-full border-none bg-slate-100 px-3 font-mono text-xs font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/60 dark:text-slate-100"
          />
        </form>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 dark:border-slate-700">
        <label className="relative flex h-8 min-w-[8rem] flex-1 items-center">
          <Search size={13} className="absolute left-2.5 text-slate-400 dark:text-slate-500" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
            placeholder="Filter these entries"
            className="h-8 w-full rounded-full border-none bg-slate-100 pl-7 pr-3 text-xs font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/60 dark:text-slate-100"
          />
        </label>
        <label
          className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-xs font-semibold text-ink transition-colors dark:border-slate-700 dark:text-slate-200 ${
            busy || !listing ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800"
          }`}
          title={listing ? `Upload into ${listing.path}` : "Waiting for a directory"}
        >
          <Upload size={14} />
          Upload here
          <input ref={uploadInput} type="file" onChange={pickUpload} disabled={busy || !listing} className="hidden" />
        </label>
        <span className="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
          {filtered ? `${entries.length} of ${totalLoaded}` : `${totalLoaded} ${totalLoaded === 1 ? "entry" : "entries"}`}
        </span>
        {listing?.truncated ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-warn dark:bg-amber-500/15 dark:text-amber-400">
            Partial
          </span>
        ) : null}
      </div>

      {/* Sorting lives in the toolbar rather than in clickable column headers because the size
          and modified columns are hidden on a narrow pane, and a sort control you cannot reach
          at the width the pane actually docks at is not a control. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3 py-2 dark:border-slate-700">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Sort
        </span>
        <div
          role="group"
          aria-label="Sort these entries by"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-slate-100 p-0.5 dark:bg-slate-800/60"
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={sortKey === key}
              onClick={() => setSortKey(key)}
              title={
                key === "modified"
                  ? "Sort by last-modified time (mtime), newest or oldest first"
                  : key === "size"
                    ? "Sort by size in bytes — directories keep name order, since their size is not shown"
                    : "Sort by name, numerically aware"
              }
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                sortKey === key
                  ? "bg-accent/10 text-accent"
                  : "text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700/70"
              }`}
            >
              {SORT_LABELS[key]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setSortDir((current) => (current === "asc" ? "desc" : "asc"))}
          title={`Currently ${directionLabel(sortKey, sortDir)} — click to reverse`}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-line px-2.5 text-[11px] font-semibold text-ink transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
          {directionLabel(sortKey, sortDir)}
        </button>
        <button
          type="button"
          aria-pressed={dirsFirst}
          onClick={() => setDirsFirst((current) => !current)}
          title={
            dirsFirst
              ? "Directories are grouped above files. Click to sort every row together instead."
              : "Every row is sorted together. Click to group directories above files."
          }
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold transition-colors ${
            dirsFirst
              ? "bg-accent/10 text-accent"
              : "border border-line text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          <Folder size={12} /> Folders first
        </button>
      </div>

      {listing?.truncated ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-warn/40 bg-warn/5 px-4 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn dark:text-amber-400" />
          <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
            <span className="font-semibold text-warn dark:text-amber-400">This listing is incomplete.</span> The directory
            holds more than the {totalLoaded}-entry cap, so entries past that point are not on this page and the filter and
            sort above only cover the {totalLoaded} that loaded. Use <code className="font-mono">ls</code> in a shell tab to
            see the rest.
          </p>
        </div>
      ) : null}

      {transferring && pending ? (
        <div className="shrink-0 border-b border-accent/40 bg-accent/5 px-4 py-2.5 dark:border-accent/40 dark:bg-accent/10">
          <div className="flex items-center gap-2.5">
            <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
            <p className="min-w-0 truncate text-xs font-semibold text-ink dark:text-slate-100">
              {pending.kind === "download" ? "Downloading" : "Uploading"} {pending.label}…
            </p>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-accent/20">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
          <p className="mt-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">
            {elapsed}s elapsed. The browser reports no byte-level progress for either direction, so this shows time, not a
            percentage. Do not close the workspace.
          </p>
        </div>
      ) : null}

      {failure ? (
        <div className="shrink-0 border-b border-danger/40 bg-danger/5 px-4 py-2.5 dark:border-red-500/40 dark:bg-red-500/10">
          <div className="flex items-start gap-2.5">
            {failure.kind === "denied" || failure.kind === "acl" ? (
              <Lock size={15} className="mt-0.5 shrink-0 text-danger dark:text-red-400" />
            ) : (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger dark:text-red-400" />
            )}
            <div className="min-w-0 space-y-1">
              <p className="break-words text-xs font-semibold text-danger dark:text-red-400">{headlineFor(failure, hostname)}</p>
              {guidanceFor(failure, hostname) ? (
                <p className="text-[11px] font-medium text-slate-700 dark:text-slate-300">{guidanceFor(failure, hostname)}</p>
              ) : null}
              {/* A guard refusal carries its reason in the message text and nowhere else, so it
                  is shown verbatim alongside the generic advice. */}
              {failure.detail && (failure.kind === "unknown" || failure.kind === "refused") ? (
                <p className="break-all font-mono text-[11px] text-slate-600 dark:text-slate-400">{failure.detail}</p>
              ) : null}
              {failure.path ? (
                <p className="break-all font-mono text-[11px] text-slate-500 dark:text-slate-400">{failure.path}</p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={retryFailure}
                  disabled={busy}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  {failure.action === "list" ? <><RefreshCw size={12} /> Retry</> : <><X size={12} /> Dismiss</>}
                </button>
                {failure.action === "list" ? (
                  <button
                    type="button"
                    onClick={() => void load("", "home")}
                    disabled={busy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <Home size={12} /> Home
                  </button>
                ) : null}
                {/* A delete that failed leaves the listing untouched, and the entry may or may
                    not still be there. Offer the reload explicitly rather than making the
                    operator hunt for it. */}
                {failure.action === "delete" ? (
                  <button
                    type="button"
                    onClick={() => void load(listing?.path ?? "", listing?.path || "home")}
                    disabled={busy}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-[11px] font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    <RefreshCw size={12} /> Reload directory
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-accent/40 bg-accent/5 px-4 py-2 dark:border-accent/40 dark:bg-accent/10">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" />
          <p className="min-w-0 break-words text-xs font-medium text-slate-700 dark:text-slate-300">{notice}</p>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="ml-auto shrink-0 text-slate-400 transition-colors hover:text-ink dark:hover:text-slate-100"
          >
            <X size={13} />
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!listing && failure ? (
          <p className="px-4 py-6 text-xs font-medium text-slate-500 dark:text-slate-400">
            Nothing is loaded. Fix the problem above, then retry.
          </p>
        ) : !listing ? (
          <p className="px-4 py-6 text-xs font-medium text-slate-500 dark:text-slate-400">Opening the home directory…</p>
        ) : entries.length === 0 && !parentPath ? (
          <p className="px-4 py-6 text-xs font-medium text-slate-500 dark:text-slate-400">
            {filtered
              ? `Nothing here matches “${filter.trim()}”.`
              : totalLoaded === 0
                ? "This directory is empty."
                : "Nothing to show."}
          </p>
        ) : (
          <ul className="divide-y divide-line dark:divide-slate-800">
            {/* Outside `entries` on purpose: it stays pinned to the top whatever the sort
                says, and no filter can hide the way out of a directory. Rendered even when the
                directory is empty, which is exactly when being stuck matters most. */}
            {parentPath ? (
              <li>
                <button
                  type="button"
                  onClick={() => void load(parentPath, parentPath)}
                  disabled={busy}
                  title={`Up to ${parentPath}`}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-slate-800/60"
                >
                  <CornerLeftUp size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
                  <span className="shrink-0 font-mono text-xs font-semibold text-slate-600 dark:text-slate-300">..</span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-slate-400 dark:text-slate-500">{parentPath}</span>
                </button>
              </li>
            ) : null}
            {entries.length === 0 ? (
              <li className="px-4 py-4 text-xs font-medium text-slate-500 dark:text-slate-400">
                {filtered
                  ? `Nothing here matches “${filter.trim()}”.`
                  : totalLoaded === 0
                    ? "This directory is empty."
                    : "Nothing to show."}
              </li>
            ) : null}
            {entries.map((entry) => {
              const isDir = entry.type === "dir";
              const isLink = entry.type === "link";
              const rowBusy = pending?.kind !== "list" && pending?.label === entry.name;
              const size = isDir ? "" : formatBytes(entry.size_bytes);
              const menuOpenHere = menuEntry?.path === entry.path;
              return (
                <li
                  key={entry.path || entry.name}
                  onContextMenu={(event) => openMenuAtPointer(event, entry)}
                  className={`flex items-center gap-1 px-2 hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                    menuOpenHere ? "bg-slate-100 dark:bg-slate-800/70" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => (isDir || isLink ? void load(entry.path, entry.name) : void download(entry))}
                    disabled={busy}
                    title={isDir ? `Open ${entry.path}` : isLink ? `Open ${entry.path} — download it instead if it is a file` : `Download ${entry.path}`}
                    className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-1 pr-2 text-left disabled:opacity-60"
                  >
                    {rowBusy ? (
                      <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
                    ) : isDir ? (
                      <Folder size={15} className="shrink-0 text-accent" />
                    ) : isLink ? (
                      <Link2 size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
                    ) : (
                      <FileIcon size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink dark:text-slate-100">
                      {entry.name}
                      {isDir ? "/" : ""}
                    </span>
                    {size ? (
                      <span className="hidden shrink-0 text-[11px] font-medium tabular-nums text-slate-500 sm:block dark:text-slate-400">
                        {size}
                      </span>
                    ) : null}
                    {entry.modified ? (
                      <span className="hidden shrink-0 text-[11px] font-medium text-slate-400 lg:block dark:text-slate-500">
                        {entry.modified}
                      </span>
                    ) : null}
                    {entry.mode ? (
                      <span className="hidden shrink-0 font-mono text-[11px] text-slate-400 xl:block dark:text-slate-500">
                        {entry.mode}
                      </span>
                    ) : null}
                  </button>
                  {isDir ? (
                    <ChevronRight size={14} className="shrink-0 text-slate-300 dark:text-slate-600" />
                  ) : isLink ? (
                    // A link's target type is not known from the listing, so offer both: the
                    // row opens it, this downloads it. Whichever is wrong fails recoverably.
                    <button
                      type="button"
                      onClick={() => void download(entry)}
                      disabled={busy}
                      title={`Download ${entry.path}`}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-accent disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800"
                    >
                      <Download size={13} />
                    </button>
                  ) : (
                    <Download size={13} className="shrink-0 text-slate-300 dark:text-slate-600" />
                  )}
                  {/* Right-click is not reachable by keyboard, touch, or a screen reader, so the
                      same menu hangs off a real button that sits in the tab order. */}
                  <button
                    type="button"
                    aria-label={`Actions for ${entry.name}`}
                    aria-haspopup="menu"
                    aria-expanded={menuOpenHere}
                    onClick={(event) => openMenuAtButton(event, entry)}
                    title={`Actions for ${entry.name}`}
                    className={`mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-slate-200 hover:text-ink focus-visible:bg-slate-200 dark:hover:bg-slate-700 dark:hover:text-slate-100 dark:focus-visible:bg-slate-700 ${
                      menuOpenHere ? "bg-slate-200 text-ink dark:bg-slate-700 dark:text-slate-100" : "text-slate-400 dark:text-slate-500"
                    }`}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Both overlays are rendered inside this component rather than portalled to document.body
          on purpose: when the workspace is in real element fullscreen, only descendants of the
          fullscreen element are painted, so a portalled dialog would be invisible. The z-index
          clears the workspace's own fullscreen overlay (z-50) and the detail page's (z-[100]). */}
      {menu && menuEntry ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Actions for ${menuEntry.name}`}
          onKeyDown={onMenuKeyDown}
          style={{ left: menu.x, top: menu.y, visibility: menu.placed ? "visible" : "hidden" }}
          className="fixed z-[110] min-w-[11rem] overflow-hidden rounded-2xl border border-line bg-panel py-1 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <p className="truncate px-3 py-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400" title={menuEntry.path}>
            {menuEntry.name}
          </p>
          <button
            type="button"
            role="menuitem"
            disabled={busy || menuIsDir}
            onClick={() => {
              const entry = menuEntry;
              closeMenu(false);
              void download(entry);
            }}
            title={menuIsDir ? "A directory cannot be downloaded — open it and download the files inside" : `Download ${menuEntry.path}`}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <Download size={13} className="shrink-0 text-slate-400 dark:text-slate-500" /> Download
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => askDelete(menuEntry)}
            title={`Delete ${menuEntry.path}`}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            <Trash2 size={13} className="shrink-0" /> Delete…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const entry = menuEntry;
              closeMenu(true);
              void copyPath(entry);
            }}
            title={menuEntry.path}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-ink transition-colors hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800"
          >
            <Copy size={13} className="shrink-0 text-slate-400 dark:text-slate-500" /> Copy path
          </button>
        </div>
      ) : null}

      {confirming && target ? (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/50 p-4 dark:bg-slate-950/70"
          onMouseDown={(event) => {
            // Backdrop only, and never while the request is in flight.
            if (event.target === event.currentTarget && !deleting) setConfirming(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sftp-delete-title"
            className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3 dark:border-slate-700">
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger dark:bg-red-500/15 dark:text-red-400">
                <Trash2 size={14} />
              </span>
              <h2 id="sftp-delete-title" className="min-w-0 text-sm font-semibold text-ink dark:text-slate-100">
                {escalated
                  ? "Delete this directory and everything in it?"
                  : targetIsDir
                    ? "Delete this directory?"
                    : targetIsLink
                      ? "Delete this symlink?"
                      : "Delete this file?"}
              </h2>
            </div>

            {/* Scrolls internally so a long path plus the acknowledgement still fit inside a
                short workspace. */}
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Full path on {hostname}
                </p>
                {/* The absolute path, not the basename: an operator who navigated somewhere
                    unexpected has to be able to see where they actually are before agreeing. */}
                <p className="mt-1 break-all rounded-2xl bg-slate-100 px-3 py-2 font-mono text-xs font-semibold text-ink dark:bg-slate-800/60 dark:text-slate-100">
                  {target.path || target.name}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                  {targetIsDir ? "Directory" : targetIsLink ? "Symlink" : "File"}
                </span>
                {!targetIsDir && formatBytes(target.size_bytes) ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {formatBytes(target.size_bytes)}
                  </span>
                ) : null}
                {target.modified ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    modified {target.modified}
                  </span>
                ) : null}
                {target.mode ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {target.mode}
                  </span>
                ) : null}
              </div>

              <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {targetIsLink ? (
                  <>
                    <span className="font-semibold text-ink dark:text-slate-100">Only the link itself is removed.</span> Its
                    target is left exactly where it is — deleting a symlink unlinks the link and never touches, follows or
                    empties whatever it points at.
                  </>
                ) : escalated ? (
                  <>
                    <span className="font-semibold text-ink dark:text-slate-100">
                      Everything inside this directory goes with it,
                    </span>{" "}
                    at every depth. Symlinks found inside are unlinked rather than followed, so files outside this tree are
                    not touched.
                  </>
                ) : targetIsDir ? (
                  <>
                    This asks {hostname} to remove the directory{" "}
                    <span className="font-semibold text-ink dark:text-slate-100">only if it is empty</span>. If anything is
                    inside it, nothing is deleted and this dialog will come back and ask about the contents — so this button
                    on its own cannot remove a tree.
                  </>
                ) : (
                  <>
                    This removes the file from {hostname}. Nothing else on the host is touched.
                  </>
                )}
              </p>

              <p className="text-xs font-medium text-danger dark:text-red-400">
                This runs as the stored SSH user with that user&apos;s full rights. It happens immediately, there is no trash
                on the remote host, and nothing in this product can undo it.
              </p>

              {escalated && confirming.reason ? (
                <div className="flex items-start gap-2 rounded-2xl border border-warn/40 bg-warn/5 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn dark:text-amber-400" />
                  <div className="min-w-0 space-y-1">
                    <p className="text-[11px] font-semibold text-warn dark:text-amber-400">
                      This directory is not empty, so nothing has been deleted yet.
                    </p>
                    <p className="break-words font-mono text-[11px] text-slate-600 dark:text-slate-400">{confirming.reason}</p>
                  </div>
                </div>
              ) : null}

              {targetTooShallow ? (
                <div className="flex items-start gap-2 rounded-2xl border border-warn/40 bg-warn/5 px-3 py-2 dark:border-amber-500/30 dark:bg-amber-500/10">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn dark:text-amber-400" />
                  <p className="text-[11px] font-medium text-slate-700 dark:text-slate-300">
                    <span className="font-semibold text-warn dark:text-amber-400">This one is blocked.</span> A recursive
                    delete needs at least two path components, so a top-level directory like this cannot be removed from the
                    file pane. Use a shell tab if it really has to go.
                  </p>
                </div>
              ) : escalated ? (
                // A checkbox next to a confirm button is two clicks in the same place; typing
                // the name cannot be reached by a stray double-click or a held Enter key.
                <label className="block">
                  <span className="text-[11px] font-semibold text-ink dark:text-slate-100">
                    Type{" "}
                    <code className="rounded bg-slate-100 px-1 font-mono text-[11px] text-danger dark:bg-slate-800 dark:text-red-400">
                      {targetName}
                    </code>{" "}
                    to confirm the recursive delete
                  </span>
                  <input
                    value={confirming.typed}
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    disabled={deleting}
                    onChange={(event) => {
                      const typed = event.target.value;
                      setConfirming((current) => (current ? { ...current, typed } : current));
                    }}
                    placeholder={targetName}
                    className="mt-1.5 h-8 w-full rounded-full border border-line bg-slate-50 px-3 font-mono text-xs text-ink outline-none transition-colors focus:ring-2 focus:ring-danger disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100"
                  />
                </label>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 dark:border-slate-700">
              <button
                ref={cancelRef}
                type="button"
                onClick={() => setConfirming(null)}
                disabled={deleting}
                className="inline-flex h-8 items-center rounded-full bg-slate-100 px-4 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void runDelete(target, escalated)}
                disabled={!canDelete}
                title={
                  targetTooShallow
                    ? "Blocked: a recursive delete needs at least two path components"
                    : ackOk
                      ? `Delete ${target.path}`
                      : `Type ${targetName} above to enable this`
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-danger px-4 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-red-600"
              >
                {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                {deleting
                  ? "Deleting…"
                  : escalated
                    ? "Delete directory and contents"
                    : targetIsDir
                      ? "Remove if empty"
                      : targetIsLink
                        ? "Delete link"
                        : "Delete file"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
