"use client";

import { ChangeEvent, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, FileSpreadsheet, Info, Loader2, ShieldAlert, Upload } from "lucide-react";
import { discoverServer, importServers, ServerImportResult } from "@/lib/api";

const COLUMNS = [
  { name: "hostname", note: "required" },
  { name: "ip_address", note: "required" },
  { name: "username", note: "required" },
  { name: "password", note: "optional" },
  { name: "private_key", note: "optional, literal \\n allowed" },
  { name: "ssh_port", note: "defaults 22" },
  { name: "environment", note: "defaults production" },
  { name: "server_type", note: "defaults application" },
  { name: "alias", note: "optional" },
  { name: "tags", note: "semicolon separated" },
  { name: "business_owner", note: "optional" },
  { name: "support_contact", note: "optional" }
];

const HEADER_LINE = COLUMNS.map((column) => column.name).join(",");
const EXAMPLE_LINE = "web01.example.com,10.0.0.11,ems,s3cret,,22,production,application,Web 01,web;prod,Platform Team,ops@example.com";
const EXAMPLE_CSV = `${HEADER_LINE}\n${EXAMPLE_LINE}`;

const ROW_STYLES: Record<string, string> = {
  valid: "text-accent",
  created: "text-accent",
  skipped: "text-warn dark:text-amber-400",
  failed: "text-danger dark:text-red-400"
};

export function CsvImportPanel({ token, onImported }: { token: string; onImported: () => void }) {
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [validated, setValidated] = useState("");
  const [preview, setPreview] = useState<ServerImportResult | null>(null);
  const [result, setResult] = useState<ServerImportResult | null>(null);
  const [busy, setBusy] = useState<"" | "validate" | "import">("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  // Auto-discovery progress after an import. null when idle; the discovery runs client-side,
  // one host at a time bounded to a few at once, because a synchronous server-side discovery
  // of N hosts (~20s each) would blow the request timeout and exhaust the threadpool — which
  // is exactly why import itself does not discover.
  const [discovery, setDiscovery] = useState<{ total: number; done: number; failed: number } | null>(null);

  const shown = result ?? preview;
  const canValidate = csvText.trim().length > 0 && busy === "";
  const readyToImport =
    preview !== null && validated === csvText && csvText.trim().length > 0 && preview.created > 0 && busy === "";

  function resetOutcome() {
    setPreview(null);
    setResult(null);
    setValidated("");
    setError("");
  }

  function readFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => {
      setError(`Unable to read ${file.name}.`);
      input.value = "";
    };
    reader.onload = () => {
      setCsvText(String(reader.result ?? ""));
      setFileName(file.name);
      resetOutcome();
      input.value = "";
    };
    reader.readAsText(file);
  }

  function editText(event: ChangeEvent<HTMLTextAreaElement>) {
    setCsvText(event.currentTarget.value);
    setFileName("");
    resetOutcome();
  }

  async function copyExample() {
    try {
      await navigator.clipboard.writeText(EXAMPLE_CSV);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Clipboard is unavailable. Select the example text and copy it manually.");
    }
  }

  async function validate() {
    const text = csvText;
    setBusy("validate");
    setError("");
    setResult(null);
    try {
      const outcome = await importServers(token, text, true);
      setPreview(outcome);
      setValidated(text);
    } catch (caught) {
      setPreview(null);
      setValidated("");
      setError(caught instanceof Error ? caught.message : "Validation failed");
    } finally {
      setBusy("");
    }
  }

  async function commit() {
    const text = csvText;
    setBusy("import");
    setError("");
    setDiscovery(null);
    try {
      const outcome = await importServers(token, text, false);
      setResult(outcome);
      setPreview(null);
      setValidated("");
      onImported();
      // Kick discovery for the servers that were just created and have credentials to run it.
      void autoDiscover(outcome);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed");
    } finally {
      setBusy("");
    }
  }

  async function autoDiscover(outcome: ServerImportResult) {
    const targets = outcome.rows.filter((row) => row.status === "created" && row.has_credentials && row.server_id);
    if (targets.length === 0) return;
    setDiscovery({ total: targets.length, done: 0, failed: 0 });
    const queue = [...targets];
    let failed = 0;
    async function worker() {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        try {
          const outcomeForServer = await discoverServer(token, next.server_id, {});
          // discovery returns HTTP 200 with ok:false on an SSH failure, not an exception
          if (!outcomeForServer.ok) failed += 1;
        } catch {
          failed += 1;
        }
        setDiscovery((current) => (current ? { ...current, done: current.done + 1, failed } : current));
      }
    }
    // three at a time: enough to move through a rack quickly without opening a dozen SSH
    // connections to the same subnet at once
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
    // refresh the inventory so the newly discovered OS/vitals/status show without a manual reload
    onImported();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-2xl border border-danger/40 bg-danger/5 p-4 dark:border-red-500/40 dark:bg-red-500/10">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-danger dark:text-red-400" />
        <div className="space-y-1 text-xs font-medium text-slate-700 dark:text-slate-300">
          <p className="text-sm font-semibold text-danger dark:text-red-400">This CSV holds plaintext credentials</p>
          <p>
            SSH passwords and private keys sit unencrypted in the file. The backend encrypts them on import and never
            echoes them back, but the file on your disk stays readable.{" "}
            <strong className="font-semibold">Delete the CSV as soon as the import finishes</strong>, and do not commit it
            or send it over chat or email.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-900/40">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={16} className="text-accent" />
            <h3 className="text-sm font-semibold text-ink dark:text-slate-100">Expected columns</h3>
          </div>
          <button
            type="button"
            onClick={() => void copyExample()}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-line px-3 text-xs font-semibold text-ink transition-colors hover:bg-white dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy example"}
          </button>
        </div>
        <p className="mt-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          A header row is required. Matching is case-insensitive and order-independent; unknown columns are ignored.
        </p>
        <ul className="mt-3 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {COLUMNS.map((column) => (
            <li key={column.name} className="flex items-baseline gap-2 text-xs">
              <code className="font-mono font-semibold text-ink dark:text-slate-100">{column.name}</code>
              <span className="font-medium text-slate-500 dark:text-slate-400">{column.note}</span>
            </li>
          ))}
        </ul>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-white p-3 text-[11px] leading-relaxed text-slate-700 ring-1 ring-line dark:bg-[#121212] dark:text-slate-300 dark:ring-slate-700">
{EXAMPLE_CSV}
        </pre>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-line bg-white p-4 dark:border-slate-700 dark:bg-[#1e1e1e]">
        <Info size={18} className="mt-0.5 shrink-0 text-accent" />
        <p className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Import creates inventory records only &mdash; it does <strong className="font-semibold">not</strong> run SSH
          discovery, because N hosts at roughly 23 seconds each would blow the request timeout. Every imported server
          lands with status <code className="font-mono font-semibold">unknown</code> and no OS, storage, service or Tomcat
          data until you open it and run discovery for that server.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold text-ink transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800">
            <Upload size={16} />
            Choose CSV file
            <input type="file" accept=".csv,text/csv" onChange={readFile} className="hidden" />
          </label>
          {fileName ? (
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Loaded <span className="font-semibold text-ink dark:text-slate-200">{fileName}</span>
            </span>
          ) : (
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">or paste the CSV below</span>
          )}
        </div>

        <textarea
          value={csvText}
          onChange={editText}
          spellCheck={false}
          placeholder={`${HEADER_LINE}\n...`}
          className="min-h-40 w-full rounded-xl border-none bg-slate-100 px-4 py-3 font-mono text-xs text-slate-900 outline-none transition-colors focus:ring-2 focus:ring-accent dark:bg-slate-800/50 dark:text-slate-100"
        />

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!canValidate}
            onClick={() => void validate()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-accent px-5 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 disabled:opacity-50"
          >
            {busy === "validate" ? "Validating..." : "1. Dry run"}
          </button>
          <button
            type="button"
            disabled={!readyToImport}
            onClick={() => void commit()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent/80 disabled:opacity-50"
          >
            {busy === "import" ? "Importing..." : "2. Import servers"}
          </button>
          {!readyToImport && busy === "" ? (
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {preview && validated !== csvText
                ? "The CSV changed since the dry run. Run the dry run again to enable import."
                : "Run the dry run first; import unlocks once at least one row would be created."}
            </span>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-3 rounded-2xl border border-danger/40 bg-danger/5 p-4 dark:border-red-500/40 dark:bg-red-500/10">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger dark:text-red-400" />
          <p className="text-sm font-medium text-danger dark:text-red-400">{error}</p>
        </div>
      ) : null}

      {discovery ? (
        <div className="flex items-center gap-3 rounded-2xl border border-accent/30 bg-accent/5 px-4 py-3 text-xs font-medium text-slate-700 dark:border-accent/40 dark:bg-accent/10 dark:text-slate-200">
          {discovery.done < discovery.total ? (
            <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
          ) : (
            <CheckCircle2 size={16} className="shrink-0 text-accent" />
          )}
          <span>
            {discovery.done < discovery.total
              ? `Discovering services on imported servers… ${discovery.done} of ${discovery.total}`
              : `Discovery finished for ${discovery.total} imported server${discovery.total === 1 ? "" : "s"}.`}
            {discovery.failed > 0 ? (
              <span className="ml-1 text-warn dark:text-amber-400">
                {discovery.failed} could not be reached — check credentials, then discover them from the server page.
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      {shown ? (
        <div className="overflow-hidden rounded-2xl border border-line dark:border-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-900/40">
            <h3 className="text-sm font-semibold text-ink dark:text-slate-100">
              {shown.dry_run ? "Dry run preview — nothing was written" : "Import complete"}
            </h3>
            <div className="flex flex-wrap gap-3 text-xs font-semibold">
              <span className="text-slate-600 dark:text-slate-300">{shown.total} rows</span>
              <span className="text-accent">
                {shown.created} {shown.dry_run ? "will be created" : "created"}
              </span>
              <span className="text-warn dark:text-amber-400">{shown.skipped} skipped</span>
              <span className="text-danger dark:text-red-400">{shown.failed} failed</span>
            </div>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-3 font-semibold">Row</th>
                  <th className="px-4 py-3 font-semibold">Hostname</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line dark:divide-slate-800">
                {shown.rows.map((row) => (
                  <tr key={`${row.row}-${row.hostname}`} className="bg-white dark:bg-[#1e1e1e]">
                    <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">{row.row}</td>
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-ink dark:text-slate-100">{row.hostname || "—"}</td>
                    <td className={`px-4 py-3 text-xs font-semibold capitalize ${ROW_STYLES[row.status] ?? "text-slate-600 dark:text-slate-300"}`}>
                      {row.status}
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-slate-600 dark:text-slate-300">{row.message}</td>
                  </tr>
                ))}
                {shown.rows.length === 0 ? (
                  <tr className="bg-white dark:bg-[#1e1e1e]">
                    <td colSpan={4} className="px-4 py-6 text-center text-xs font-medium text-slate-500 dark:text-slate-400">
                      No data rows found. Check that the file has a header row plus at least one server.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {!shown.dry_run ? (
            <p className="border-t border-line bg-slate-50 px-4 py-3 text-xs font-medium text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
              Imported servers are at status <code className="font-mono font-semibold">unknown</code>. Open each one and
              run discovery to populate OS, storage, services and Tomcat. Now delete the CSV file from your machine.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
