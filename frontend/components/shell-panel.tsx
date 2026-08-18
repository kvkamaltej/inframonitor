"use client";

import {
  ChevronDown,
  Columns2,
  Copy,
  FolderOpen,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Plus,
  Star,
  TerminalSquare,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ShellFavorites } from "@/components/shell-favorites";
import { SftpPanel } from "@/components/sftp-panel";
import { shellHandshake, shellSocketUrl } from "@/lib/api";
import { currentTheme, termPalette, THEME_EVENT, type ThemeName } from "@/lib/theme";
// xterm's stylesheet must be bundled; the CSP forbids fetching it from a CDN
import "@xterm/xterm/css/xterm.css";

type Phase = "connecting" | "open" | "closed" | "error";

type SessionStatus = {
  phase: Phase;
  detail: string;
  code: number | null;
};

type SessionInfo = {
  // stable per tab and unrelated to serverId: several tabs may share one host
  key: string;
  serverId: string;
  hostname: string;
  username: string;
  label: string;
};

// Which sessions are on screen. "single" shows the focused tab; "split" shows exactly two,
// and the focused one is always one of them — keystrokes only ever reach one terminal, so
// the pair on screen and the keyboard target must not be able to disagree.
type Layout = { mode: "single" } | { mode: "split"; keys: [string, string] };

// Fullscreen has two implementations and the button label must never claim one we are not
// in. "native" is the real Fullscreen API (covers the *screen*); "overlay" is the older
// fixed-inset fallback (covers the viewport, so browser chrome still eats ~55px) used when
// requestFullscreen is missing or its promise rejects.
type FullscreenMode = "off" | "native" | "overlay";

// An open tab context menu, already clamped to the viewport.
type TabMenu = { key: string; x: number; y: number };

// The imperative handle a mounted terminal exposes to the workspace. Everything the
// workspace needs to do to a session (refit it, focus it, type into it, hang it up) goes
// through this rather than through props, so that nothing about a session's React tree
// changes when it is merely hidden.
type SessionApi = {
  fit: () => void;
  focus: () => void;
  insert: (text: string) => void;
  run: (text: string) => void;
  close: () => void;
};

// A host a new tab can be opened against. Structurally a subset of api.ts's `Server`, so
// callers can hand the inventory rows straight in.
export type ShellTarget = {
  id: string;
  hostname: string;
  username: string;
  has_credentials?: boolean;
};

const TAB_TONES: Record<Phase, string> = {
  connecting: "bg-amber-400",
  open: "bg-accent",
  closed: "bg-slate-400 dark:bg-slate-500",
  error: "bg-danger dark:bg-red-500"
};

const PHASE_TEXT: Record<Phase, string> = {
  connecting: "text-slate-500 dark:text-slate-400",
  open: "text-accent",
  closed: "text-slate-500 dark:text-slate-400",
  error: "text-danger dark:text-red-400"
};

// The tab menu is positioned with `fixed` coordinates, so it has to be clamped at open time
// or a chip near the right edge of the strip opens a menu that runs off screen. Its extent
// is pinned rather than measured: the width is set explicitly below and the item list is at
// most five rows, so both bounds are known without a layout read (a measure-then-correct
// pass would need useLayoutEffect, which warns during the static export's prerender).
const MENU_WIDTH = 224;
const MENU_MAX_HEIGHT = 230;
const MENU_MARGIN = 8;

// Tabs are labelled by hostname, with duplicates disambiguated as "ems-41 (2)". Labels are
// assigned once at creation and stored on the tab, so closing an earlier tab does not
// renumber the ones the operator is still looking at.
function nextLabel(hostname: string, existing: SessionInfo[]): string {
  const base = (hostname || "host").trim() || "host";
  const taken = new Set(existing.map((session) => session.label));
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

// 4401/4403/4404/4429/4500 are our own close codes and the reason carries the message. 4429
// covers two different refusals now that the backend caps sessions per user (8) as well as
// globally (24), so say which one happened and what to do about it.
function closeSummary(code: number, reason: string): string {
  const trimmed = (reason || "").trim();
  const suffix = trimmed ? `: ${trimmed}` : "";
  if (code === 4429) {
    if (/user|your|you\b/i.test(trimmed)) {
      return `Session limit reached (4429)${suffix}. You already have the maximum of 8 shell sessions open — close one of your tabs and try again.`;
    }
    if (/capacity|global|server/i.test(trimmed)) {
      return `Session limit reached (4429)${suffix}. The server is at its capacity of 24 shell sessions — try again shortly.`;
    }
    return `Session limit reached (4429)${suffix}. The limit is 8 shell sessions per user and 24 across the server — close a tab and try again.`;
  }
  if (code === 4401) return `Authentication failed (4401)${suffix}`;
  if (code === 4403) return `Admin role required (4403)${suffix}`;
  if (code === 4404) return `Server unavailable (4404)${suffix}`;
  if (code === 4500) return `SSH connection failed (4500)${suffix}`;
  if (code === 1000 || code === 1001) return trimmed ? `Session closed: ${trimmed}` : "Session closed.";
  return `Session closed (${code})${suffix}`;
}

// One live PTY. xterm is imported dynamically inside the effect for two reasons: it touches
// `window` at module scope (which breaks the static export's prerender), and it keeps
// ~250 kB out of the bundle for everyone who never opens a shell.
//
// This component mounts once per tab and is NEVER unmounted while its tab exists — hiding a
// tab is a CSS change on the wrapper, not a conditional render — because unmounting disposes
// the terminal (losing the scrollback) and drops the websocket (losing the session).
function ShellSessionView({
  sessionKey,
  token,
  serverId,
  onStatus,
  onSelection,
  register
}: {
  sessionKey: string;
  token: string;
  serverId: string;
  onStatus: (key: string, status: SessionStatus) => void;
  onSelection: (key: string, text: string) => void;
  register: (key: string, api: SessionApi | null) => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef(onStatus);
  const selectionRef = useRef(onSelection);
  const registerRef = useRef(register);

  useEffect(() => {
    statusRef.current = onStatus;
    selectionRef.current = onSelection;
    registerRef.current = register;
  }, [onStatus, onSelection, register]);

  // Deliberately depends on nothing that changes for the life of the tab: sessionKey,
  // serverId and token are fixed per session, so this effect runs exactly once and the
  // socket survives every re-render of the workspace above it.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;
    // typed loosely on purpose: the concrete xterm types are only available after the
    // dynamic import resolves, and pinning them here would force a top-level import
    let term: { dispose: () => void } | null = null;
    let observer: ResizeObserver | null = null;
    let frame = 0;
    let timer = 0;
    // Live re-theme handler, registered once the terminal exists and removed on dispose.
    // Declared in the effect scope so the cleanup below can detach it even though it is
    // assigned inside the async start().
    let onThemeChange: ((event: Event) => void) | null = null;

    async function start() {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !mountRef.current) return;

      const terminal = new Terminal({
        convertEol: false,
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        // The palette is no longer hardcoded: it is derived from the active named theme so
        // the terminal matches the rest of the UI. A new session reads whatever theme is
        // live at creation time; the listener below live-re-themes an already-open session
        // when the operator switches themes.
        theme: termPalette(currentTheme()),
        scrollback: 5000
      });
      // Nice-to-have: repaint an open terminal on a theme switch. `terminal.options.theme`
      // is xterm's supported way to swap the palette after construction.
      onThemeChange = (event: Event) => {
        const name = (event as CustomEvent<{ name: ThemeName }>).detail?.name;
        if (name) terminal.options.theme = termPalette(name);
      };
      document.documentElement.addEventListener(THEME_EVENT, onThemeChange);
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(mountRef.current);
      term = terminal;

      // A fit() against a zero-sized box computes a nonsense geometry and corrupts the
      // render, so refuse to fit until the wrapper actually has a box. Hidden tabs use
      // `visibility:hidden`, which keeps their layout, so a background tab still measures
      // correctly; this guard is for the window being minimised or the panel collapsed.
      function fitNow() {
        const element = mountRef.current;
        if (!element || element.clientWidth < 8 || element.clientHeight < 8) return;
        try {
          fitAddon.fit();
        } catch {
          return;
        }
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ r: [terminal.cols, terminal.rows] }));
        }
      }

      // Every fit is deferred out of the current tick, so it always runs after the browser
      // has applied the layout that triggered it (tab switch, split, fullscreen toggle, side
      // pane opening) rather than while the old box is still current. Both an animation frame
      // and a short timer are armed and the first to fire wins: rAF is the right moment when
      // the page is visible, but it is suspended entirely while the browser tab is hidden,
      // and a resize that happens there must not stay unapplied.
      function scheduleFit() {
        if (frame || timer) return;
        const run = () => {
          if (frame) window.cancelAnimationFrame(frame);
          if (timer) window.clearTimeout(timer);
          frame = 0;
          timer = 0;
          fitNow();
        };
        frame = window.requestAnimationFrame(run);
        timer = window.setTimeout(run, 120);
      }

      fitNow();

      socket = new WebSocket(shellSocketUrl(serverId));

      socket.onopen = () => {
        if (disposed) return;
        socket?.send(shellHandshake(token, terminal.cols, terminal.rows));
        statusRef.current(sessionKey, { phase: "open", detail: "", code: null });
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        terminal.write(typeof event.data === "string" ? event.data : "");
      };
      socket.onerror = () => {
        if (disposed) return;
        statusRef.current(sessionKey, { phase: "error", detail: "The shell connection failed.", code: null });
      };
      // Closing the tab closes this socket, which fires this handler after the terminal has
      // been disposed; writing to a disposed terminal throws, and the tab is gone anyway.
      socket.onclose = (event) => {
        if (disposed) return;
        const summary = closeSummary(event.code, event.reason);
        // one of our own 44xx refusals is a failure even if onerror never fired
        const phase: Phase = event.code >= 4400 ? "error" : "closed";
        statusRef.current(sessionKey, { phase, detail: summary, code: event.code });
        terminal.write(`\r\n\x1b[33m*** ${summary} ***\x1b[0m\r\n`);
      };

      terminal.onData((data: string) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ d: data }));
      });
      terminal.onSelectionChange(() => selectionRef.current(sessionKey, terminal.getSelection()));

      // Covers everything that changes this terminal's box: window resizes, entering and
      // leaving fullscreen or split, the side pane opening, and the tab becoming visible.
      observer = new ResizeObserver(() => scheduleFit());
      observer.observe(mountRef.current);

      registerRef.current(sessionKey, {
        fit: scheduleFit,
        focus: () => terminal.focus(),
        // Favourites insert without executing, so trailing newlines are stripped: the user
        // presses Enter themselves. Interior newlines are left alone — a genuinely
        // multi-line command needs them and silently rewriting the text would be worse.
        insert: (text: string) => {
          const payload = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
          if (!payload) return;
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ d: payload }));
          terminal.focus();
        },
        // The explicit, opt-in counterpart to insert: the same keystrokes plus the Return the
        // user would have pressed.
        run: (text: string) => {
          const payload = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
          if (!payload) return;
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ d: `${payload}\r` }));
          terminal.focus();
        },
        close: () => {
          try {
            socket?.close();
          } catch {
            /* already closing */
          }
        }
      });
    }

    void start().catch((error) => {
      statusRef.current(sessionKey, {
        phase: "error",
        detail: error instanceof Error ? error.message : "Unable to start the terminal",
        code: null
      });
    });

    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
      if (onThemeChange) document.documentElement.removeEventListener(THEME_EVENT, onThemeChange);
      observer?.disconnect();
      registerRef.current(sessionKey, null);
      try {
        socket?.close();
      } catch {
        /* already closing */
      }
      term?.dispose();
    };
  }, [sessionKey, serverId, token]);

  return <div ref={mountRef} className="h-full w-full" />;
}

const SPLIT_RATIO_KEY = "inframonitor-shell-split-ratio";
const PANE_RATIO_KEY = "inframonitor-shell-pane-ratio";
const PANE_SIDE_KEY = "inframonitor-shell-pane-side";
// Keep both panes usable: below this a terminal is too narrow to read and the file pane
// cannot show a path. Also what stops a drag to the edge from "losing" a pane entirely.
const MIN_FRACTION = 0.15;
const MAX_FRACTION = 0.85;

function readSide(): "left" | "right" {
  if (typeof window === "undefined") return "right";
  try {
    return window.localStorage.getItem(PANE_SIDE_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

function readRatio(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = Number(window.localStorage.getItem(key));
    if (Number.isFinite(raw) && raw >= MIN_FRACTION && raw <= MAX_FRACTION) return raw;
  } catch {
    // private mode or a blocked origin: fall through to the default
  }
  return fallback;
}

function writeRatio(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // a lost divider position is not worth surfacing an error for
  }
}

// Draggable divider.
//
// Dragging is deliberately NOT React state. Every pointermove used to setState (re-rendering
// the whole workspace) and call xterm's fit() on every session, which also sends an SSH
// window-resize frame per frame — three expensive things at pointer rate, which is what made
// the drag stutter. Now a move only writes a CSS custom property on the container, which the
// browser resolves without React or a terminal reflow. State, persistence and a single refit
// happen once, on release.
//
// `containerRef` is passed explicitly rather than read from `parentElement`: the split divider
// lives inside a narrow absolutely-positioned wrapper, so the parent's box was 11px wide and
// `offset / span` produced fractions far outside 0..1 that clamped to the extremes — the
// divider jumped to one end instead of following the pointer.
function Divider({
  orientation,
  value,
  min,
  max,
  containerRef,
  onPreview,
  onCommit,
  onNudge,
  onReset,
  label
}: {
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  containerRef: React.RefObject<HTMLElement | null>;
  // called at pointer rate; must stay cheap (CSS only, no state, no fit)
  onPreview: (next: number) => void;
  onCommit: (next: number) => void;
  // relative: several keydowns can land in one React batch, and anything computed from the
  // `value` prop would then apply the same absolute result several times
  onNudge: (delta: number) => void;
  onReset: () => void;
  label: string;
}) {
  const isVertical = orientation === "vertical";
  const clamp = (next: number) => Math.min(max, Math.max(min, next));

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // ignore secondary buttons so a right-click near the handle does not start a drag
    if (event.button !== 0) return;
    const host = containerRef.current;
    if (!host) return;
    const box = host.getBoundingClientRect();
    const span = isVertical ? box.width : box.height;
    if (span <= 0) return;

    const handle = event.currentTarget;
    // Capture keeps the drag alive when the pointer crosses the terminal, but it is an
    // optimisation, not a requirement — the window listeners below do the actual work. It
    // throws for a pointerId the browser does not recognise, and letting that propagate
    // aborted the whole drag before a single listener was attached.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // no capture; the window listeners still track the pointer
    }
    document.body.style.userSelect = "none";
    document.body.style.cursor = isVertical ? "col-resize" : "row-resize";

    let latest = value;
    const fromEvent = (moveEvent: PointerEvent) => {
      const offset = isVertical ? moveEvent.clientX - box.left : moveEvent.clientY - box.top;
      return clamp(offset / span);
    };
    // Write the custom property straight from the move handler. An earlier version
    // coalesced these through requestAnimationFrame, which looked like a sensible
    // micro-optimisation and instead broke the drag outright wherever rAF is throttled or
    // suspended (a background or non-compositing tab): the callback never ran, so the
    // divider never moved. Setting one custom property is cheap and the browser already
    // coalesces the resulting style recalculation, so there was nothing to win here.
    const move = (moveEvent: PointerEvent) => {
      latest = fromEvent(moveEvent);
      onPreview(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        // already released
      }
      onCommit(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const back = isVertical ? "ArrowLeft" : "ArrowUp";
    const forward = isVertical ? "ArrowRight" : "ArrowDown";
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === back) {
      event.preventDefault();
      onNudge(-step);
    } else if (event.key === forward) {
      event.preventDefault();
      onNudge(step);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onCommit(event.key === "Home" ? min : max);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onReset();
    }
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      tabIndex={0}
      title={`${label} — drag, or arrow keys to nudge, Enter to reset`}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      // The cross-axis size must be explicit: without `h-full` a vertical divider inside a
      // column-flex wrapper got its width and zero height, so it was invisible.
      className={`group relative z-20 shrink-0 self-stretch touch-none rounded-full bg-slate-300 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none dark:bg-slate-600 ${
        isVertical ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"
      }`}
    >
      {/* visible line stays 4px so it does not eat layout, but the grab target is 11px: a
          4px hit area is measurably hard to hit and feels broken */}
      <span
        aria-hidden
        className={`absolute ${isVertical ? "inset-y-0 -left-1.5 -right-1.5" : "inset-x-0 -top-1.5 -bottom-1.5"}`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute rounded-full bg-white opacity-90 shadow-sm transition-opacity dark:bg-slate-900 ${
          isVertical
            ? "left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2"
            : "left-1/2 top-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2"
        }`}
      />
    </div>
  );
}

// Tabbed shell workspace. `serverId`/`hostname`/`username` seed the first tab, which keeps
// the original single-session call signature working; `servers` is optional and only enables
// the new-tab host picker.
export function ShellPanel({
  token,
  serverId,
  hostname,
  username,
  onClose,
  servers,
  initialCommand,
  initialFullscreen
}: {
  token: string;
  serverId: string;
  hostname: string;
  username: string;
  onClose: () => void;
  servers?: ShellTarget[];
  // Optional command run once on the FIRST session as soon as its shell is live. Used to drop
  // straight into a container ("docker exec -it <name> sh"); typed as a real keystroke so the
  // operator can Ctrl-C back out to the host shell afterwards.
  initialCommand?: string;
  // Open straight into fullscreen. Used by the sidebar shell launcher, which lands here after a
  // navigation (no user gesture), so we take the overlay fullscreen path rather than the native
  // Fullscreen API, which would reject without a gesture.
  initialFullscreen?: boolean;
}) {
  const counter = useRef(0);
  const apis = useRef(new Map<string, SessionApi>());
  const activeKeyRef = useRef("");
  // The element handed to requestFullscreen, and the one `fullscreenchange` is checked
  // against so another component's fullscreen never moves our button label.
  const frameRef = useRef<HTMLDivElement | null>(null);

  function makeSession(target: ShellTarget, existing: SessionInfo[]): SessionInfo {
    counter.current += 1;
    return {
      key: `s${counter.current}`,
      serverId: target.id,
      hostname: target.hostname,
      username: target.username,
      label: nextLabel(target.hostname, existing)
    };
  }

  // The tab list is mirrored in a ref so that adding or closing a tab can compute the next
  // list (and the next label) outside a state updater: makeSession bumps a counter, and an
  // impure updater would be run twice under StrictMode and hand out two different keys.
  const [initialSession] = useState(() => makeSession({ id: serverId, hostname, username }, []));
  const sessionsRef = useRef<SessionInfo[]>([initialSession]);
  const [sessions, setSessions] = useState<SessionInfo[]>([initialSession]);
  const [activeKey, setActiveKey] = useState(initialSession.key);
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [fsMode, setFsMode] = useState<FullscreenMode>("off");
  const [pane, setPane] = useState<"none" | "files" | "favorites">("none");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const [layout, setLayout] = useState<Layout>({ mode: "single" });
  const [menu, setMenu] = useState<TabMenu | null>(null);
  // Divider positions, as a fraction of the container. Read from localStorage lazily so the
  // first paint already has the operator's last choice rather than snapping after hydration.
  const [splitRatio, setSplitRatio] = useState(() => readRatio(SPLIT_RATIO_KEY, 0.5));
  const [paneRatio, setPaneRatio] = useState(() => readRatio(PANE_RATIO_KEY, 0.32));
  // Mirrors of the two ratios. Every writer goes through these setters so that a commit
  // persists the value currently on screen: reading the state variable inside onCommit
  // captured the previous render's number and saved a stale position.
  const splitRatioRef = useRef(splitRatio);
  const paneRatioRef = useRef(paneRatio);
  const setSplit = useCallback((next: number) => {
    const value = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, next));
    splitRatioRef.current = value;
    setSplitRatio(value);
  }, []);
  const setPane2 = useCallback((next: number) => {
    const value = Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, next));
    paneRatioRef.current = value;
    setPaneRatio(value);
  }, []);
  // Which side of the terminal the file/favorites pane sits on. Stacked layouts read it as
  // top/bottom, since "left" has no meaning when the row wraps to a column.
  const [paneSide, setPaneSide] = useState<"left" | "right">(readSide);
  const paneSideRef = useRef(paneSide);
  // The elements whose box defines each drag axis, and whose CSS variables the drag writes.
  const bodyRowRef = useRef<HTMLDivElement | null>(null);
  const terminalBoxRef = useRef<HTMLDivElement | null>(null);
  const [isWide, setIsWide] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches);

  // Layout is mirrored for the same reason the session list is: closing a tab and opening
  // one both need to read the current split outside a state updater.
  const layoutRef = useRef<Layout>({ mode: "single" });
  const menuOpenRef = useRef(false);
  const visibleKeysRef = useRef<string[]>([]);

  function applyLayout(next: Layout) {
    layoutRef.current = next;
    setLayout(next);
  }

  // Rendering keys off the resolved session rather than raw state guarantees exactly one
  // focused terminal even if activeKey ever refers to a tab that is gone.
  const resolved = sessions.find((session) => session.key === activeKey) ?? sessions[0] ?? null;
  // A split is only a split while *both* of its sessions still exist. Deriving that from
  // the live session list (rather than trusting `layout`) means a closed tab can never leave
  // an empty pane on screen for the render between the close and the normalising effect.
  const splitKeys = layout.mode === "split" ? layout.keys.filter((key) => sessions.some((session) => session.key === key)) : [];
  const inSplit = splitKeys.length === 2;
  // Keystrokes reach exactly one terminal, so the focused key must be one of the visible
  // ones; if a stale activeKey says otherwise, the left-hand pane wins for this render and
  // the effect below converges the state.
  const focusedKey = inSplit && !splitKeys.includes(resolved?.key ?? "") ? splitKeys[0] : resolved?.key ?? "";
  const activeSession = sessions.find((session) => session.key === focusedKey) ?? resolved;
  activeKeyRef.current = focusedKey;
  visibleKeysRef.current = inSplit ? splitKeys : focusedKey ? [focusedKey] : [];
  menuOpenRef.current = menu !== null;

  useEffect(() => {
    if (focusedKey && focusedKey !== activeKey) setActiveKey(focusedKey);
  }, [focusedKey, activeKey]);

  // A split whose partner has gone away is no longer a split. closeSession already handles
  // the ordinary case; this converges the stored layout for anything else that can drop a
  // session (a refused handshake never removes a tab, but a future path might).
  const splitSignature = splitKeys.join(">");
  useEffect(() => {
    if (layoutRef.current.mode === "split" && splitSignature.split(">").filter(Boolean).length !== 2) {
      applyLayout({ mode: "single" });
    }
  }, [splitSignature]);

  const handleStatus = useCallback((key: string, status: SessionStatus) => {
    setStatuses((current) => ({ ...current, [key]: status }));
  }, []);

  // Open in fullscreen when asked (sidebar launcher). No user gesture is available after a
  // navigation, so the native Fullscreen API would reject — go straight to the overlay path,
  // which covers the viewport without a gesture. Runs once on mount.
  useEffect(() => {
    if (initialFullscreen) setFsMode("overlay");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run initialCommand once, the moment the first session's shell is live. A short delay lets
  // the remote login shell print its prompt first, so the command is not swallowed mid-banner.
  const initialSentRef = useRef(false);
  useEffect(() => {
    if (!initialCommand || initialSentRef.current) return;
    if (statuses[initialSession.key]?.phase !== "open") return;
    const api = apis.current.get(initialSession.key);
    if (!api) return;
    initialSentRef.current = true;
    const timer = window.setTimeout(() => api.run(initialCommand), 300);
    return () => window.clearTimeout(timer);
  }, [statuses, initialCommand, initialSession.key]);

  // Selection feeds the favourites pane, so accept it from either visible pane in split —
  // not only from the focused one.
  const handleSelection = useCallback((key: string, text: string) => {
    if (!visibleKeysRef.current.includes(key)) return;
    setSelection(text);
  }, []);

  const register = useCallback((key: string, api: SessionApi | null) => {
    if (api) apis.current.set(key, api);
    else apis.current.delete(key);
  }, []);

  function commit(next: SessionInfo[]) {
    sessionsRef.current = next;
    setSessions(next);
  }

  // Clicking a chip while split is showing two other sessions swaps this one into the
  // focused slot, rather than either leaving it invisible or silently dropping the split.
  function activateSession(key: string) {
    const current = layoutRef.current;
    if (current.mode === "split" && !current.keys.includes(key)) {
      const slot = current.keys.indexOf(activeKeyRef.current);
      const index = slot >= 0 ? slot : 0;
      applyLayout({ mode: "split", keys: index === 0 ? [key, current.keys[1]] : [current.keys[0], key] });
    }
    setActiveKey(key);
  }

  function openSession(target: ShellTarget) {
    setPickerOpen(false);
    const session = makeSession(target, sessionsRef.current);
    commit([...sessionsRef.current, session]);
    const current = layoutRef.current;
    if (current.mode === "split") {
      const slot = current.keys.indexOf(activeKeyRef.current);
      const index = slot >= 0 ? slot : 0;
      applyLayout({ mode: "split", keys: index === 0 ? [session.key, current.keys[1]] : [current.keys[0], session.key] });
    }
    setActiveKey(session.key);
  }

  function closeSession(key: string) {
    setMenu(null);
    // closes this tab's socket only; every other tab keeps its session
    apis.current.get(key)?.close();
    const current = sessionsRef.current;
    const index = current.findIndex((session) => session.key === key);
    const remaining = current.filter((session) => session.key !== key);
    // Closing either half of a split drops back to single with the survivor focused.
    const wasSplit = layoutRef.current.mode === "split" && layoutRef.current.keys.includes(key);
    const survivor = wasSplit && layoutRef.current.mode === "split" ? layoutRef.current.keys.find((other) => other !== key) : undefined;
    commit(remaining);
    setStatuses((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    if (remaining.length === 0) {
      // no tabs left means no workspace; let the parent drop us so its state agrees
      applyLayout({ mode: "single" });
      exitFullscreen();
      onClose();
      return;
    }
    if (wasSplit) {
      applyLayout({ mode: "single" });
      if (survivor && remaining.some((session) => session.key === survivor)) {
        setActiveKey(survivor);
        return;
      }
    }
    if (key === activeKeyRef.current) setActiveKey(remaining[Math.min(index, remaining.length - 1)].key);
  }

  function closeWorkspace() {
    apis.current.forEach((api) => api.close());
    applyLayout({ mode: "single" });
    exitFullscreen();
    onClose();
  }

  // A tab becoming visible, or the panel changing shape, needs a fit() *after* the browser
  // has applied the new layout — never in the same tick, when the old box is still current.
  // Every registered session is refitted, not just the focused one: in split both boxes
  // changed, and a background tab that is not refitted renders corrupted the moment it is
  // shown again.
  const refitAll = useCallback((focusKey?: string) => {
    let done = false;
    function apply() {
      if (done) return;
      done = true;
      apis.current.forEach((api) => api.fit());
      if (focusKey) apis.current.get(focusKey)?.focus();
    }
    // Two frames when the page is visible (the first lands after this render commits, the
    // second once the resulting layout is live), and a timer for when it is not: rAF does not
    // run at all in a hidden browser tab, and the refit must not be lost.
    const raf = window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
    const timer = window.setTimeout(apply, 60);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => refitAll(focusedKey), [focusedKey, refitAll]);

  // Track the split axis. The listener is the only thing that can flip `isWide`, so the
  // inline geometry and the axis can never disagree.
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // No per-frame refit during a drag any more: fitting on every pointermove reflowed every
  // terminal and sent an SSH window-resize frame each time, which is what made the drag
  // stutter. The drag moves a CSS variable; the single fit happens on release.
  //
  // One signature for everything that changes a terminal's box: fullscreen mode, the side
  // pane, the number of tabs, and entering/leaving/reshuffling the split. fsMode only ever
  // moves in the `fullscreenchange` handler for the native path, so this refit necessarily
  // runs *after* that event, when the layout is final.
  const geometry = `${fsMode}|${pane}|${sessions.length}|${inSplit ? splitSignature : "single"}`;
  useEffect(() => refitAll(activeKeyRef.current), [geometry, refitAll]);

  // The per-terminal ResizeObserver already catches a viewport change, but the split panes
  // also restack at `lg`; refitting both from the window event as well costs nothing and
  // means a missed observation cannot leave a pane on its old cols/rows.
  useEffect(() => {
    function onResize() {
      refitAll();
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [refitAll]);

  // ---- fullscreen -------------------------------------------------------------------
  // `fullscreenchange` is the single source of truth for the native path. Driving state from
  // the event rather than from our own click handler is what keeps the button label correct
  // when the browser leaves fullscreen on its own: the UA's Esc, F11 and the tab going to
  // the background never call our code. The updater only ever clears "native", so an overlay
  // fallback is not cancelled by an unrelated fullscreenchange elsewhere on the page.
  useEffect(() => {
    function onChange() {
      const native = !!frameRef.current && document.fullscreenElement === frameRef.current;
      setFsMode((current) => (native ? "native" : current === "native" ? "off" : current));
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Leaving fullscreen behind on unmount would strand the browser in a fullscreen view of a
  // gone element. The element is captured at mount because refs are detached during unmount.
  useEffect(() => {
    const element = frameRef.current;
    return () => {
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const enterFullscreen = useCallback(() => {
    const element = frameRef.current;
    if (!element || typeof element.requestFullscreen !== "function") {
      setFsMode("overlay");
      return;
    }
    // Success is handled by the fullscreenchange listener, so only the rejection is handled
    // here: a permissions-policy block inside an iframe, a lost user gesture, or a plain UA
    // refusal all reject this promise. Falling back to the overlay keeps the UI honest
    // instead of leaving the button claiming a fullscreen we never entered.
    element.requestFullscreen().catch(() => {
      if (document.fullscreenElement !== element) setFsMode("overlay");
    });
  }, []);

  const exitFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      // fullscreenchange flips the state to "off"; setting it here as well would race it,
      // and a rejected exit would then leave the label lying in the other direction.
      void document.exitFullscreen().catch(() => setFsMode("off"));
      return;
    }
    setFsMode("off");
  }, []);

  const immersive = fsMode !== "off";
  // The split axis flips at `lg`, and the divider's geometry is now inline percentages, so
  // the breakpoint has to be readable in JS — a Tailwind `lg:` variant cannot express a
  // ratio that changes at runtime.
  const stackedSplit = inSplit && !isWide;
  const splitPercent = splitRatio * 100;
  const panePercent = paneRatio * 100;
  const paneFirst = paneSide === "left";
  // A separator reports its distance from the container's start edge. With the pane first
  // that is the pane's own fraction; with the terminal first it is everything before it.
  const separatorValue = paneFirst ? paneRatio : 1 - paneRatio;

  // Drag preview: CSS only. No setState (which would re-render the workspace) and no fit()
  // (which reflows every terminal and sends an SSH resize frame). Both happen once on commit.
  const previewSplit = useCallback((next: number) => {
    terminalBoxRef.current?.style.setProperty("--split-pct", `${next * 100}%`);
  }, []);
  const previewPane = useCallback((next: number) => {
    // `next` is the separator's distance from the row's start edge
    const fraction = paneSideRef.current === "left" ? next : 1 - next;
    bodyRowRef.current?.style.setProperty("--pane-pct", `${fraction * 100}%`);
  }, []);

  const commitSplit = useCallback((next: number) => {
    setSplit(next);
    writeRatio(SPLIT_RATIO_KEY, Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, next)));
    refitAll(activeKeyRef.current);
  }, [refitAll, setSplit]);
  const commitPane = useCallback((next: number) => {
    const fraction = paneSideRef.current === "left" ? next : 1 - next;
    setPane2(fraction);
    writeRatio(PANE_RATIO_KEY, Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, fraction)));
    refitAll(activeKeyRef.current);
  }, [refitAll, setPane2]);

  const movePane = useCallback((side: "left" | "right") => {
    paneSideRef.current = side;
    setPaneSide(side);
    try {
      window.localStorage.setItem(PANE_SIDE_KEY, side);
    } catch {
      // a lost preference is not worth an error
    }
    refitAll(activeKeyRef.current);
  }, [refitAll]);

  // Only the overlay fallback needs a manual Esc: in native fullscreen the UA handles Esc
  // itself and this handler would double-toggle, fighting the fullscreenchange listener that
  // owns the state.
  useEffect(() => {
    if (fsMode !== "overlay") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      // The keystroke still reaches the PTY, which is what a shell user expects from Esc.
      // An open tab menu owns Escape first, so one press does not also drop fullscreen.
      if (event.key === "Escape" && !menuOpenRef.current) setFsMode("off");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [fsMode]);

  // ---- tab context menu -------------------------------------------------------------
  function openMenuAt(key: string, x: number, y: number) {
    setPickerOpen(false);
    setMenu({
      key,
      x: Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - MENU_WIDTH - MENU_MARGIN)),
      y: Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - MENU_MAX_HEIGHT - MENU_MARGIN))
    });
  }

  // Anchored under whichever chip control was used, so the keyboard path lands somewhere
  // sensible instead of at the pointer's last position.
  function openMenuForElement(key: string, element: HTMLElement) {
    const box = element.getBoundingClientRect();
    openMenuAt(key, box.left, box.bottom + 4);
  }

  function dismissMenu(restoreFocus = true) {
    setMenu(null);
    if (restoreFocus) apis.current.get(activeKeyRef.current)?.focus();
  }

  useEffect(() => {
    if (!menu) return;
    function close() {
      setMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMenu(null);
      }
    }
    // capture for scroll because it does not bubble from a scrolling element, so a
    // bubble-phase window listener would miss the tab strip or any scrolling ancestor
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menu]);

  function duplicateSession(key: string) {
    setMenu(null);
    const target = sessionsRef.current.find((session) => session.key === key);
    if (!target) return;
    openSession({ id: target.serverId, hostname: target.hostname, username: target.username });
  }

  function splitWith(key: string) {
    setMenu(null);
    const current = sessionsRef.current;
    const target = current.find((session) => session.key === key);
    if (!target) return;
    if (current.length < 2) {
      // Nothing to split against: a second session on the same host is the only sensible
      // partner, and duplicating gives one immediately.
      const session = makeSession({ id: target.serverId, hostname: target.hostname, username: target.username }, current);
      commit([...current, session]);
      applyLayout({ mode: "split", keys: [key, session.key] });
      setActiveKey(key);
      return;
    }
    const focused = activeKeyRef.current;
    const fallback = current.find((session) => session.key !== key);
    const partner = focused !== key && current.some((session) => session.key === focused) ? focused : fallback?.key;
    if (!partner) return;
    // Panes follow tab order so the same pair always lands the same way round.
    const ordered = current.filter((session) => session.key === key || session.key === partner).map((session) => session.key);
    applyLayout({ mode: "split", keys: [ordered[0], ordered[1]] });
    setActiveKey(key);
  }

  function leaveSplit(key: string) {
    setMenu(null);
    applyLayout({ mode: "single" });
    setActiveKey(key);
  }

  function closeOtherSessions(key: string) {
    setMenu(null);
    const current = sessionsRef.current;
    current.forEach((session) => {
      if (session.key !== key) apis.current.get(session.key)?.close();
    });
    const keep = current.filter((session) => session.key === key);
    if (keep.length === 0) return;
    commit(keep);
    setStatuses((previous) => (previous[key] ? { [key]: previous[key] } : {}));
    applyLayout({ mode: "single" });
    setActiveKey(key);
  }

  // The parent asking for a different host opens another tab instead of replacing the
  // workspace, so existing sessions survive.
  const requested = useRef(serverId);
  useEffect(() => {
    if (requested.current === serverId) return;
    requested.current = serverId;
    openSession({ id: serverId, hostname, username });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, hostname, username]);

  function insertIntoActive(command: string) {
    apis.current.get(activeKeyRef.current)?.insert(command);
  }

  function runInActive(command: string) {
    apis.current.get(activeKeyRef.current)?.run(command);
  }

  const targets = (servers ?? [])
    .filter((target) => target.has_credentials !== false)
    .filter((target, index, all) => all.findIndex((other) => other.id === target.id) === index)
    .sort((a, b) => (a.hostname || "").localeCompare(b.hostname || "", undefined, { numeric: true, sensitivity: "base" }));
  const canPick = targets.length > 1;

  const activeStatus: SessionStatus = (activeSession && statuses[activeSession.key]) || { phase: "connecting", detail: "", code: null };
  const menuSession = menu ? sessions.find((session) => session.key === menu.key) ?? null : null;

  // Three complete class lists rather than a base plus overrides: two positioning or
  // background utilities in one class attribute are resolved by stylesheet order, not by
  // which was written last. In native fullscreen the UA gives the element its own fixed,
  // screen-sized box with `!important`, so nothing of ours needs to (or could) position it.
  const frameClass =
    fsMode === "native"
      ? "flex h-full w-full flex-col overflow-hidden bg-panel dark:bg-slate-900"
      : fsMode === "overlay"
        ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-panel dark:bg-slate-900"
        : "overflow-hidden rounded-2xl border border-line bg-panel dark:border-slate-700 dark:bg-slate-900";
  const iconShape = "inline-flex h-9 items-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors";
  const iconButton = `${iconShape} bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700`;
  const iconButtonOn = `${iconShape} bg-accent/10 text-accent hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30`;
  const menuItem =
    "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800";
  const menuItemDanger =
    "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10";

  return (
    <div ref={frameRef} className={frameClass}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 dark:border-slate-700">
        <div className="flex items-center gap-2 font-semibold">
          <TerminalSquare size={18} className="text-accent" />
          <span>Shell workspace</span>
          {activeSession ? (
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
              {activeSession.username}@{activeSession.hostname}
            </span>
          ) : null}
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => (inSplit ? leaveSplit(focusedKey) : splitWith(focusedKey))}
            aria-pressed={inSplit}
            title={inSplit ? "Back to one terminal" : "Show two sessions side by side"}
            className={inSplit ? iconButtonOn : iconButton}
          >
            <Columns2 size={16} /> {inSplit ? "Unsplit" : "Split"}
          </button>
          <button
            onClick={() => setPane(pane === "files" ? "none" : "files")}
            aria-pressed={pane === "files"}
            title="Browse, download and upload files over SFTP"
            className={pane === "files" ? iconButtonOn : iconButton}
          >
            <FolderOpen size={16} /> Files
          </button>
          <button
            onClick={() => setPane(pane === "favorites" ? "none" : "favorites")}
            aria-pressed={pane === "favorites"}
            title="Saved commands"
            className={pane === "favorites" ? iconButtonOn : iconButton}
          >
            <Star size={16} /> Favorites
          </button>
          {/* Only meaningful while a pane is open, so it does not sit there inert. Below `lg`
              the row stacks and the same choice reads as top/bottom, which the label says. */}
          {pane !== "none" ? (
            <button
              type="button"
              onClick={() => movePane(paneFirst ? "right" : "left")}
              title={
                isWide
                  ? `Move the panel to the ${paneFirst ? "right" : "left"}`
                  : `Move the panel to the ${paneFirst ? "bottom" : "top"}`
              }
              className={iconButton}
            >
              {paneFirst ? <PanelRight size={16} /> : <PanelLeft size={16} />}
              {isWide ? (paneFirst ? "Right" : "Left") : paneFirst ? "Bottom" : "Top"}
            </button>
          ) : null}
          <button
            onClick={() => (immersive ? exitFullscreen() : enterFullscreen())}
            aria-pressed={immersive}
            title={immersive ? "Leave fullscreen (Esc)" : "Fill the screen"}
            className={iconButton}
          >
            {immersive ? <Minimize2 size={16} /> : <Maximize2 size={16} />} {immersive ? "Exit fullscreen" : "Fullscreen"}
          </button>
          <button onClick={closeWorkspace} title="Close every session in this workspace" className={iconButton}>
            <X size={16} /> Close all
          </button>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-1.5 border-b border-line bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/50">
        {sessions.map((session) => {
          const status = statuses[session.key] ?? { phase: "connecting" as Phase, detail: "", code: null };
          const isFocused = session.key === focusedKey;
          const isVisible = visibleKeysRef.current.includes(session.key);
          return (
            <span
              key={session.key}
              // The browser menu is suppressed on the chip only — never on the document, and
              // never inside the terminal, where the native menu is how copy/paste is reached.
              onContextMenu={(event) => {
                event.preventDefault();
                openMenuAt(session.key, event.clientX, event.clientY);
              }}
              // Right-click is not reachable from a keyboard, so the platform shortcuts open
              // the same menu whenever anything inside the chip has focus.
              onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  openMenuForElement(session.key, event.currentTarget);
                }
              }}
              className={`inline-flex h-8 items-center gap-2 rounded-full pl-3 pr-1.5 text-xs font-semibold transition-colors ${
                isFocused
                  ? "bg-white text-slate-900 ring-1 ring-accent dark:bg-slate-900 dark:text-slate-100"
                  : isVisible
                    ? "bg-white text-slate-700 ring-1 ring-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:ring-slate-600"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-700"
              }`}
            >
              <button
                onClick={() => activateSession(session.key)}
                title={`${session.username}@${session.hostname} — ${status.phase}${status.detail ? `: ${status.detail}` : ""} (right-click or Shift+F10 for tab actions)`}
                className="inline-flex items-center gap-2"
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${TAB_TONES[status.phase]} ${status.phase === "connecting" ? "animate-pulse" : ""}`} />
                <span>{session.label}</span>
                <span className={`font-medium uppercase ${PHASE_TEXT[status.phase]}`}>{status.phase}</span>
              </button>
              <button
                onClick={(event) => openMenuForElement(session.key, event.currentTarget)}
                aria-haspopup="menu"
                aria-expanded={menu?.key === session.key}
                title={`Tab actions for ${session.label}`}
                aria-label={`Tab actions for ${session.label}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-300 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-600 dark:hover:text-slate-100"
              >
                <MoreHorizontal size={12} />
              </button>
              <button
                onClick={() => closeSession(session.key)}
                title={`Close ${session.label}`}
                aria-label={`Close ${session.label}`}
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-300 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-600 dark:hover:text-slate-100"
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <button
          onClick={() => (canPick ? setPickerOpen(!pickerOpen) : activeSession && openSession({ id: activeSession.serverId, hostname: activeSession.hostname, username: activeSession.username }))}
          title={canPick ? "Open another session" : `Open another session on ${activeSession?.hostname ?? "this host"}`}
          className="inline-flex h-8 items-center gap-1 rounded-full bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30"
        >
          <Plus size={14} /> New tab {canPick ? <ChevronDown size={12} /> : null}
        </button>
        {pickerOpen && canPick ? (
          <>
            {/* click-away backdrop; the menu itself sits above it */}
            <button aria-label="Dismiss host list" onClick={() => setPickerOpen(false)} className="fixed inset-0 z-10 cursor-default" />
            <div className="absolute left-3 top-full z-20 mt-1 max-h-72 w-64 overflow-auto rounded-2xl border border-line bg-panel p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
              {targets.map((target) => (
                <button
                  key={target.id}
                  onClick={() => openSession(target)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  <span>{target.hostname}</span>
                  <span className="font-medium text-slate-500 dark:text-slate-400">{target.username}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {menu && menuSession ? (
        <>
          {/* click-away backdrop; a right-click on it dismisses without opening the browser menu */}
          <button
            aria-label="Dismiss tab actions"
            onClick={() => dismissMenu()}
            onContextMenu={(event) => {
              event.preventDefault();
              dismissMenu();
            }}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            aria-label={`Tab actions for ${menuSession.label}`}
            style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }}
            className="fixed z-50 rounded-2xl border border-line bg-panel p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            <p className="truncate px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{menuSession.label}</p>
            <button role="menuitem" autoFocus onClick={() => duplicateSession(menuSession.key)} className={menuItem}>
              <Copy size={14} /> Duplicate tab
            </button>
            {inSplit && splitKeys.includes(menuSession.key) ? (
              <button role="menuitem" onClick={() => leaveSplit(menuSession.key)} className={menuItem}>
                <Columns2 size={14} /> Exit split
              </button>
            ) : (
              <button role="menuitem" onClick={() => splitWith(menuSession.key)} className={menuItem}>
                <Columns2 size={14} /> Split with this tab
              </button>
            )}
            <div className="my-1 h-px bg-line dark:bg-slate-700" />
            <button role="menuitem" onClick={() => closeSession(menuSession.key)} className={menuItemDanger}>
              <X size={14} /> Close tab
            </button>
            <button role="menuitem" disabled={sessions.length < 2} onClick={() => closeOtherSessions(menuSession.key)} className={menuItemDanger}>
              <X size={14} /> Close other tabs
            </button>
          </div>
        </>
      ) : null}

      {activeStatus.detail ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs font-medium text-slate-600 dark:border-slate-700 dark:text-slate-300">
          <span>{activeStatus.detail}</span>
          {activeSession && activeStatus.phase !== "open" ? (
            <button
              onClick={() => openSession({ id: activeSession.serverId, hostname: activeSession.hostname, username: activeSession.username })}
              className="inline-flex h-7 items-center rounded-full bg-accent/10 px-3 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 dark:bg-accent/20 dark:hover:bg-accent/30"
            >
              New session on {activeSession.hostname}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Fullscreen drops the outer padding and the gap so the terminal reaches the screen
          edges; the side pane keeps a border instead of the gap it loses. */}
      <div
        ref={bodyRowRef}
        // --pane-pct is the single source of truth for the side pane's size while dragging;
        // React only rewrites it on commit, so a drag never re-renders this subtree
        style={{ ["--pane-pct" as string]: `${panePercent}%` }}
        className={`flex ${paneFirst ? "flex-col-reverse lg:flex-row-reverse" : "flex-col lg:flex-row"} ${
          immersive ? "min-h-0 flex-1 gap-0 p-0" : pane !== "none" ? "gap-1 p-3" : "gap-3 p-3"
        }`}
      >
        {/* Every session's terminal stays mounted for the life of its tab. Hidden tabs are
            hidden with `invisible`, which — unlike `display:none` — keeps their layout box, so
            a background terminal still measures a real size and refits correctly. */}
        {/* `flex-1` is applied only where the main axis is the one it should stretch: in the
            stacked (narrow) layout it would set flex-basis:0 on the height and collapse the
            terminal to nothing, since the row has no definite height of its own. */}
        <div
          ref={terminalBoxRef}
          style={{ ["--split-pct" as string]: `${splitPercent}%` }}
          className={`relative min-w-0 overflow-hidden bg-[#0b1020] ${
            immersive ? "min-h-0 flex-1 rounded-none" : "h-[480px] rounded-xl lg:flex-1"
          }`}
        >
          {sessions.map((session) => {
            const slot = inSplit ? splitKeys.indexOf(session.key) : session.key === focusedKey ? 0 : -1;
            const isVisible = slot >= 0;
            const isFocused = isVisible && session.key === focusedKey;
            // Slot geometry is expressed purely in classes. A visible session is never moved
            // to a different parent or a different position in this array: that would remount
            // it, disposing the terminal and dropping the websocket. Only className changes.
            // Fixed 50/50 became a draggable ratio, so the geometry moved from Tailwind
            // fractions to inline percentages. Still position-only: nothing changes parent
            // or array index, so no session remounts when the divider moves.
            const place = !isVisible || !inSplit ? "inset-0" : "";
            const style: React.CSSProperties | undefined = !isVisible || !inSplit
              ? undefined
              : stackedSplit
                ? slot === 0
                  ? { left: 0, right: 0, top: 0, height: "calc(var(--split-pct) - 2px)" }
                  : { left: 0, right: 0, bottom: 0, height: "calc(100% - var(--split-pct) - 2px)" }
                : slot === 0
                  ? { top: 0, bottom: 0, left: 0, width: "calc(var(--split-pct) - 2px)" }
                  : { top: 0, bottom: 0, right: 0, width: "calc(100% - var(--split-pct) - 2px)" };
            // ring/rounded only: an inset ring paints inside the box, so switching the focus
            // indicator never changes a terminal's measurable size and cannot desync its fit.
            const outline = !inSplit || !isVisible ? "" : isFocused ? "rounded-lg ring-2 ring-inset ring-accent" : "rounded-lg ring-1 ring-inset ring-slate-600";
            return (
              <div
                key={session.key}
                aria-hidden={!isVisible}
                // xterm's textarea taking focus bubbles a focus event to here, so clicking
                // into either pane makes it the keyboard target without any xterm plumbing.
                onFocus={() => {
                  if (isVisible) activateSession(session.key);
                }}
                onMouseDown={() => {
                  if (isVisible) activateSession(session.key);
                }}
                style={style}
                className={`absolute flex flex-col ${immersive ? "pl-2" : "p-2"} ${place} ${outline} ${
                  isVisible ? "z-10" : "invisible z-0 pointer-events-none"
                }`}
              >
                {/* Always rendered, only hidden, so the terminal below keeps its position in
                    this element's child list whatever the layout does. */}
                <div
                  className={
                    inSplit && isVisible
                      ? "flex h-6 shrink-0 items-center justify-between gap-2 px-2 text-[10px] font-semibold uppercase tracking-wide"
                      : "hidden"
                  }
                >
                  <span className={isFocused ? "text-accent" : "text-slate-400"}>{session.label}</span>
                  <span className={isFocused ? "text-accent" : "text-slate-500"}>{isFocused ? "focused — typing goes here" : "click to focus"}</span>
                </div>
                <div className="min-h-0 flex-1">
                  <ShellSessionView
                    sessionKey={session.key}
                    token={token}
                    serverId={session.serverId}
                    onStatus={handleStatus}
                    onSelection={handleSelection}
                    register={register}
                  />
                </div>
              </div>
            );
          })}
          {sessions.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm font-medium text-slate-400">No sessions open.</div>
          ) : null}
          {/* Split divider. Absolutely positioned over the seam rather than being a flex child,
              because the two panes are absolutely positioned too — a flex divider would not
              share their coordinate space. */}
          {inSplit ? (
            <div
              className={`absolute z-20 ${stackedSplit ? "inset-x-0" : "inset-y-0"}`}
              style={stackedSplit ? { top: "calc(var(--split-pct) - 5px)", height: 11 } : { left: "calc(var(--split-pct) - 5px)", width: 11 }}
            >
              {/* items-stretch, not items-center: the handle must span the whole seam, and
                  `self-stretch` on it only works if this container lets it. */}
              <div className={`flex h-full w-full items-stretch justify-center ${stackedSplit ? "flex-col" : ""}`}>
                <Divider
                  orientation={stackedSplit ? "horizontal" : "vertical"}
                  value={splitRatio}
                  min={MIN_FRACTION}
                  max={MAX_FRACTION}
                  containerRef={terminalBoxRef}
                  onPreview={previewSplit}
                  onCommit={commitSplit}
                  onNudge={(delta) => commitSplit(splitRatioRef.current + delta)}
                  onReset={() => commitSplit(0.5)}
                  label="Resize the split panes"
                />
              </div>
            </div>
          ) : null}
        </div>
        {/* Side-pane divider, a real flex child this time: the terminal box and the aside are
            flex siblings, so the divider can sit between them and the row does the maths. */}
        {pane !== "none" && activeSession ? (
          <Divider
            orientation={isWide ? "vertical" : "horizontal"}
            value={separatorValue}
            min={MIN_FRACTION}
            max={MAX_FRACTION}
            containerRef={bodyRowRef}
            onPreview={previewPane}
            onCommit={commitPane}
            onNudge={(delta) => {
              // separator value runs with the pane when it is first, against it otherwise
              const next = paneFirst ? paneRatioRef.current + delta : 1 - paneRatioRef.current + delta;
              commitPane(next);
            }}
            onReset={() => commitPane(paneFirst ? 0.32 : 1 - 0.32)}
            label="Resize the side pane"
          />
        ) : null}
        {pane !== "none" && activeSession ? (
          // Both panes render their own card and expect a definite height from here, scrolling
          // internally. Fullscreen lets the row give them its height; otherwise they match the
          // terminal's 480px so the workspace keeps one outline.
          <aside
            // width (or height when stacked) now comes from the divider rather than a fixed
            // lg:w-96, so the operator decides how much of the row the file pane gets
            // Side by side, only the width comes from the divider — the height must match the
            // terminal's, or the taller of the two drives the row and the two panels end up
            // visibly different sizes. Stacked, the ratio drives the height instead, but only
            // in fullscreen where the row actually has a definite height to take a % of.
            style={
              isWide
                ? { width: "var(--pane-pct)" }
                : immersive
                  ? { height: "var(--pane-pct)" }
                  : undefined
            }
            className={`flex min-h-0 shrink-0 flex-col ${
              immersive
                ? "border-t border-line dark:border-slate-700 lg:border-l lg:border-t-0"
                : isWide
                  ? "h-[480px]"
                  : "h-80"
            }`}
          >
            {pane === "files" ? (
              // Remounted per host: a new active host means a new remote filesystem, and
              // there is no live connection here to preserve.
              <SftpPanel
                key={activeSession.serverId}
                token={token}
                serverId={activeSession.serverId}
                hostname={activeSession.hostname}
                onClose={() => setPane("none")}
              />
            ) : (
              <ShellFavorites token={token} selection={selection} onInsert={insertIntoActive} onRun={runInActive} onClose={() => setPane("none")} />
            )}
          </aside>
        ) : null}
      </div>

      <p className="border-t border-line px-4 py-2 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
        Runs as the stored SSH user with that user&apos;s full privileges. Every session is recorded in the audit log.
        Idle and long-running sessions are closed automatically by the server&apos;s configured limits.
      </p>
    </div>
  );
}
