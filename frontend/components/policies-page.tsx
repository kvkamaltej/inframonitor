"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  AccessPolicy,
  assignPolicyUsers,
  createPolicy,
  getOptions,
  getPolicies,
  getServers,
  getUserServerAccess,
  getUsers,
  OptionList,
  Server,
  updateUserServerAccess,
  UserAccount
} from "@/lib/api";
import { AppShell } from "@/components/app-shell";

export function PoliciesPage() {
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [policies, setPolicies] = useState<AccessPolicy[]>([]);
  const [options, setOptions] = useState<OptionList>({ environments: [], server_types: [], application_types: [] });
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  
  // Multi-select state for the policy form
  const [selectedEnvironments, setSelectedEnvironments] = useState<string[]>([]);
  const [selectedServerTypes, setSelectedServerTypes] = useState<string[]>([]);
  const [selectedPolicyServerIds, setSelectedPolicyServerIds] = useState<string[]>([]);
  
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function load(token: string) {
    try {
      const [nextUsers, nextServers, nextPolicies, nextOptions] = await Promise.all([
        getUsers(token), 
        getServers(token), 
        getPolicies(token),
        getOptions(token)
      ]);
      setUsers(nextUsers);
      setServers(nextServers);
      setPolicies(nextPolicies);
      setOptions(nextOptions);
      if (!selectedUserId && nextUsers.length) setSelectedUserId(nextUsers[0].id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load data");
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("inframonitor-token");
    if (token) void load(token);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("inframonitor-token");
    if (!selectedUserId || !token) return;
    void getUserServerAccess(token, selectedUserId)
      .then((access) => setSelectedServerIds(access.server_ids))
      .catch((error) => setMessage(error instanceof Error ? error.message : "Unable to load server access"));
  }, [selectedUserId]);

  async function saveServerAccess(token: string) {
    if (!selectedUserId) return;
    setLoading(true);
    try {
      await updateUserServerAccess(token, selectedUserId, selectedServerIds);
      setMessage("Server access updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update server access");
    } finally {
      setLoading(false);
    }
  }

  async function submitPolicy(event: FormEvent<HTMLFormElement>, token: string) {
    event.preventDefault();
    setLoading(true);
    setMessage("");
    const form = new FormData(event.currentTarget);
    const split = (name: string) => String(form.get(name) ?? "").split(",").map((item) => item.trim()).filter(Boolean);
    try {
      await createPolicy(token, {
        name: String(form.get("name") ?? ""),
        description: String(form.get("description") ?? ""),
        environments: selectedEnvironments,
        server_types: selectedServerTypes,
        tags: split("tags"),
        server_ids: selectedPolicyServerIds
      });
      event.currentTarget.reset();
      setSelectedEnvironments([]);
      setSelectedServerTypes([]);
      setSelectedPolicyServerIds([]);
      await load(token);
      setMessage("Policy created.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create policy");
    } finally {
      setLoading(false);
    }
  }

  async function togglePolicyUser(token: string, policy: AccessPolicy, userId: number) {
    const assigned = policy.assigned_user_ids.includes(userId)
      ? policy.assigned_user_ids.filter((id) => id !== userId)
      : [...policy.assigned_user_ids, userId];
    try {
      await assignPolicyUsers(token, policy.id, assigned);
      await load(token);
      setMessage("Policy assignment updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to assign policy");
    }
  }

  function toggleServer(serverId: string) {
    setSelectedServerIds((current) => current.includes(serverId) ? current.filter((id) => id !== serverId) : [...current, serverId]);
  }

  function toggleEnvironment(env: string) {
    setSelectedEnvironments(current => current.includes(env) ? current.filter(e => e !== env) : [...current, env]);
  }

  function toggleServerType(st: string) {
    setSelectedServerTypes(current => current.includes(st) ? current.filter(s => s !== st) : [...current, st]);
  }

  function togglePolicyServer(serverId: string) {
    setSelectedPolicyServerIds(current => current.includes(serverId) ? current.filter(id => id !== serverId) : [...current, serverId]);
  }

  return (
    <AppShell title="Server Policies" subtitle="Manage visibility and server access groups">
      {({ token }) => (
        <div className="grid gap-6 px-6 py-6 xl:grid-cols-2">
          {message ? <div className="col-span-full border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{message}</div> : null}
          <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
            <div className="border-b border-slate-100 bg-slate-50 px-6 py-4 font-semibold text-slate-900 dark:border-slate-800/50 dark:bg-slate-800/20 dark:text-slate-100">Server Assignment</div>
            <div className="p-6">
              <select value={selectedUserId ?? ""} onChange={(event) => setSelectedUserId(Number(event.target.value))} className="mb-6 h-12 w-full rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100">
                {users.map((user) => <option key={user.id} value={user.id}>{user.email} ({user.role})</option>)}
              </select>
              <div className="max-h-80 overflow-y-auto overflow-x-hidden rounded-xl bg-slate-50 ring-1 ring-slate-200 dark:bg-slate-800/20 dark:ring-slate-700">
                {servers.map((server) => (
                  <label key={server.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 transition-colors last:border-b-0 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50">
                    <input type="checkbox" checked={selectedServerIds.includes(server.id)} onChange={() => toggleServer(server.id)} className="h-4 w-4 rounded border-slate-300 text-accent transition focus:ring-accent dark:border-slate-600 dark:bg-slate-700 dark:checked:bg-accent" />
                    <span className="min-w-0 flex-1 truncate">{server.hostname} - {server.ip_address} - {server.environment}</span>
                  </label>
                ))}
                {servers.length === 0 ? <p className="p-4 text-sm font-medium text-slate-500">No servers registered.</p> : null}
              </div>
              <button disabled={loading || !selectedUserId} onClick={() => void saveServerAccess(token)} className="mt-6 mb-8 inline-flex h-12 items-center justify-center rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">Save Server Access</button>
              
              {selectedUserId && (
                <>
                  <div className="mb-4 text-sm font-semibold text-slate-900 dark:text-slate-100">Assigned Group Policies</div>
                  <div className="grid gap-3">
                    {policies.map(policy => (
                      <label key={policy.id} className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/20 dark:text-slate-300 dark:hover:bg-slate-800/50">
                        <input type="checkbox" checked={policy.assigned_user_ids.includes(selectedUserId)} onChange={() => void togglePolicyUser(token, policy, selectedUserId)} className="h-4 w-4 rounded border-slate-300 text-accent transition focus:ring-accent dark:border-slate-600 dark:bg-slate-700 dark:checked:bg-accent" />
                        <span className="min-w-0 flex-1 truncate">{policy.name}</span>
                      </label>
                    ))}
                    {policies.length === 0 ? <p className="text-sm font-medium text-slate-500">No policies available.</p> : null}
                  </div>
                </>
              )}
              
              <p className="mt-6 text-xs font-medium text-slate-500 dark:text-slate-400">Admins always see all servers. Developer/support users see direct grants plus policy grants.</p>
            </div>
          </div>

          <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
            <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-6 py-4 dark:border-slate-800/50 dark:bg-slate-800/20">
              <div className="font-semibold text-slate-900 dark:text-slate-100">Group Policies</div>
              <button onClick={() => setShowCreateForm(!showCreateForm)} className="inline-flex h-8 items-center justify-center rounded-full bg-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-accent/80">
                {showCreateForm ? "Cancel" : "+ Create Policy"}
              </button>
            </div>
            
            {showCreateForm && (
              <form onSubmit={(e) => void submitPolicy(e, token)} className="grid gap-4 border-b border-slate-100 p-6 dark:border-slate-800/50">
                <input name="name" required placeholder="Policy name" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
                <input name="description" placeholder="Description" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
              
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Environments</div>
                <div className="flex flex-wrap gap-2">
                  {options.environments.map(env => (
                    <label key={env} className={`cursor-pointer inline-flex items-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${selectedEnvironments.includes(env) ? "bg-accent text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800"}`}>
                      <input type="checkbox" className="hidden" checked={selectedEnvironments.includes(env)} onChange={() => toggleEnvironment(env)} />
                      {env}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Server Types</div>
                <div className="flex flex-wrap gap-2">
                  {options.server_types.map(st => (
                    <label key={st} className={`cursor-pointer inline-flex items-center rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${selectedServerTypes.includes(st) ? "bg-accent text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:hover:bg-slate-800"}`}>
                      <input type="checkbox" className="hidden" checked={selectedServerTypes.includes(st)} onChange={() => toggleServerType(st)} />
                      {st}
                    </label>
                  ))}
                </div>
              </div>

              <input name="tags" placeholder="Tags, comma separated" className="h-12 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
              
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Specific Servers</div>
                <div className="max-h-48 overflow-y-auto rounded-xl bg-slate-50 ring-1 ring-slate-200 dark:bg-slate-800/20 dark:ring-slate-700">
                  {servers.map((server) => (
                    <label key={server.id} className="flex cursor-pointer items-center gap-3 border-b border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 transition-colors last:border-b-0 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50">
                      <input type="checkbox" checked={selectedPolicyServerIds.includes(server.id)} onChange={() => togglePolicyServer(server.id)} className="h-4 w-4 rounded border-slate-300 text-accent transition focus:ring-accent dark:border-slate-600 dark:bg-slate-700 dark:checked:bg-accent" />
                      <span className="min-w-0 flex-1 truncate">{server.hostname} - {server.ip_address}</span>
                    </label>
                  ))}
                  {servers.length === 0 ? <p className="p-4 text-xs font-medium text-slate-500">No servers available.</p> : null}
                </div>
              </div>

              <div className="flex justify-end">
                <button disabled={loading} className="inline-flex h-12 w-fit items-center justify-center rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50">Create Policy</button>
              </div>
            </form>
            )}

            <div className="space-y-4 p-6">
              {policies.map((policy) => (
                <div key={policy.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-5 dark:border-slate-700 dark:bg-slate-800/20">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-base font-semibold text-slate-900 dark:text-slate-100">{policy.name}</div>
                      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{policy.description || "No description provided."}</div>
                    </div>
                  </div>
                  
                  <div className="mt-4 grid gap-x-4 gap-y-2 sm:grid-cols-2 text-xs text-slate-600 dark:text-slate-300">
                    <div><span className="font-semibold text-slate-500 uppercase tracking-wider mr-2">Envs:</span> {policy.environments.join(", ") || "-"}</div>
                    <div><span className="font-semibold text-slate-500 uppercase tracking-wider mr-2">Types:</span> {policy.server_types.join(", ") || "-"}</div>
                    <div><span className="font-semibold text-slate-500 uppercase tracking-wider mr-2">Tags:</span> {policy.tags.join(", ") || "-"}</div>
                    <div><span className="font-semibold text-slate-500 uppercase tracking-wider mr-2">Servers:</span> {policy.server_ids.join(", ") || "-"}</div>
                  </div>

                  <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-700">
                    <div className="mb-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Assigned Users</div>
                    <div className="flex flex-wrap gap-4">
                      {users.map((user) => (
                        <label key={user.id} className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                          <input type="checkbox" checked={policy.assigned_user_ids.includes(user.id)} onChange={() => void togglePolicyUser(token, policy, user.id)} className="h-4 w-4 rounded border-slate-300 text-accent transition focus:ring-accent dark:border-slate-600 dark:bg-slate-700 dark:checked:bg-accent" />
                          {user.email}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
              {policies.length === 0 ? <p className="text-sm font-medium text-slate-500">No policies created yet.</p> : null}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
