import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { useCallback, useEffect, useRef } from "react";

import { notesWrite } from "../lib/api/notes";
import { formatAppError } from "../lib/types";
import { isDirty, useEditorStore } from "../state/editorStore";
import styles from "./EditorPanel.module.css";

const AUTOSAVE_DELAY_MS = 800;

export function EditorPanel() {
  const open = useEditorStore((s) => s.open);
  const setContent = useEditorStore((s) => s.setContent);
  const markSaved = useEditorStore((s) => s.markSaved);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  const relPath = open?.relPath ?? null;
  const dirty = open !== null && isDirty(open);

  const save = useCallback(
    async (path: string, content: string) => {
      try {
        await notesWrite(path, content);
        markSaved();
      } catch (e) {
        console.error("autosave failed:", formatAppError(e));
      }
    },
    [markSaved],
  );

  // Build / rebuild the CodeMirror view whenever a different note is opened.
  // We intentionally avoid `open` in the dep array — every keystroke would
  // tear the editor down. Read the latest savedContent via getState().
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || relPath === null) return;
    const initial = useEditorStore.getState().open?.savedContent ?? "";
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [relPath, setContent]);

  // Debounced autosave when the editor content drifts from disk.
  useEffect(() => {
    if (open === null || !isDirty(open)) return;
    const path = open.relPath;
    const content = open.content;
    const handle = setTimeout(() => {
      void save(path, content);
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(handle);
  }, [open, save]);

  // Cmd/Ctrl-S = explicit save.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        const current = useEditorStore.getState().open;
        if (current === null) return;
        void save(current.relPath, current.content);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  return (
    <div className={styles.panel} data-testid="editor-panel">
      {open === null ? (
        <div className={styles.empty}>No note open</div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <span className={styles.path} title={open.relPath}>
              {open.relPath}
            </span>
            <span
              className={dirty ? styles.statusDirty : styles.statusSaved}
              data-testid="editor-status"
            >
              {dirty ? "● Unsaved" : "Saved"}
            </span>
          </div>
          <div ref={containerRef} className={styles.editor} />
        </>
      )}
    </div>
  );
}
