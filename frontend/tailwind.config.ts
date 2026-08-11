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
        danger: "#b91c1c"
      }
    }
  },
  plugins: []
};

export default config;
