"use client";

import { KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";

type DbSqlEditorProps = {
  value: string;
  onChange: (v: string) => void;
  onRun: (sql: string, selectionOnly: boolean) => void;
  engine?: string;
  height?: string;
};

// Read whether the app is currently in dark mode. The theme picker toggles either a
// `dark` class or a `data-theme="dark"` attribute on <html>, so honour both.
function readDark(): boolean {
  if (typeof document === "undefined") return false;
  const root = document.documentElement;
  return root.classList.contains("dark") || root.getAttribute("data-theme") === "dark";
}

export function DbSqlEditor({ value, onChange, onRun, engine, height = "320px" }: DbSqlEditorProps) {
  const [dark, setDark] = useState<boolean>(false);
  // Hold the live EditorView so the keyboard handler can read the current selection.
  const viewRef = useRef<EditorView | null>(null);

  // Sync the theme on mount and whenever <html> class / data-theme changes.
  useEffect(() => {
    setDark(readDark());
    const observer = new MutationObserver(() => setDark(readDark()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"]
    });
    return () => observer.disconnect();
  }, []);

  const handleCreate = useCallback((view: EditorView) => {
    viewRef.current = view;
  }, []);

  // Ctrl/Cmd+Enter runs the whole buffer; adding Shift runs the current selection
  // (or the whole buffer when nothing is selected).
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod || event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) {
        const view = viewRef.current;
        let selected = "";
        if (view) {
          const { from, to } = view.state.selection.main;
          selected = view.state.sliceDoc(from, to);
        }
        onRun(selected.trim().length > 0 ? selected : value, true);
      } else {
        onRun(value, false);
      }
    },
    [onRun, value]
  );

  return (
    <div
      onKeyDownCapture={handleKeyDown}
      className="overflow-hidden rounded-2xl bg-surface font-mono ring-1 ring-edge"
      data-engine={engine || undefined}
    >
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={[sql()]}
        theme={dark ? "dark" : "light"}
        height={height}
        minHeight={height}
        onCreateEditor={handleCreate}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
      />
    </div>
  );
}
