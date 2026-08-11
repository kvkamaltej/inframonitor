"use client";

import { FormEvent, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { changePassword } from "@/lib/api";

export function ProfilePage() {
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>, token: string) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("current_password") ?? "");
    const newPassword = String(form.get("new_password") ?? "");
    const confirmPassword = String(form.get("confirm_password") ?? "");
    if (newPassword !== confirmPassword) {
      setMessage("New password and confirmation do not match.");
      setLoading(false);
      return;
    }
    try {
      const result = await changePassword(token, currentPassword, newPassword);
      setMessage(result.message);
      event.currentTarget.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to change password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell title="Profile" subtitle="Manage your account">
      {({ token, me }) => (
        <section className="mx-auto max-w-2xl px-6 py-12">
          <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
            <div className="border-b border-slate-100 bg-slate-50 px-8 py-6 dark:border-slate-800/50 dark:bg-slate-800/20">
              <div className="text-xl font-semibold text-slate-900 dark:text-slate-100">{me.email}</div>
              <div className="mt-1 text-sm font-medium text-slate-500 dark:text-slate-400 capitalize">{me.role} Account</div>
            </div>
            <form onSubmit={(event) => void submit(event, token)} className="grid gap-4 p-8">
              <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Change Password</h3>
              <input name="current_password" type="password" required placeholder="Current password" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
              <input name="new_password" type="password" required minLength={8} placeholder="New password" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
              <input name="confirm_password" type="password" required minLength={8} placeholder="Confirm new password" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
              <button disabled={loading} className="mt-4 inline-flex h-12 items-center justify-center rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">{loading ? "Saving..." : "Change Password"}</button>
              {message ? <p className="mt-2 text-center text-sm font-medium text-slate-700 dark:text-slate-300">{message}</p> : null}
            </form>
          </div>
        </section>
      )}
    </AppShell>
  );
}
