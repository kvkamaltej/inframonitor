"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  DownloadCloud,
  Loader2,
  Table2
} from "lucide-react";
import { downloadTextFile } from "@/lib/download";
import type { DbQueryResult } from "@/lib/api";

type DbResultGridProps = {
  result: DbQueryResult | null;
  error?: string;
  // re-runs the current tab's query at the server's max limit (5000). Absent => button hidden.
  onFetchAll?: () => void;
  // true while a (re-)fetch is in flight; disables the fetch-all button and shows a spinner.
  fetching?: boolean;
};

type SortDir = "asc" | "desc" | null;

// Client-side page sizes. "all" shows every fetched row in one page.
type PageSize = "50" | "100" | "500" | "all";

// Render any cell value as a string; null/undefined stay null so the grid can style them.
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

// CSV field quoting: wrap in double quotes and double any embedded quote when the field
// contains a comma, quote or newline.
function csvField(value: unknown): string {
  const text = isNull(value) ? "" : cellText(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildTsv(columns: string[], rows: unknown[][]): string {
  const head = columns.join("\t");
  const body = rows.map((row) => row.map((cell) => (isNull(cell) ? "" : cellText(cell))).join("\t"));
  return [head, ...body].join("\n");
}

function buildCsv(columns: string[], rows: unknown[][]): string {
  const head = columns.map(csvField).join(",");
  const body = rows.map((row) => row.map(csvField).join(","));
  return [head, ...body].join("\n");
}

function buildJson(columns: string[], rows: unknown[][]): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      obj[col] = row[index] ?? null;
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

// Copy text to the clipboard, falling back to a hidden textarea + execCommand for plain
// http (non-secure) origins where navigator.clipboard is unavailable.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the textarea fallback
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

function ToolbarButton({
  onClick,
  children,
  title
}: {
  onClick: () => void;
  children: ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold text-fg ring-1 ring-edge transition-colors hover:bg-elevated"
    >
      {children}
    </button>
  );
}

export function DbResultGrid({ result, error, onFetchAll, fetching }: DbResultGridProps) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [copied, setCopied] = useState(false);
  const [pageSize, setPageSize] = useState<PageSize>("100");
  const [page, setPage] = useState(0);

  const columns = result?.columns ?? [];
  const rows = result?.rows ?? [];

  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      // nulls sort last regardless of direction
      if (isNull(av) && isNull(bv)) return 0;
      if (isNull(av)) return 1;
      if (isNull(bv)) return -1;
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = cellText(av).localeCompare(cellText(bv), undefined, { numeric: true, sensitivity: "base" });
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortCol, sortDir]);

  // --- client-side pagination over the fetched (and sorted) rows ---
  const perPage = pageSize === "all" ? sortedRows.length || 1 : Number(pageSize);
  const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(sortedRows.length / perPage));
  const clampedPage = Math.min(page, totalPages - 1);
  const startIdx = pageSize === "all" ? 0 : clampedPage * perPage;
  const endIdx = pageSize === "all" ? sortedRows.length : Math.min(startIdx + perPage, sortedRows.length);
  const pageRows = pageSize === "all" ? sortedRows : sortedRows.slice(startIdx, endIdx);

  // A new result set, a page-size change, or a re-sort resets to the first page.
  useEffect(() => {
    setPage(0);
  }, [result, pageSize, sortCol, sortDir]);

  function toggleSort(index: number) {
    if (sortCol !== index) {
      setSortCol(index);
      setSortDir("asc");
      return;
    }
    // same column: asc -> desc -> none
    if (sortDir === "asc") {
      setSortDir("desc");
    } else if (sortDir === "desc") {
      setSortCol(null);
      setSortDir(null);
    } else {
      setSortDir("asc");
    }
  }

  async function onCopy() {
    const ok = await copyText(buildTsv(columns, sortedRows));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  if (error) {
    return (
      <div className="flex items-start gap-3 rounded-2xl bg-surface p-4 ring-1 ring-danger/40">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
        <pre className="whitespace-pre-wrap break-words font-mono text-xs font-medium text-danger">{error}</pre>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="rounded-2xl bg-surface p-8 text-center text-sm text-muted ring-1 ring-edge">
        Run a query to see results.
      </div>
    );
  }

  // A non-SELECT statement (INSERT/UPDATE/DDL) comes back with no columns.
  if (columns.length === 0) {
    return (
      <div className="rounded-2xl bg-surface p-6 text-center text-sm text-fg ring-1 ring-edge">
        Statement completed. {result.row_count} row(s), {result.elapsed_ms} ms.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-surface ring-1 ring-edge">
      <div className="flex items-center justify-end gap-2 border-b border-edge px-3 py-2">
        <ToolbarButton onClick={() => void onCopy()} title="Copy as TSV">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </ToolbarButton>
        <ToolbarButton onClick={() => downloadTextFile("query-result.csv", buildCsv(columns, sortedRows))} title="Export CSV">
          <Table2 size={14} />
          CSV
        </ToolbarButton>
        <ToolbarButton onClick={() => downloadTextFile("query-result.json", buildJson(columns, sortedRows))} title="Export JSON">
          <Braces size={14} />
          JSON
        </ToolbarButton>
      </div>

      <div className="max-h-[55vh] overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-surface text-xs uppercase tracking-wider text-muted">
            <tr>
              {columns.map((col, index) => {
                const active = sortCol === index;
                return (
                  <th
                    key={`${col}-${index}`}
                    onClick={() => toggleSort(index)}
                    className="cursor-pointer select-none whitespace-nowrap border-b border-edge px-3 py-2 font-semibold hover:text-fg"
                    title={`Sort by ${col}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col}
                      {active && sortDir === "asc" ? <ArrowUp size={12} /> : null}
                      {active && sortDir === "desc" ? <ArrowDown size={12} /> : null}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, rIndex) => (
              <tr key={startIdx + rIndex} className="odd:bg-elevated/40 hover:bg-elevated">
                {columns.map((_, cIndex) => {
                  const value = row[cIndex];
                  if (isNull(value)) {
                    return (
                      <td key={cIndex} className="max-w-xs truncate border-b border-edge px-3 py-1.5 font-mono text-xs italic text-muted">
                        NULL
                      </td>
                    );
                  }
                  const text = cellText(value);
                  return (
                    <td
                      key={cIndex}
                      title={text}
                      className="max-w-xs truncate border-b border-edge px-3 py-1.5 font-mono text-xs text-fg"
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-edge px-3 py-2 text-xs text-muted">
        <span className="font-medium text-fg">
          {result.row_count} rows • {result.elapsed_ms} ms
        </span>
        {sortedRows.length > 0 ? (
          <span>
            showing {startIdx + 1}–{endIdx} of {sortedRows.length}
          </span>
        ) : null}
        {result.truncated ? (
          <span className="text-danger">• truncated at the server row cap</span>
        ) : null}

        {onFetchAll ? (
          <button
            type="button"
            onClick={onFetchAll}
            disabled={fetching}
            title="Re-run this query at the server's maximum of 5000 rows"
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 font-semibold text-fg ring-1 ring-edge transition-colors hover:bg-elevated disabled:opacity-50"
          >
            {fetching ? <Loader2 size={13} className="animate-spin" /> : <DownloadCloud size={13} />}
            Fetch all (up to 5000)
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value as PageSize)}
              className="h-7 rounded-lg border-none bg-elevated px-2 text-xs font-medium text-fg outline-none ring-1 ring-edge focus:ring-2 focus:ring-accent"
            >
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="500">500</option>
              <option value="all">All</option>
            </select>
          </label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage <= 0}
              title="Previous page"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted ring-1 ring-edge transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="min-w-[4.5rem] text-center tabular-nums">
              {clampedPage + 1} / {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
              title="Next page"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted ring-1 ring-edge transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
