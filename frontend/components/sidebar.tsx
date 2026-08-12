"use client";

import Link from "next/link";
import { ChevronDown, ChevronRight, Layers, Menu, MonitorCog, Moon, Palette, Server, Settings, Shield, Sun, UserCircle, Users, X } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ThemePicker } from "@/components/theme-picker";
import { applyTheme, DEFAULT_DARK, DEFAULT_LIGHT, resolveInitialTheme, themeMeta, THEME_EVENT, type ThemeName } from "@/lib/theme";

export function Sidebar({ role }: { role?: string }) {
  const [open, setOpen] = useState(true);
  const [adminOpen, setAdminOpen] = useState(false);
  const [dark, setDark] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const saved = localStorage.getItem("inframonitor-sidebar");
    if (saved) setOpen(saved === "open");
    // Apply the persisted theme and accent on mount. The inline script in layout.tsx has
    // already stamped `data-theme` + `dark` pre-paint; re-applying here is idempotent and
    // keeps this component's `dark` state in step with whatever was resolved. The sidebar
    // renders on every authenticated page, so it remains the one place that initialises the
    // look, but the resolution/persistence logic now lives in lib/theme.ts.
    const initial = resolveInitialTheme();
    applyTheme(initial);
    setDark(themeMeta(initial).isDark);
    const accent = localStorage.getItem("inframonitor-accent");
    if (accent) document.documentElement.style.setProperty("--inframonitor-accent", accent);
    // The theme can also change from the picker below (or the one on the appearance page);
    // keep the light/dark icon honest by following the shared theme-change event.
    function onThemeChange(event: Event) {
      const name = (event as CustomEvent<{ name: ThemeName }>).detail?.name;
      if (name) setDark(themeMeta(name).isDark);
    }
    document.documentElement.addEventListener(THEME_EVENT, onThemeChange);
    return () => document.documentElement.removeEventListener(THEME_EVENT, onThemeChange);
  }, []);

  // The plain toggle stays as a one-click shortcut between the two comfortable defaults
  // (Soft Light / Comfortable Dark); the picker underneath it offers the full set. Both
  // funnel through applyTheme, so they can never disagree.
  function toggleTheme() {
    applyTheme(dark ? DEFAULT_LIGHT : DEFAULT_DARK);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    localStorage.setItem("inframonitor-sidebar", next ? "open" : "closed");
  }

  function NavItem({ href, icon: Icon, label, active = false }: { href: string; icon: any; label: string; active?: boolean }) {
    const isActive = active || (pathname && pathname.startsWith(href) && href !== "/") || (href === "/" && pathname === "/");
    return (
      <Link href={href} className={`group flex h-12 items-center gap-4 rounded-full px-4 text-sm font-medium transition-colors ${isActive ? "bg-accent/10 text-accent dark:bg-accent/20" : "text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"}`} title={!open ? label : undefined}>
        <Icon size={20} className="shrink-0" />
        <span className={`transition-opacity duration-200 ${open ? "opacity-100 w-auto" : "opacity-0 w-0 hidden"}`}>{label}</span>
      </Link>
    );
  }

  return (
    <>
      <button
        onClick={toggle}
        className="fixed left-4 top-3 z-50 inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
        title="Toggle navigation"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>
      {/* Surface + border + brand now flow from the active theme's variables (bg-page /
          border-edge / text-fg) instead of the old hardcoded light/dark pair, so switching
          themes visibly re-skins the whole rail. */}
      <aside className={`${open ? "w-72" : "w-[72px]"} sticky top-0 flex h-screen shrink-0 flex-col overflow-y-auto overflow-x-hidden border-r border-edge bg-page transition-all duration-300`}>
        <div className="flex h-16 shrink-0 items-center px-4 pl-16">
          <span className={`text-xl font-semibold tracking-tight text-fg transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 hidden"}`}>Infra Monitor Console</span>
        </div>
      <nav className="flex flex-1 flex-col px-2 py-4">
        <div className="grid gap-1">
          <NavItem href="/" icon={MonitorCog} label="Dashboard" />
          <NavItem href="/servers" icon={Server} label="Server Management" />
          {role === "admin" && (
            <>
              <NavItem href="/users" icon={Users} label="Users" />
              <NavItem href="/policies" icon={Shield} label="Server Policies" />
              
              <div className="mt-2">
                <button onClick={() => { if (!open) toggle(); setAdminOpen(!adminOpen); }} className="flex h-12 w-full items-center justify-between rounded-full px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800" title={!open ? "Administration" : undefined}>
                  <div className="flex items-center gap-4">
                    <Layers size={20} className="shrink-0" />
                    <span className={`transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0 hidden"}`}>Administration</span>
                  </div>
                  {open && <span className="text-slate-400">{adminOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>}
                </button>
                {adminOpen && open && (
                  <div className="mt-1 grid gap-1 pl-4">
                    <NavItem href="/master/server-types" icon={Settings} label="Server Types" />
                    <NavItem href="/master/environments" icon={Settings} label="Environments" />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        
        <div className="mt-auto grid gap-1 pt-4">
          <NavItem href="/profile" icon={UserCircle} label="Profile" />
          {role === "admin" && (
            <NavItem href="/appearance" icon={Palette} label="Appearance" />
          )}
          <button
            onClick={toggleTheme}
            className="group flex h-12 items-center gap-4 rounded-full px-4 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800"
            title={!open ? (dark ? "Light mode" : "Dark mode") : undefined}
            aria-pressed={dark}
          >
            {dark ? <Sun size={20} className="shrink-0" /> : <Moon size={20} className="shrink-0" />}
            <span className={`transition-opacity duration-200 ${open ? "opacity-100 w-auto" : "opacity-0 w-0 hidden"}`}>{dark ? "Light mode" : "Dark mode"}</span>
          </button>
          {/* Full theme selection lives right under the quick toggle. Only worth showing
              when the rail is expanded — the <select> needs the width to be usable. */}
          {open ? <ThemePicker variant="compact" /> : null}
        </div>
      </nav>
    </aside>
    </>
  );
}
