// EXPERIMENTAL theme system for Infra Monitor.
//
// Why this exists: the operator complained that the old two-state look was
// uncomfortable — light mode read as "everything is white", and the old dark mode's
// flat carbon (#121212) felt harsh. So instead of a single light/dark boolean we now
// have a set of *named* themes chosen from a dropdown (like VS Code's theme picker).
//
// Two sources of truth, split by what each medium can express:
//   * The UI palette (page/surface/text/border …) lives in globals.css as CSS
//     variables under `[data-theme="<name>"]`, because Tailwind utilities and the
//     `dark:` variants have to resolve against real CSS. This module never duplicates
//     those colours.
//   * The xterm terminal palette lives HERE as a TS map, because xterm takes a plain
//     JS object (`ITheme`) at construction time, not CSS. Keeping it in TS also gives
//     us the full 16-colour ANSI set per theme without bloating the stylesheet.
//
// Both maps are keyed by the same `ThemeName`, so a theme is "complete" only when it
// appears in globals.css AND in TERM_PALETTES below. Keep the two in lockstep.

export type ThemeName =
  | "soft-light"
  | "comfortable-dark"
  | "dracula"
  | "nord"
  | "solarized-dark"
  | "one-dark";

export type ThemeMeta = {
  name: ThemeName;
  // Human label shown in the picker.
  label: string;
  // Whether the `dark` class must be ON for this theme. The existing app is riddled
  // with `dark:` utilities and reads `localStorage["inframonitor-theme"]` as
  // "dark"/"light"; driving the class from this flag is what keeps all of that working
  // unchanged while the finer palette comes from `data-theme`.
  isDark: boolean;
  // A one-line hint under the picker, purely cosmetic.
  hint: string;
};

// Order here is the order shown in the dropdown: the two comfortable defaults first,
// then the VS-Code-familiar extras.
export const THEMES: ThemeMeta[] = [
  { name: "soft-light", label: "Soft Light", isDark: false, hint: "Off-white, easy on the eyes" },
  { name: "comfortable-dark", label: "Comfortable Dark", isDark: true, hint: "Soft blue-gray, not harsh black" },
  { name: "dracula", label: "Dracula", isDark: true, hint: "Purple-tinged classic" },
  { name: "nord", label: "Nord", isDark: true, hint: "Cool arctic blues" },
  { name: "solarized-dark", label: "Solarized Dark", isDark: true, hint: "Warm low-contrast" },
  { name: "one-dark", label: "One Dark", isDark: true, hint: "Atom's signature dark" }
];

// The two themes the legacy light/dark boolean maps onto. Existing code that only knows
// "dark"/"light" resolves to these, so nothing regresses for a user who never touches
// the picker.
export const DEFAULT_LIGHT: ThemeName = "soft-light";
export const DEFAULT_DARK: ThemeName = "comfortable-dark";

// Storage keys. The new picker owns `THEME_NAME_KEY`; we ALSO keep the old
// `LEGACY_MODE_KEY` in sync ("dark"/"light") so the plain toggle path, ThemeToggle and
// anything else still reading it continue to agree with the picker.
export const THEME_NAME_KEY = "inframonitor-theme-name";
export const LEGACY_MODE_KEY = "inframonitor-theme";

// Fired on documentElement whenever the theme changes, so already-mounted components
// (an open shell terminal, a second picker on another surface) can react without prop
// threading. detail carries the freshly-applied theme name.
export const THEME_EVENT = "inframonitor-theme-change";

const THEME_NAMES = new Set<string>(THEMES.map((theme) => theme.name));

export function isThemeName(value: string | null | undefined): value is ThemeName {
  return typeof value === "string" && THEME_NAMES.has(value);
}

export function themeMeta(name: ThemeName): ThemeMeta {
  return THEMES.find((theme) => theme.name === name) ?? THEMES[0];
}

// Resolve the theme to show on load. Precedence:
//   1. an explicit picker choice (new key),
//   2. the legacy "dark"/"light" flag mapped onto the two defaults,
//   3. the OS preference.
// All storage access is guarded because this runs in client components that the static
// export also prerenders on the server, where `window` does not exist.
export function resolveInitialTheme(): ThemeName {
  if (typeof window === "undefined") return DEFAULT_LIGHT;
  try {
    const saved = window.localStorage.getItem(THEME_NAME_KEY);
    if (isThemeName(saved)) return saved;
    const legacy = window.localStorage.getItem(LEGACY_MODE_KEY);
    if (legacy === "dark") return DEFAULT_DARK;
    if (legacy === "light") return DEFAULT_LIGHT;
  } catch {
    // private mode / blocked origin: fall through to the OS preference
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  return prefersDark ? DEFAULT_DARK : DEFAULT_LIGHT;
}

// Apply a theme to the live document and persist it. This is the single place that
// writes `data-theme`, toggles the `dark` class, and keeps the legacy key in sync — so
// the picker, the sidebar toggle and the appearance page all funnel through here and
// can never drift apart. Returns the applied meta for convenience.
export function applyTheme(name: ThemeName): ThemeMeta {
  const meta = themeMeta(name);
  if (typeof document === "undefined") return meta;
  const root = document.documentElement;
  root.dataset.theme = meta.name;
  // The finer palette comes from data-theme, but the `dark` class still gates every
  // existing `dark:` utility in the app, so it must track the theme's darkness.
  root.classList.toggle("dark", meta.isDark);
  try {
    window.localStorage.setItem(THEME_NAME_KEY, meta.name);
    window.localStorage.setItem(LEGACY_MODE_KEY, meta.isDark ? "dark" : "light");
  } catch {
    // a lost preference is not worth surfacing an error for
  }
  // Let open surfaces (notably a live shell terminal) re-theme themselves.
  root.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { name: meta.name } }));
  return meta;
}

// Read whatever theme is currently on the document, e.g. so a newly-opened terminal can
// match without re-reading storage. Falls back to resolving from storage if the
// attribute is somehow absent (it is set pre-hydration by the inline script in layout).
export function currentTheme(): ThemeName {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme;
    if (isThemeName(attr)) return attr;
  }
  return resolveInitialTheme();
}

// ---- xterm terminal palettes ---------------------------------------------------------
//
// One entry per ThemeName. The shape matches xterm's ITheme; we keep the full ANSI 16
// so command output (ls colours, git, prompts) looks native in every theme rather than
// falling back to xterm's built-in dark defaults on a light background.

export type TermPalette = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

export const TERM_PALETTES: Record<ThemeName, TermPalette> = {
  // Light terminal to match the light UI — a soft off-white ground, GitHub-ish ANSI.
  "soft-light": {
    background: "#f6f7f9",
    foreground: "#24292e",
    cursor: "#0f766e",
    cursorAccent: "#f6f7f9",
    selectionBackground: "#cfe6e2",
    black: "#24292e",
    red: "#d73a49",
    green: "#22863a",
    yellow: "#b08800",
    blue: "#0366d6",
    magenta: "#6f42c1",
    cyan: "#1b7c83",
    white: "#6a737d",
    brightBlack: "#959da5",
    brightRed: "#cb2431",
    brightGreen: "#28a745",
    brightYellow: "#dbab09",
    brightBlue: "#2188ff",
    brightMagenta: "#8a63d2",
    brightCyan: "#3192aa",
    brightWhite: "#24292e"
  },
  // Tokyo Night — the "not harsh carbon" default dark.
  "comfortable-dark": {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#33467c",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5"
  },
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff"
  },
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#4c566a",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4"
  },
  "solarized-dark": {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#93a1a1",
    cursorAccent: "#002b36",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3"
  },
  "one-dark": {
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    cursorAccent: "#282c34",
    selectionBackground: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff"
  }
};

export function termPalette(name: ThemeName): TermPalette {
  return TERM_PALETTES[name] ?? TERM_PALETTES[DEFAULT_DARK];
}
