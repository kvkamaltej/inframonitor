import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Infra Monitor",
  description: "Operations control plane for a fleet of Linux servers"
};

// Applied before first paint to avoid a flash of the wrong theme (FOUC). This is a plain
// inline IIFE rather than an import because it MUST run synchronously in <head>, before
// React hydrates and before the body renders. It is intentionally a self-contained copy
// of the resolve/apply logic in lib/theme.ts (an inline script cannot import) and is kept
// deliberately small: read the saved theme, fall back to the legacy dark/light flag, then
// the OS preference, and stamp `data-theme` + the `dark` class onto <html>.
//
// The theme table is duplicated here only as a name->isDark map so the script knows which
// themes need the `dark` class; lib/theme.ts remains the single source of truth that the
// React components use, and applyTheme() re-stamps both on every change after hydration.
const themeInitScript = `(function () {
  try {
    // Must list EVERY dark theme in lib/theme.ts THEMES: a saved name missing from both maps
    // fails the recognition check below and is silently discarded pre-paint, reverting the
    // operator's choice (this is what stranded "vanta-black" on reload). Keep in lockstep.
    var DARK = { "comfortable-dark": 1, "vanta-black": 1, "dracula": 1, "nord": 1, "solarized-dark": 1, "one-dark": 1 };
    var LIGHT = { "soft-light": 1 };
    var saved = localStorage.getItem("inframonitor-theme-name");
    var name;
    if (saved && (DARK[saved] || LIGHT[saved])) {
      name = saved;
    } else {
      var legacy = localStorage.getItem("inframonitor-theme");
      if (legacy === "dark") name = "comfortable-dark";
      else if (legacy === "light") name = "soft-light";
      else name = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "comfortable-dark" : "soft-light";
    }
    var root = document.documentElement;
    root.setAttribute("data-theme", name);
    root.classList.toggle("dark", !!DARK[name]);
    var accent = localStorage.getItem("inframonitor-accent");
    if (accent) root.style.setProperty("--inframonitor-accent", accent);
  } catch (e) {
    // storage blocked (private mode / sandbox): the CSS :root defaults (Soft Light) apply
  }
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before paint; see themeInitScript above for why it is inline. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
