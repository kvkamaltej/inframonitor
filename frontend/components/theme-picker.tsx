"use client";

import { Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { applyTheme, resolveInitialTheme, THEME_EVENT, THEMES, type ThemeName } from "@/lib/theme";

// EXPERIMENTAL VS-Code-style theme picker. A plain <select> is used on purpose: it is
// keyboard- and screen-reader-native, needs no popover/click-away plumbing, and the
// static export prerenders it without touching `window`. The live value is kept in React
// state, seeded after mount (never during render) so the static export's server pass and
// the first client render agree.
//
// Every change funnels through applyTheme(), which stamps `data-theme` + the `dark` class,
// persists the choice, and fires THEME_EVENT. We also LISTEN for that event so a second
// picker (this component is mounted in both the sidebar and the appearance page) or the
// terminal stays in agreement when the theme is changed elsewhere.
export function ThemePicker({
  // "full" renders a labelled card block (appearance page); "compact" renders a slim
  // control that sits inline in the sidebar rail.
  variant = "full",
  // In the sidebar's collapsed rail we hide the surrounding chrome and only keep the
  // control itself reachable.
  showLabel = true
}: {
  variant?: "full" | "compact";
  showLabel?: boolean;
}) {
  // Start with the deterministic default so server prerender and first client render match;
  // the effect below corrects it from storage immediately after mount.
  const [theme, setTheme] = useState<ThemeName>("soft-light");

  useEffect(() => {
    setTheme(resolveInitialTheme());
    // Keep this picker's shown value in step with changes made anywhere else.
    function onThemeChange(event: Event) {
      const name = (event as CustomEvent<{ name: ThemeName }>).detail?.name;
      if (name) setTheme(name);
    }
    document.documentElement.addEventListener(THEME_EVENT, onThemeChange);
    return () => document.documentElement.removeEventListener(THEME_EVENT, onThemeChange);
  }, []);

  function choose(next: ThemeName) {
    setTheme(next);
    applyTheme(next);
  }

  const select = (
    <select
      value={theme}
      onChange={(event) => choose(event.target.value as ThemeName)}
      aria-label="Colour theme"
      title="Colour theme"
      className="w-full cursor-pointer rounded-full border border-edge bg-surface px-3 py-2 text-sm font-medium text-fg shadow-sm outline-none transition-colors focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {THEMES.map((meta) => (
        <option key={meta.name} value={meta.name}>
          {meta.label}
        </option>
      ))}
    </select>
  );

  if (variant === "compact") {
    // Sidebar rail: an icon + the select, sized to sit under the nav toggles.
    return (
      <div className="flex items-center gap-3 rounded-full px-4 py-1.5" title="Colour theme">
        <Palette size={20} className="shrink-0 text-muted" />
        {showLabel ? <div className="min-w-0 flex-1">{select}</div> : null}
      </div>
    );
  }

  const active = THEMES.find((meta) => meta.name === theme) ?? THEMES[0];
  return (
    <div className="grid gap-2">
      <label className="text-sm font-medium text-muted">Theme</label>
      {select}
      <p className="text-xs font-medium text-muted">{active.hint}</p>
    </div>
  );
}
