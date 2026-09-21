"use client";

// Clipboard helpers that also work on the app's plain-HTTP LAN origin (e.g. http://192.168.1.41:8088),
// where navigator.clipboard is unavailable because the page is not a "secure context". Copy falls back
// to a hidden-textarea execCommand("copy"); read falls back to null (programmatic reads are blocked on
// insecure origins — callers should keep the browser's native Ctrl+V, which still works there).

// Copy text to the clipboard. Returns true on success. Safe to call from a user gesture.
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Read text from the clipboard, or null when the browser won't allow a programmatic read (e.g. an
// insecure origin). Callers that get null should fall back to the terminal's native paste (Ctrl+V).
export async function readClipboardText(): Promise<string | null> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === "function" && window.isSecureContext) {
      return await navigator.clipboard.readText();
    }
  } catch {
    /* not permitted */
  }
  return null;
}

// Whether a programmatic clipboard read is possible here (secure context). When false, the UI should
// steer the user to Ctrl+V / Shift+Insert (the browser's native paste), which works everywhere.
export function canReadClipboard(): boolean {
  try {
    return Boolean(navigator.clipboard && typeof navigator.clipboard.readText === "function" && window.isSecureContext);
  } catch {
    return false;
  }
}
