"use client";

import { FormEvent, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { createUser, deleteUser, getUsers, updateUser, ApiError, UserAccount } from "@/lib/api";
import { useConfirm } from "@/components/confirm-dialog";

export function UserManagement({ token }: { token: string }) {
  const { confirm, confirmDialog } = useConfirm();
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  // Edit-user dialog. `editingUser` holds the row being edited (null = closed). Email is not
  // editable, so it is shown read-only; a blank password keeps the stored one.
  const [editingUser, setEditingUser] = useState<UserAccount | null>(null);
  const [editName, setEditName] = useState("");
  const [editRole, setEditRole] = useState("developer");
  const [editPassword, setEditPassword] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  function openEdit(user: UserAccount) {
    setEditingUser(user);
    setEditName(user.full_name);
    setEditRole(user.role);
    setEditPassword("");
    setEditError("");
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingUser) return;
    setEditSaving(true);
    setEditError("");
    try {
      const payload: { full_name?: string; role?: string; password?: string } = {
        full_name: editName.trim(),
        role: editRole
      };
      // A blank password keeps the current one; only send it when the admin typed a new one.
      if (editPassword) payload.password = editPassword;
      await updateUser(token, editingUser.id, payload);
      setEditingUser(null);
      await load();
    } catch (error) {
      setEditError(error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Unable to update user");
    } finally {
      setEditSaving(false);
    }
  }

  async function load() {
    try {
      const nextUsers = await getUsers(token);
      setUsers(nextUsers);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load users");
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await createUser(token, {
        email: String(form.get("email") ?? ""),
        full_name: String(form.get("full_name") ?? ""),
        password: String(form.get("password") ?? ""),
        role: String(form.get("role") ?? "developer")
      });
      event.currentTarget.reset();
      await load();
      setMessage("User created.");
      setShowAddForm(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create user");
    } finally {
      setLoading(false);
    }
  }

  async function remove(user: UserAccount) {
    if (!(await confirm({ title: `Delete ${user.email}?`, message: "The user loses access immediately. This cannot be undone.", confirmLabel: "Delete user", danger: true }))) return;
    await deleteUser(token, user.id);
    await load();
  }

  return (
    <div className="space-y-6 px-6 py-6">
      {confirmDialog}

      {editingUser && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <button aria-label="Cancel" onClick={() => setEditingUser(null)} className="absolute inset-0 cursor-default" />
          <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Edit user</h2>
              <button onClick={() => setEditingUser(null)} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 dark:hover:bg-slate-800"><X size={16} /></button>
            </div>
            <form onSubmit={saveEdit} className="grid gap-4 p-5">
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Email
                <input value={editingUser.email} readOnly disabled className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-500 outline-none ring-1 ring-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:ring-slate-700" />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Full name
                <input value={editName} onChange={(e) => setEditName(e.target.value)} required placeholder="Full name" className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700" />
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Role
                <select value={editRole} onChange={(e) => setEditRole(e.target.value)} className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700">
                  <option value="admin">Admin</option>
                  <option value="developer">Developer</option>
                  <option value="support">Support</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                New password
                <input type="password" value={editPassword} onChange={(e) => setEditPassword(e.target.value)} autoComplete="new-password" placeholder="Leave blank to keep current" className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700" />
              </label>
              {editError && <p className="text-sm font-medium text-danger dark:text-red-400">{editError}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button type="button" onClick={() => setEditingUser(null)} className="h-10 rounded-full border border-slate-200 px-5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">Cancel</button>
                <button type="submit" disabled={editSaving || !editName.trim()} className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">
                  {editSaving ? <Loader2 size={16} className="animate-spin" /> : null}
                  Save changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
        <div className="flex items-center justify-between border-b border-slate-100 bg-white px-6 py-5 font-semibold text-slate-900 dark:border-slate-800 dark:bg-[#1e1e1e] dark:text-slate-100">
          <div className="flex items-center gap-3">
            <Users size={18} className="text-accent" />
            <h2 className="text-base font-semibold">User Accounts</h2>
          </div>
          <button onClick={() => setShowAddForm(!showAddForm)} className="inline-flex h-9 items-center justify-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent/80">
            {showAddForm ? <><X size={16} /> Cancel</> : <><Plus size={16} /> Create User</>}
          </button>
        </div>
        
        {showAddForm && (
          <div className="border-b border-slate-100 bg-slate-50 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <form onSubmit={submit} className="grid gap-4 md:grid-cols-5">
              <input name="email" type="email" required placeholder="Email" className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700" />
              <input name="full_name" required placeholder="Full name" className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700" />
              <input name="password" type="password" required placeholder="Password" className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700" />
              <select name="role" className="h-12 rounded-xl border-none bg-white px-4 text-sm font-medium text-slate-900 outline-none ring-1 ring-slate-200 transition-colors focus:ring-2 focus:ring-accent dark:bg-[#121212] dark:text-slate-100 dark:ring-slate-700">
                <option value="developer">Developer</option>
                <option value="support">Support</option>
                <option value="admin">Admin</option>
              </select>
              <button disabled={loading} className="inline-flex h-12 items-center justify-center rounded-xl bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">{loading ? "Creating..." : "Save User"}</button>
              {message ? <p className="text-sm font-medium text-slate-700 dark:text-slate-300 md:col-span-5">{message}</p> : null}
            </form>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              <tr><th className="px-6 py-4 font-semibold">Email</th><th className="px-6 py-4 font-semibold">Name</th><th className="px-6 py-4 font-semibold">Role</th><th className="px-6 py-4 font-semibold">Action</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/50">
              {users.map((user) => (
                <tr key={user.id} className="transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-6 py-4 font-medium text-slate-700 dark:text-slate-300">{user.email}</td>
                  <td className="px-6 py-4 font-medium text-slate-700 dark:text-slate-300">{user.full_name}</td>
                  <td className="px-6 py-4 font-medium text-slate-700 dark:text-slate-300 capitalize">{user.role}</td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <button onClick={() => openEdit(user)} title="Edit user" aria-label="Edit user" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-accent/10 hover:text-accent dark:text-slate-400">
                        <Pencil size={15} />
                      </button>
                      <button onClick={() => void remove(user)} title="Delete user" aria-label="Delete user" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-red-100 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-900/40 dark:hover:text-red-300">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
