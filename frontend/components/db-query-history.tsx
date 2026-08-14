"use client";

import { useEffect, useRef, useState } from "react";
import { History, Loader2, Search, Trash2 } from "lucide-react";
import type { DbQueryHistory } from "@/lib/api";

type DbQueryHistoryPanelProps = {
  items: DbQueryHistory[];
  loading?: boolean;
  onPick: (item: DbQueryHistory) => void;
  onSearch: (q: string) => void;
  onClear?: () => void;
};

// Compact relative time such as "just now", "5m ago", "3h ago", "2d ago". Falls back to
// the raw string if the timestamp cannot be parsed.
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso || "";
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1m ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function DbQueryHistoryPanel({ items, loading, onPick, onSearch, onClear }: DbQueryHistoryPanelProps) {
  const [query, setQuery] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input ~300ms so we don't fire onSearch on every keystroke.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleSearchChange(next: string) {
    setQuery(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearch(next), 300);
  }

  function handleClear() {
    if (!onClear) return;
    if (window.confirm("Clear the entire query history? This cannot be undone.")) {
      onClear();
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-edge">
      <div className="flex items-center gap-2 border-b border-edge p-3">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(event) => handleSearchChange(event.currentTarget.value)}
            placeholder="Search history…"
            spellCheck={false}
            className="h-9 w-full rounded-full bg-page pl-8 pr-3 text-sm text-fg outline-none ring-1 ring-edge transition-colors focus:ring-2 focus:ring-accent"
          />
        </div>
        {onClear ? (
          <button
            type="button"
            onClick={handleClear}
            title="Clear history"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted ring-1 ring-edge transition-colors hover:bg-elevated hover:text-danger"
          >
            <Trash2 size={15} />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading history…
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted">
            <History size={20} className="opacity-60" />
            No queries yet.
          </div>
        ) : (
          <ul className="divide-y divide-edge">
            {items.map((item) => {
              const isError = item.status === "error";
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onPick(item)}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-elevated"
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        item.status === "success" ? "bg-emerald-500" : isError ? "bg-red-500" : "bg-muted"
                      }`}
                      title={item.status}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-fg" title={item.sql}>
                        {item.sql}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted">
                        {item.connection_name}
                        {item.database ? ` • ${item.database}` : ""} • {relativeTime(item.created_at)} •{" "}
                        {isError ? (
                          <span className="text-danger">{item.error || "error"}</span>
                        ) : (
                          <span>
                            {item.row_count} rows • {item.elapsed_ms} ms
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
