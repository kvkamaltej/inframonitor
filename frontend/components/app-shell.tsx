"use client";

import Link from "next/link";
import { KeyRound, LogOut, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { LoginPanel } from "@/components/login-panel";
import { Sidebar } from "@/components/sidebar";
import { getMe, Me } from "@/lib/api";

const BANNER_DISMISS_KEY = "inframonitor-default-password-banner";
const BANNER_DISMISS_MS = 24 * 60 * 60 * 1000;

// The dismissal is deliberately not permanent: the install really is running on a
// published default password, so silencing the warning forever would turn a security
// problem into a checkbox. It comes back after 24h and on any fresh sign-in.
type DismissRecord = { at: number; session: string };

// Cheap non-reversible fingerprint (djb2) of the active token, so a new sign-in mints a
// new session id and re-shows the banner. We only need "is this a different token", not
// secrecy, and we must not copy the token itself into a second storage slot.
function sessionFingerprint(token: string): string {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash = ((hash << 5) + hash + token.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function readDismissal(): boolean {
  try {
    const raw = window.localStorage.getItem(BANNER_DISMISS_KEY);
    if (!raw) return false;
    const record = JSON.parse(raw) as Partial<DismissRecord> | null;
    const at = typeof record?.at === "number" ? record.at : 0;
    const session = typeof record?.session === "string" ? record.session : "";
    const token = window.localStorage.getItem("inframonitor-token") ?? "";
    const expired = !at || Date.now() - at >= BANNER_DISMISS_MS;
    const staleSession = session !== sessionFingerprint(token);
    if (expired || staleSession) {
      window.localStorage.removeItem(BANNER_DISMISS_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function clearDefaultPasswordDismissal() {
  try {
    window.localStorage.removeItem(BANNER_DISMISS_KEY);
  } catch {
    // localStorage can throw in sandboxed contexts; nothing to recover.
  }
}

// Exported so server-detail-app.tsx, which hand-rolls its own shell instead of using
// AppShell, can render the identical banner without duplicating it. Props are unchanged
// on purpose — the dismissal state is read from localStorage inside the component so
// both hosts get the behaviour without threading anything through.
export function DefaultPasswordBanner({ me }: { me: Me | null }) {
  // null until the effect has read localStorage: reading it during render would break
  // hydration on the static export, and guessing either way flashes the wrong state.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    setDismissed(readDismissal());
  }, []);

  function dismiss() {
    try {
      const token = window.localStorage.getItem("inframonitor-token") ?? "";
      const record: DismissRecord = { at: Date.now(), session: sessionFingerprint(token) };
      window.localStorage.setItem(BANNER_DISMISS_KEY, JSON.stringify(record));
    } catch {
      // Storage unavailable: hide for this view only, it returns on reload.
    }
    setDismissed(true);
  }

  if (!me?.using_default_password) return null;
  if (dismissed !== false) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b-2 border-danger bg-danger/10 px-6 py-3 dark:border-red-500 dark:bg-red-500/15">
      <KeyRound size={18} className="shrink-0 text-danger dark:text-red-400" />
      <p className="text-sm font-semibold text-danger dark:text-red-300">
        This account still uses the default password.
        <span className="ml-1.5 font-medium text-slate-700 dark:text-slate-300">
          Anyone who knows the shipped default can sign in as {me.email}.
        </span>
      </p>
      <Link
        href="/profile"
        className="inline-flex h-8 items-center rounded-full bg-danger px-4 text-xs font-semibold text-white transition-colors hover:bg-danger/80"
      >
        Change it now
      </Link>
      <button
        type="button"
        onClick={dismiss}
        title="Hide for 24 hours"
        aria-label="Hide this warning for 24 hours"
        className="ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-danger transition-colors hover:bg-danger/20 dark:text-red-300 dark:hover:bg-red-500/20"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function AppShell({ title, subtitle, children }: { title: string; subtitle?: string; children: (props: { token: string; me: Me; reloadMe: () => Promise<void> }) => ReactNode }) {
  const [token, setToken] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);

  async function load(activeToken = token) {
    if (!activeToken) {
      setLoading(false);
      return;
    }
    try {
      setMe(await getMe(activeToken));
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load session");
      logout();
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem("inframonitor-token");
    // Signing out ends the dismissal window: two logins in the same second can mint a
    // byte-identical JWT, so the fingerprint alone would not notice the new session.
    clearDefaultPasswordDismissal();
    setToken("");
    setMe(null);
  }

  useEffect(() => {
    const saved = localStorage.getItem("inframonitor-token") ?? "";
    setToken(saved);
    if (saved) {
      void load(saved);
    } else {
      setLoading(false);
    }
  }, []);

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-[#f8f9fa] dark:bg-[#121212]"><div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" /></div>;
  if (!token || !me) return <LoginPanel onLogin={(nextToken) => { setToken(nextToken); setLoading(true); void load(nextToken); }} />;

  return (
    <main className="flex min-h-screen">
      <Sidebar role={me.role} />
      <div className="min-w-0 flex-1">
        <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-[#1e1e1e]">
          <div className="flex h-16 items-center justify-between px-6 pl-16">
            <div>
              <h1 className="text-xl font-medium tracking-tight text-slate-900 dark:text-slate-100">{title}</h1>
              {subtitle ? <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{subtitle}</p> : null}
            </div>
            <div className="flex items-center gap-4 text-sm font-medium text-slate-700 dark:text-slate-200">
              <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 dark:bg-slate-800">
                <ShieldCheck size={16} className="text-accent" />
                <span className="capitalize">{me.role}</span>
              </div>
              <button onClick={logout} className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700" title="Sign out">
                <LogOut size={16} />
              </button>
            </div>
          </div>
        </header>
        <DefaultPasswordBanner me={me} />
        {message ? <div className="mx-6 mt-6 border border-red-200 bg-red-50 p-3 text-sm text-red-800">{message}</div> : null}
        {children({ token, me, reloadMe: () => load(token) })}
      </div>
    </main>
  );
}
