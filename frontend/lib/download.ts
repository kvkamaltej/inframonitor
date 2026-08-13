// Client-side file download helpers, shared by the log viewers' "Download" buttons.

// Trigger a browser download of `text` as a UTF-8 file named `filename`.
export function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// Turn arbitrary text (a pod name, a log-source label) into a safe filename fragment.
export function safeFilename(value: string, fallback = "log"): string {
  const cleaned = (value || "").trim().replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}
