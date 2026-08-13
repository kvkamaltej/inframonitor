"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";

// Shared auto-refresh control for log viewers: a small "Auto-refresh" interval dropdown
// (Off / 5s / 10s / 30s / 60s) plus a hook that ticks a callback on that interval. Used by the
// Kubernetes pod-log tab and the server-detail log pane so both behave identically.

export const AUTO_REFRESH_INTERVALS = [0, 5, 10, 30, 60] as const;

function labelFor(seconds: number): string {
  return seconds === 0 ? "Off" : `${seconds}s`;
}

export function AutoRefreshSelect({
  value,
  onChange,
  disabled = false,
  className = ""
}: {
  value: number;
  onChange: (seconds: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={`inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 ${className}`}
      title="Automatically reload the log on an interval"
    >
      <RefreshCw size={13} className={value ? "text-accent" : "text-slate-400"} />
      <span className="hidden sm:inline">Auto</span>
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        disabled={disabled}
        className="h-8 cursor-pointer rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none transition-colors focus:border-accent disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
      >
        {AUTO_REFRESH_INTERVALS.map((seconds) => (
          <option key={seconds} value={seconds}>
            {labelFor(seconds)}
          </option>
        ))}
      </select>
    </label>
  );
}

// Calls `callback` every `seconds` (0 disables it). The callback is held in a ref and refreshed
// every render, so the interval always runs the latest closure (current pod/namespace/log source)
// without being torn down and recreated on each state change.
export function useAutoRefresh(seconds: number, callback: () => void) {
  const saved = useRef(callback);
  useEffect(() => {
    saved.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!seconds) return;
    const id = window.setInterval(() => saved.current(), seconds * 1000);
    return () => window.clearInterval(id);
  }, [seconds]);
}
