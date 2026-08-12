import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17202a",
        panel: "#ffffff",
        line: "#d8dee8",
        accent: "var(--inframonitor-accent, #0f766e)",
        warn: "#b45309",
        danger: "#b91c1c",
        // EXPERIMENTAL theme tokens. These map onto the per-theme CSS variables in
        // globals.css, so `bg-page`, `bg-surface`, `text-fg`, `border-edge` … re-theme
        // automatically across every named theme WITHOUT needing a `dark:` counterpart.
        // They intentionally sit alongside the legacy tokens above (ink/panel/line),
        // which are left in place — a full migration of every hardcoded utility colour
        // is out of scope, so both vocabularies coexist for now.
        page: "var(--im-page)",
        surface: "var(--im-surface)",
        elevated: "var(--im-elevated)",
        fg: "var(--im-fg)",
        muted: "var(--im-muted)",
        edge: "var(--im-edge)"
      }
    }
  },
  plugins: []
};

export default config;
