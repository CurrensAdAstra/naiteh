import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { Sparkles, Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from "react";

import { journalSave } from "../lib/api/journal";
import { notesWrite } from "../lib/api/notes";
import {
  isPinnedInContent,
  togglePinnedInContent,
} from "../lib/frontMatter";
import { formatAppError } from "../lib/types";
import {
  isDirty,
  replaceWholeDocument,
  useEditorStore,
  type OpenSource,
} from "../state/editorStore";
import { selectEditorConfig, useSettingsStore } from "../state/settingsStore";
import { useUIStore } from "../state/uiStore";
import styles from "./EditorPanel.module.css";

const AUTOSAVE_DELAY_MS = 800;

async function persist(source: OpenSource, content: string): Promise<void> {
  if (source.kind === "note") {
    await notesWrite(source.relPath, content);
  } else {
    await journalSave(source.date, content);
  }
}

export function EditorPanel() {
  const open = useEditorStore((s) => s.open);
  const setContent = useEditorStore((s) => s.setContent);
  const markSaved = useEditorStore((s) => s.markSaved);
  const setView = useEditorStore((s) => s.setView);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartmentRef = useRef<Compartment | null>(null);

  const editorKey = open?.key ?? null;
  const dirty = open !== null && isDirty(open);

  const save = useCallback(
    async (source: OpenSource, content: string) => {
      try {
        await persist(source, content);
        markSaved();
      } catch (e) {
        console.error("autosave failed:", formatAppError(e));
      }
    },
    [markSaved],
  );

  // Build / rebuild the CodeMirror view whenever a different file is opened.
  // We intentionally avoid `open` in the dep array — every keystroke would
  // tear the editor down. Read the latest savedContent via getState().
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || editorKey === null) return;
    const initial = useEditorStore.getState().open?.savedContent ?? "";
    const wrapCompartment = new Compartment();
    wrapCompartmentRef.current = wrapCompartment;
    const initialWrap: Extension =
      useSettingsStore.getState().config?.editor.lineWrapping ?? true
        ? EditorView.lineWrapping
        : [];
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        markdown(),
        wrapCompartment.of(initialWrap),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            setContent(update.state.doc.toString());
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: container });
    viewRef.current = view;
    setView(view);
    return () => {
      view.destroy();
      viewRef.current = null;
      wrapCompartmentRef.current = null;
      setView(null);
    };
  }, [editorKey, setContent, setView]);

  // Live-apply the line-wrapping preference to the existing view.
  useEffect(() => {
    const view = viewRef.current;
    const compartment = wrapCompartmentRef.current;
    if (view === null || compartment === null) return;
    view.dispatch({
      effects: compartment.reconfigure(
        editorConfig.lineWrapping ? EditorView.lineWrapping : [],
      ),
    });
  }, [editorConfig.lineWrapping]);

  // Debounced autosave when the editor content drifts from disk.
  useEffect(() => {
    if (open === null || !isDirty(open)) return;
    const source = open.source;
    const content = open.content;
    const handle = setTimeout(() => {
      void save(source, content);
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
        void save(current.source, current.content);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [save]);

  const headerLabel =
    open === null
      ? ""
      : open.source.kind === "journal"
        ? `Journal · ${open.source.date}`
        : open.source.relPath;

  // Override the editor token with the user's chosen font size (CSS var
  // is consumed inside EditorPanel.module.css's `.editor :global(.cm-…)`).
  const editorStyle = useMemo<CSSProperties>(
    () => ({
      ["--font-size-editor" as string]: `${editorConfig.fontSize}px`,
    }),
    [editorConfig.fontSize],
  );

  return (
    <div className={styles.panel} data-testid="editor-panel">
      {open === null ? (
        <div className={styles.empty}>No note open</div>
      ) : (
        <>
          <div className={styles.toolbar}>
            <span className={styles.path} title={headerLabel}>
              {headerLabel}
            </span>
            <PinToggleButton />
            <AiToggleButton />
            <span
              className={dirty ? styles.statusDirty : styles.statusSaved}
              data-testid="editor-status"
            >
              {dirty ? "● Unsaved" : "Saved"}
            </span>
          </div>
          <div
            ref={containerRef}
            className={styles.editor}
            style={editorStyle}
          />
        </>
      )}
    </div>
  );
}

function PinToggleButton() {
  const content = useEditorStore((s) => s.open?.content ?? null);
  if (content === null) return null;
  const pinned = isPinnedInContent(content);

  function handleToggle() {
    const current = useEditorStore.getState().open;
    if (current === null) return;
    const next = togglePinnedInContent(current.content);
    // Replace the editor doc; CodeMirror's update listener will mirror
    // the new text into editorStore.open.content, which triggers the
    // 800ms autosave path.
    if (!replaceWholeDocument(next)) {
      // Editor view not mounted yet — push to the store directly so
      // autosave still picks it up.
      useEditorStore.setState((state) =>
        state.open === null
          ? state
          : { open: { ...state.open, content: next } },
      );
    }
  }

  return (
    <button
      type="button"
      className={`${styles.pinToggle} ${pinned ? styles.pinToggleOn : ""}`}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin note" : "Pin note"}
      title={pinned ? "Unpin" : "Pin"}
      onClick={handleToggle}
      data-testid="editor-pin-toggle"
    >
      <Star
        size={14}
        fill={pinned ? "currentColor" : "none"}
        aria-hidden="true"
      />
    </button>
  );
}

function AiToggleButton() {
  const open = useUIStore((s) => s.aiPanelOpen);
  const toggle = useUIStore((s) => s.toggleAiPanel);
  return (
    <button
      type="button"
      className={`${styles.aiToggle} ${open ? styles.aiToggleOn : ""}`}
      aria-pressed={open}
      aria-label="Toggle AI Assist panel"
      title="AI Assist"
      onClick={toggle}
      data-testid="editor-ai-toggle"
    >
      <Sparkles size={14} aria-hidden="true" />
    </button>
  );
}
