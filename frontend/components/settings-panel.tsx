"use client";

import { FormEvent, useEffect, useState } from "react";
import { addApplicationType, addEnvironment, addServerType, getOptions, OptionList, removeApplicationType, removeEnvironment, removeServerType } from "@/lib/api";
import { X } from "lucide-react";

type SettingsMode = "all" | "environments" | "server-types" | "application-types";
type OptionKind = "environment" | "server_type" | "application_type";

export function SettingsPanel({ token, mode = "all" }: { token: string; mode?: SettingsMode }) {
  const [options, setOptions] = useState<OptionList>({ environments: [], server_types: [], application_types: [] });
  const [message, setMessage] = useState("");

  async function load() {
    setOptions(await getOptions(token));
  }

  useEffect(() => {
    void load();
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>, kind: OptionKind) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = String(form.get("value") ?? "");
    if (!value.trim()) return;
    const next = kind === "environment" ? await addEnvironment(token, value) : kind === "server_type" ? await addServerType(token, value) : await addApplicationType(token, value);
    setOptions(next);
    setMessage(`${value} added.`);
    event.currentTarget.reset();
  }

  async function remove(kind: OptionKind, value: string) {
    const next = kind === "environment" ? await removeEnvironment(token, value) : kind === "server_type" ? await removeServerType(token, value) : await removeApplicationType(token, value);
    setOptions(next);
    setMessage(`${value} removed.`);
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {mode === "all" || mode === "environments" ? <OptionBox title="Environments" values={options.environments} onSubmit={(event) => void submit(event, "environment")} onRemove={(value) => void remove("environment", value)} /> : null}
      {mode === "all" || mode === "server-types" ? <OptionBox title="Server Types" values={options.server_types} onSubmit={(event) => void submit(event, "server_type")} onRemove={(value) => void remove("server_type", value)} /> : null}
      {mode === "all" || mode === "application-types" ? <OptionBox title="Application Types" values={options.application_types} onSubmit={(event) => void submit(event, "application_type")} onRemove={(value) => void remove("application_type", value)} /> : null}
      {message ? <p className="text-sm text-slate-600 dark:text-slate-300 md:col-span-2">{message}</p> : null}
    </div>
  );
}

function OptionBox({ title, values, onSubmit, onRemove }: { title: string; values: string[]; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onRemove: (value: string) => void; }) {
  return (
    <div className="overflow-hidden rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-[#1e1e1e] dark:ring-slate-800">
      <div className="border-b border-slate-100 bg-slate-50 px-6 py-4 font-semibold text-slate-900 dark:border-slate-800/50 dark:bg-slate-800/20 dark:text-slate-100">{title}</div>
      <div className="p-6">
        <div className="mb-6 flex flex-wrap gap-2">
          {values.map((value) => (
            <span key={value} className="inline-flex h-8 items-center gap-1 rounded-full bg-slate-100 pl-3 pr-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {value}
              <button onClick={() => onRemove(value)} className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-200 hover:text-red-500 dark:hover:bg-slate-700">
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={onSubmit} className="flex gap-3">
          <input name="value" placeholder="Add option" className="h-12 min-w-0 flex-1 rounded-xl border-none bg-slate-100 px-4 text-sm font-medium text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100" />
          <button className="inline-flex h-12 items-center justify-center rounded-full bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent/80">Add</button>
        </form>
      </div>
    </div>
  );
}
