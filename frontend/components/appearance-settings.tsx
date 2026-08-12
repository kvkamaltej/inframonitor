"use client";

import { Palette } from "lucide-react";
import { useEffect, useState } from "react";
import { ThemePicker } from "@/components/theme-picker";

const colors = [
  ["Teal", "#0f766e"],
  ["Blue", "#2563eb"],
  ["Green", "#16a34a"],
  ["Rose", "#e11d48"],
  ["Amber", "#d97706"]
];

// The surface-style dropdown (classic / glassmorphism / neomorphism / liquidglass /
// material3) was removed. Its CSS only ever targeted `.bg-panel`, which the dashboard,
// inventory, users, policies and this page do not use -- so four of the five options
// changed nothing anywhere the operator could see them, including on this screen.
// The accent colour stays: `--inframonitor-accent` drives every .text-accent /
// .bg-accent / .border-accent in the app, so it visibly works.
export function AppearanceSettings() {
  const [color, setColor] = useState("#0f766e");

  useEffect(() => {
    apply(localStorage.getItem("inframonitor-accent") ?? "#0f766e");
  }, []);

  function apply(nextColor: string) {
    document.documentElement.style.setProperty("--inframonitor-accent", nextColor);
    localStorage.setItem("inframonitor-accent", nextColor);
    setColor(nextColor);
  }

  return (
    <div className="overflow-hidden rounded-3xl bg-surface shadow-sm ring-1 ring-edge">
      <div className="flex items-center gap-3 border-b border-edge bg-elevated px-6 py-4 font-semibold text-fg"><Palette size={18} className="text-accent" /> Appearance</div>
      <div className="grid gap-6 p-6">
        {/* EXPERIMENTAL theme selector — the primary fix for the "everything is white" /
            "harsh carbon" complaint. Picks the whole named palette (UI + terminal). */}
        <ThemePicker variant="full" />
        <div className="h-px bg-edge" />
        <p className="text-sm font-medium text-muted">Accent colour</p>
        <div className="flex flex-wrap items-center gap-3">
          {colors.map(([name, value]) => (
            <button key={value} title={name} onClick={() => apply(value)} className={`h-10 w-10 rounded-full shadow-sm ring-offset-2 transition-all hover:scale-110 dark:ring-offset-[#1e1e1e] ${color === value ? "ring-2 ring-slate-900 dark:ring-slate-100" : ""}`} style={{ backgroundColor: value }} />
          ))}
          <div className="relative h-10 w-10 overflow-hidden rounded-full shadow-sm ring-offset-2 transition-all hover:scale-110 dark:ring-offset-[#1e1e1e] focus-within:ring-2 focus-within:ring-slate-900 dark:focus-within:ring-slate-100">
            <input type="color" value={color} onChange={(event) => apply(event.target.value)} className="absolute -inset-2 h-14 w-14 cursor-pointer" title="Custom color" />
          </div>
        </div>
      </div>
    </div>
  );
}
