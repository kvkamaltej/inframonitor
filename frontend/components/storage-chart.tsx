"use client";

import { HardDrive } from "lucide-react";

type StorageRow = Record<string, string>;
type Level = "healthy" | "warning" | "critical";

type Bar = {
  key: string;
  mount: string;
  filesystem: string;
  type: string;
  percent: number;
  usedBytes: number;
  sizeBytes: number;
  availableBytes: number;
  level: Level;
};

const PSEUDO_TYPES = new Set(["tmpfs", "devtmpfs", "squashfs", "overlay", "proc", "sysfs"]);
// base-1024 sizes with df -h style labels, so the chart and the table below it agree
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

const LEVEL_STYLES: Record<Level, { bar: string; text: string }> = {
  healthy: { bar: "bg-accent", text: "text-accent" },
  warning: { bar: "bg-warn dark:bg-amber-400", text: "text-warn dark:text-amber-400" },
  critical: { bar: "bg-danger dark:bg-red-500", text: "text-danger dark:text-red-400" }
};

function toNumber(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(String(value).trim().replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > 100 ? 100 : Math.round(value);
}

// Rows discovered before size_bytes/used_bytes/available_bytes existed only carry the *_1k
// (KiB) fields, so fall back to those and convert.
function bytesOf(row: StorageRow, byteKey: string, kibKey: string): number {
  const direct = toNumber(row[byteKey]);
  if (direct > 0) return direct;
  return toNumber(row[kibKey]) * 1024;
}

function percentOf(row: StorageRow, usedBytes: number, sizeBytes: number): number {
  const numeric = toNumber(row.used_percent_num);
  if (numeric > 0) return clampPercent(numeric);
  const legacy = toNumber(row.used_percent);
  if (legacy > 0) return clampPercent(legacy);
  if (sizeBytes > 0 && usedBytes > 0) return clampPercent((usedBytes / sizeBytes) * 100);
  return 0;
}

function levelOf(row: StorageRow, percent: number): Level {
  const status = String(row.status ?? "").toLowerCase();
  if (status === "critical" || status === "warning" || status === "healthy") return status;
  if (percent >= 90) return "critical";
  if (percent >= 80) return "warning";
  return "healthy";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 100 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${UNITS[unit]}`;
}

function toBars(rows: Array<StorageRow>): Bar[] {
  const bars: Bar[] = [];
  rows.forEach((row, index) => {
    const type = String(row.type ?? "").toLowerCase();
    const mountPoint = String(row.mount ?? "").trim();
    // never hide the root filesystem, whatever it is mounted as -- on a containerised
    // host / is an overlay, and dropping it would leave the chart empty
    if (mountPoint !== "/" && PSEUDO_TYPES.has(type)) return;
    const sizeBytes = bytesOf(row, "size_bytes", "blocks_1k");
    if (sizeBytes <= 0) return;
    const usedBytes = bytesOf(row, "used_bytes", "used_1k");
    const availableBytes = bytesOf(row, "available_bytes", "available_1k");
    const percent = percentOf(row, usedBytes, sizeBytes);
    const mount = String(row.mount ?? "").trim();
    const filesystem = String(row.filesystem ?? "").trim();
    bars.push({
      key: `${filesystem}|${mount}|${index}`,
      mount: mount || filesystem || "unknown",
      filesystem,
      type: String(row.type ?? "").trim(),
      percent,
      usedBytes,
      sizeBytes,
      availableBytes,
      level: levelOf(row, percent)
    });
  });
  return bars.sort((left, right) => right.percent - left.percent || right.sizeBytes - left.sizeBytes);
}

export function StorageChart({ rows }: { rows: Array<Record<string, string>> }) {
  const bars = toBars(rows ?? []);

  if (bars.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-slate-50 px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/40">
        <HardDrive size={20} className="text-slate-400 dark:text-slate-500" />
        <p className="text-sm font-semibold text-ink dark:text-slate-100">No real filesystems to chart</p>
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {(rows ?? []).length > 0
            ? "Every discovered mount is a pseudo-filesystem or reports zero size."
            : "Run discovery on this server to collect storage usage."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {bars.map((bar) => {
        const styles = LEVEL_STYLES[bar.level];
        const label = `${bar.mount}${bar.type ? ` (${bar.type})` : ""}: ${bar.percent}% used, ${formatBytes(bar.usedBytes)} of ${formatBytes(bar.sizeBytes)}, ${bar.level}`;
        return (
          <div key={bar.key} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-sm font-semibold text-ink dark:text-slate-100">{bar.mount}</span>
                {bar.filesystem ? (
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{bar.filesystem}</span>
                ) : null}
                {bar.type ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {bar.type}
                  </span>
                ) : null}
              </div>
              <div className="flex items-baseline gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
                <span>
                  {formatBytes(bar.usedBytes)} / {formatBytes(bar.sizeBytes)}
                </span>
                <span className="text-slate-400 dark:text-slate-500">&middot;</span>
                <span>{formatBytes(bar.availableBytes)} free</span>
                <span className={`text-sm font-semibold tabular-nums ${styles.text}`}>{bar.percent}%</span>
              </div>
            </div>
            <div
              role="img"
              aria-label={label}
              title={label}
              className="h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
            >
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${styles.bar}`}
                style={{ width: bar.percent === 0 ? "0%" : `${Math.max(bar.percent, 1)}%` }}
              />
            </div>
          </div>
        );
      })}
      <p className="pt-1 text-xs font-medium text-slate-500 dark:text-slate-400">
        {bars.length} filesystem{bars.length === 1 ? "" : "s"} charted. Pseudo-filesystems (tmpfs, overlay, squashfs and
        similar) and zero-size mounts are excluded, except the root filesystem which is always shown.
      </p>
    </div>
  );
}
