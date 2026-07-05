import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import { Lock, Paperclip, Sparkles, Star, Unlock } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { attachmentsImport } from "../lib/api/attachments";
import { journalSave } from "../lib/api/journal";
import { notesWrite } from "../lib/api/notes";
import { resolveFenceLanguage } from "../lib/codeBlockLanguages";
import { editorAttachmentDrop } from "../lib/editorAttachmentDrop";
import {
  isPinnedInContent,
  togglePinnedInContent,
} from "../lib/frontMatter";
import { markdownKeymap } from "../lib/markdownKeymap";
import { formatAppError, isAppError } from "../lib/types";
import {
  insertAtCursor,
  isDirty,
  replaceWholeDocument,
  useEditorStore,
  type OpenSource,
} from "../state/editorStore";
import { useAuthStore } from "../state/authStore";
import { selectEditorConfig, useSettingsStore } from "../state/settingsStore";
import { useUIStore } from "../state/uiStore";
import { TagsBar } from "./TagsBar";
import styles from "./EditorPanel.module.css";

const AUTOSAVE_DELAY_MS = 800;

async function persist(source: OpenSource, content: string): Promise<void> {
  if (source.kind === "note") {
    await notesWrite(source.relPath, content);
  } else {
    await journalSave(source.date, content);
  }
}

function auditDetail(source: OpenSource): string {
  return source.kind === "note" ? source.relPath : source.date;
}

export function EditorPanel() {
  const open = useEditorStore((s) => s.open);
  const setContent = useEditorStore((s) => s.setContent);
  const markSaved = useEditorStore((s) => s.markSaved);
  const setView = useEditorStore((s) => s.setView);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const editorReadOnly = useUIStore((s) => s.editorReadOnly);
  const logAction = useAuthStore((s) => s.logAction);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartmentRef = useRef<Compartment | null>(null);
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);

  const editorKey = open?.key ?? null;
  const dirty = open !== null && isDirty(open);

  const save = useCallback(
    async (source: OpenSource, content: string) => {
      try {
        await persist(source, content);
        markSaved();
        void logAction(
          source.kind === "note" ? "note_save" : "journal_save",
          auditDetail(source),
        ).catch(() => {});
      } catch (e) {
        console.error("autosave failed:", formatAppError(e));
      }
    },
    [markSaved, logAction],
  );

  // Build / rebuild the CodeMirror view whenever a different file is opened.
  // We intentionally avoid `open` in the dep array — every keystroke would
  // tear the editor down. Read the latest savedContent via getState().
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || editorKey === null) return;
    const initial = useEditorStore.getState().open?.savedContent ?? "";
    const wrapCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    wrapCompartmentRef.current = wrapCompartment;
    readOnlyCompartmentRef.current = readOnlyCompartment;
    const initialWrap: Extension =
      useSettingsStore.getState().config?.editor.lineWrapping ?? true
        ? EditorView.lineWrapping
        : [];
    const initialReadOnly: Extension = useUIStore.getState().editorReadOnly
      ? EditorState.readOnly.of(true)
      : [];
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        // Fenced code blocks get per-language highlighting; grammars
        // lazy-load on first use (see lib/codeBlockLanguages).
        markdown({ codeLanguages: resolveFenceLanguage }),
        markdownKeymap(),
        wrapCompartment.of(initialWrap),
        readOnlyCompartment.of(initialReadOnly),
        editorAttachmentDrop({ onError: setAttachmentError }),
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
      readOnlyCompartmentRef.current = null;
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

  // Live-apply the read-only toggle.
  useEffect(() => {
    const view = viewRef.current;
    const compartment = readOnlyCompartmentRef.current;
    if (view === null || compartment === null) return;
    view.dispatch({
      effects: compartment.reconfigure(
        editorReadOnly ? EditorState.readOnly.of(true) : [],
      ),
    });
  }, [editorReadOnly]);

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
            <AttachmentButton
              readOnly={editorReadOnly}
              onError={setAttachmentError}
            />
            <ReadOnlyToggleButton />
            <AiToggleButton />
            <span
              className={dirty ? styles.statusDirty : styles.statusSaved}
              data-testid="editor-status"
            >
              {editorReadOnly ? "Read-only" : dirty ? "● Unsaved" : "Saved"}
            </span>
          </div>
          {attachmentError !== null && (
            <div className={styles.inlineError} role="alert">
              {attachmentError}
            </div>
          )}
          <TagsBar />
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

interface AttachmentButtonProps {
  readOnly: boolean;
  onError: (message: string | null) => void;
}

function AttachmentButton({ readOnly, onError }: AttachmentButtonProps) {
  const [busy, setBusy] = useState(false);

  async function handleImport() {
    onError(null);
    setBusy(true);
    try {
      const attachment = await attachmentsImport();
      const ok = insertAtCursor(attachment.markdown);
      if (!ok) {
        onError("Open a note before inserting an attachment.");
      }
    } catch (e) {
      if (isAppError(e) && e.kind === "Cancelled") return;
      onError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={styles.attachToggle}
      aria-label="Attach file"
      title="Attach file"
      onClick={() => void handleImport()}
      disabled={busy || readOnly}
      data-testid="editor-attach-button"
    >
      <Paperclip size={14} aria-hidden="true" />
    </button>
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

function ReadOnlyToggleButton() {
  const readOnly = useUIStore((s) => s.editorReadOnly);
  const toggle = useUIStore((s) => s.toggleEditorReadOnly);
  return (
    <button
      type="button"
      className={`${styles.lockToggle} ${readOnly ? styles.lockToggleOn : ""}`}
      aria-pressed={readOnly}
      aria-label={readOnly ? "Disable read-only mode" : "Enable read-only mode"}
      title={readOnly ? "Disable read-only" : "Make read-only"}
      onClick={toggle}
      data-testid="editor-readonly-toggle"
    >
      {readOnly ? (
        <Lock size={14} aria-hidden="true" />
      ) : (
        <Unlock size={14} aria-hidden="true" />
      )}
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
