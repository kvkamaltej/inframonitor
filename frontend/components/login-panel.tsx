"use client";

import { LockKeyhole } from "lucide-react";
import { FormEvent, useState } from "react";
import { login } from "@/lib/api";

export function LoginPanel({ onLogin }: { onLogin: (token: string) => void }) {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const token = await login(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
      window.localStorage.setItem("inframonitor-token", token);
      onLogin(token);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-3xl bg-surface p-8 shadow-sm ring-1 ring-edge">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent dark:bg-accent/20">
            <LockKeyhole size={28} />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Welcome Back</h1>
            <p className="mt-1 text-sm font-medium text-slate-500 dark:text-slate-400">Sign in to manage infrastructure</p>
          </div>
        </div>
        <div className="grid gap-4">
          <input name="email" type="email" required defaultValue="admin@inframonitor.local" className="h-14 rounded-2xl border-none bg-slate-100 px-5 text-sm font-medium text-slate-900 outline-none transition-colors focus:bg-accent/5 focus:ring-2 focus:ring-accent dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-accent/10" />
          <input name="password" type="password" required placeholder="Password" className="h-14 rounded-2xl border-none bg-slate-100 px-5 text-sm font-medium text-slate-900 outline-none transition-colors focus:bg-accent/5 focus:ring-2 focus:ring-accent dark:bg-slate-800 dark:text-slate-100 dark:focus:bg-accent/10" />
          <button disabled={loading} className="mt-4 flex h-12 w-full items-center justify-center rounded-full bg-accent text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
            {loading ? "Signing in..." : "Sign in"}
          </button>
          {message ? <p className="mt-2 text-center text-sm font-medium text-red-600 dark:text-red-400">{message}</p> : null}
        </div>
      </form>
    </main>
  );
}
