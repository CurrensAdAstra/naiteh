import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";
import {
  BookOpen,
  MessageSquare,
  Paperclip,
  Pencil,
  Square,
  Star,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { attachmentsImport } from "../lib/api/attachments";
import { sendChat, stopChat } from "../lib/chatMd/chatFlow";
import { resolveFenceLanguage } from "../lib/codeBlockLanguages";
import { editorAttachmentDrop } from "../lib/editorAttachmentDrop";
import { editorHtmlPaste } from "../lib/editorHtmlPaste";
import { editorHighlight } from "../lib/editorHighlight";
import {
  keepMine,
  loadDiskVersion,
  saveMineAsCopy,
} from "../lib/externalChange";
import {
  isPinnedInContent,
  togglePinnedInContent,
} from "../lib/frontMatter";
import { markdownKeymap } from "../lib/markdownKeymap";
import { formatAppError, isAppError } from "../lib/types";
import {
  flushPendingSave,
  onSaved,
  scheduleSave,
} from "../state/autosave";
import {
  currentOpenKey,
  hasExternalChange,
  insertAtCursor,
  isDirty,
  replaceWholeDocument,
  useEditorStore,
  type OpenSource,
} from "../state/editorStore";
import { useAuthStore } from "../state/authStore";
import { selectEditorConfig, useSettingsStore } from "../state/settingsStore";
import { useUIStore } from "../state/uiStore";
import { MarkdownViewer } from "./MarkdownViewer";
import { TagsBar } from "./TagsBar";
import styles from "./EditorPanel.module.css";

function auditDetail(source: OpenSource): string {
  return source.kind === "note" ? source.relPath : source.date;
}

export function EditorPanel() {
  const open = useEditorStore((s) => s.open);
  const revision = useEditorStore((s) => s.revision);
  const saveError = useEditorStore((s) =>
    s.saveError !== null && s.saveError.key === s.open?.key
      ? s.saveError.message
      : null,
  );
  const inConflict = useEditorStore(hasExternalChange);
  const setContent = useEditorStore((s) => s.setContent);
  const setView = useEditorStore((s) => s.setView);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const editorMode = useUIStore((s) => s.editorMode);
  const setEditorMode = useUIStore((s) => s.setEditorMode);
  const viewing = editorMode === "view";
  const logAction = useAuthStore((s) => s.logAction);
  const chatErrorState = useUIStore((s) => s.chatError);
  const setChatError = useUIStore((s) => s.setChatError);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartmentRef = useRef<Compartment | null>(null);
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);

  const editorKey = open?.key ?? null;
  const chatError =
    chatErrorState !== null && chatErrorState.docKey === editorKey
      ? chatErrorState.message
      : null;
  const dirty = open !== null && isDirty(open);

  // Audit-log every successful write (autosave, flush, Cmd+S).
  useEffect(
    () =>
      onSaved((source) => {
        void logAction(
          source.kind === "note" ? "note_save" : "journal_save",
          auditDetail(source),
        ).catch(() => {});
      }),
    [logAction],
  );

  // Build / rebuild the CodeMirror view whenever a different file is
  // opened, or the open file's text was replaced from outside the editor
  // (`revision` bump: re-open, reload after sync). We intentionally avoid
  // `open` in the dep array — every keystroke would tear the editor down.
  // Seed from the *current* content (not savedContent) so a remount while
  // dirty never shows stale text.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || editorKey === null) return;
    const initial = useEditorStore.getState().open?.content ?? "";
    const wrapCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    wrapCompartmentRef.current = wrapCompartment;
    readOnlyCompartmentRef.current = readOnlyCompartment;
    const initialWrap: Extension =
      useSettingsStore.getState().config?.editor.lineWrapping ?? true
        ? EditorView.lineWrapping
        : [];
    // The source editor stays mounted (hidden) in view mode so pin/tag/
    // task edits and AI replacements keep flowing through one document;
    // read-only there so a stray key can't type into it.
    const initialReadOnly: Extension =
      useUIStore.getState().editorMode === "view"
        ? EditorState.readOnly.of(true)
        : [];
    const state = EditorState.create({
      doc: initial,
      extensions: [
        basicSetup,
        // Token-driven colors so palettes (incl. dark) recolor syntax.
        editorHighlight(),
        // Fenced code blocks get per-language highlighting; grammars
        // lazy-load on first use (see lib/codeBlockLanguages).
        markdown({ codeLanguages: resolveFenceLanguage }),
        markdownKeymap(),
        wrapCompartment.of(initialWrap),
        readOnlyCompartment.of(initialReadOnly),
        editorAttachmentDrop({ onError: setAttachmentError }),
        // After the image handler so image pastes keep priority.
        editorHtmlPaste(),
        EditorView.updateListener.of((update) => {
          // Only mirror into the store while this view still belongs to
          // the open document (guards the brief window before a rebuild).
          if (
            update.docChanged &&
            useEditorStore.getState().open?.key === editorKey
          ) {
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
      if (useEditorStore.getState().view === view) setView(null);
    };
  }, [editorKey, revision, setContent, setView]);

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

  // Live-apply the view/edit mode. Entering edit mode re-measures the
  // (previously hidden) editor and focuses it.
  useEffect(() => {
    const view = viewRef.current;
    const compartment = readOnlyCompartmentRef.current;
    if (view === null || compartment === null) return;
    view.dispatch({
      effects: compartment.reconfigure(
        viewing ? EditorState.readOnly.of(true) : [],
      ),
    });
    if (!viewing) {
      view.requestMeasure();
      view.focus();
    }
  }, [viewing, editorKey, revision]);

  // Debounced autosave when the editor content drifts from disk. The
  // pending save lives in state/autosave (not in this effect), so it is
  // *not* cancelled when the open document changes: it still writes the
  // captured content to the captured source, and callers that move off a
  // document flush it explicitly first.
  useEffect(() => {
    if (open === null || !isDirty(open)) return;
    scheduleSave(open.source, open.content);
  }, [open]);

  // Cmd/Ctrl-S = explicit save. While the document is in the changed-on-
  // disk conflict state the key is held, so this writes nothing and the
  // banner stays until the user picks a resolution.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void flushPendingSave();
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

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
              readOnly={viewing}
              onError={setAttachmentError}
            />
            <EditModeToggleButton />
            <ChatButton />
            <span
              className={
                dirty || inConflict ? styles.statusDirty : styles.statusSaved
              }
              data-testid="editor-status"
            >
              {inConflict
                ? "● Changed on disk"
                : dirty
                  ? saveError !== null
                    ? "● Save failed"
                    : "● Unsaved"
                  : "Saved"}
            </span>
          </div>
          {inConflict && <ExternalChangeBanner />}
          {saveError !== null && dirty && !inConflict && (
            <div
              className={styles.inlineError}
              role="alert"
              data-testid="editor-save-error"
            >
              Couldn&rsquo;t save: {saveError}. Your changes are kept and
              will be retried.
            </div>
          )}
          {chatError !== null && (
            <div
              className={styles.inlineError}
              role="alert"
              data-testid="editor-chat-error"
            >
              Chat failed: {chatError}{" "}
              <button
                type="button"
                className={styles.inlineDismiss}
                onClick={() => setChatError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          {attachmentError !== null && (
            <div className={styles.inlineError} role="alert">
              {attachmentError}
            </div>
          )}
          <TagsBar />
          {viewing && (
            <MarkdownViewer
              content={open.content}
              docRelPath={open.source.relPath}
              onChange={applyDocument}
              onStartEditing={() => setEditorMode("edit")}
            />
          )}
          <div
            ref={containerRef}
            className={styles.editor}
            style={editorStyle}
            hidden={viewing}
            data-testid="editor-source"
          />
        </>
      )}
    </div>
  );
}

type ConflictAction = "load" | "keep" | "copy";

/**
 * Shown while the open document is in the changed-on-disk conflict state
 * (editorStore.externalChange): the file was modified — or removed —
 * outside naiteh while it had unsaved edits, so autosave is held. The
 * three buttons map onto lib/externalChange's resolutions.
 */
function ExternalChangeBanner() {
  const removed = useEditorStore(
    (s) => hasExternalChange(s) && s.externalChange?.diskVersion === "",
  );
  const [busy, setBusy] = useState<ConflictAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: ConflictAction, fn: () => Promise<unknown>) {
    setBusy(action);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className={styles.conflictBanner}
      role="alert"
      data-testid="editor-external-change"
    >
      <span className={styles.conflictText}>
        {removed
          ? "This note was deleted outside naiteh (for example by Google Drive sync). Your edits exist only in the editor."
          : "This note changed outside naiteh (for example by Google Drive sync)."}
      </span>
      <span className={styles.conflictActions}>
        <button
          type="button"
          className={styles.conflictButton}
          disabled={busy !== null}
          onClick={() => void run("load", loadDiskVersion)}
          title={
            removed
              ? "Discard your edits and close the note"
              : "Discard your edits and show the file as it is on disk"
          }
          data-testid="external-change-load"
        >
          {removed ? "Discard mine" : "Load disk version"}
        </button>
        <button
          type="button"
          className={`${styles.conflictButton} ${styles.conflictButtonPrimary}`}
          disabled={busy !== null}
          onClick={() => void run("keep", keepMine)}
          title={
            removed
              ? "Write your edits back to the original path"
              : "Overwrite the file on disk with your edits"
          }
          data-testid="external-change-keep"
        >
          {removed ? "Re-save mine" : "Keep mine"}
        </button>
        <button
          type="button"
          className={styles.conflictButton}
          disabled={busy !== null}
          onClick={() => void run("copy", saveMineAsCopy)}
          title="Keep both: your edits go to a .local-<timestamp>.md note next to this one"
          data-testid="external-change-copy"
        >
          Save mine as copy
        </button>
      </span>
      {error !== null && (
        <span className={styles.conflictError} data-testid="external-change-error">
          {error}
        </span>
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
    const key = currentOpenKey();
    try {
      const attachment = await attachmentsImport();
      if (currentOpenKey() !== key) {
        onError(
          `Attached ${attachment.relPath}, but the open note changed — insert its link manually.`,
        );
        return;
      }
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

/**
 * Replace the whole open document (viewer task toggles). Goes through the
 * mounted editor so its doc, the store and autosave stay in step.
 */
function applyDocument(next: string) {
  if (!replaceWholeDocument(next)) {
    useEditorStore.setState((state) =>
      state.open === null ? state : { open: { ...state.open, content: next } },
    );
  }
}

function EditModeToggleButton() {
  const editing = useUIStore((s) => s.editorMode === "edit");
  const toggle = useUIStore((s) => s.toggleEditorMode);
  return (
    <button
      type="button"
      className={`${styles.modeToggle} ${editing ? styles.modeToggleOn : ""}`}
      aria-pressed={editing}
      aria-label={editing ? "Done editing" : "Edit note"}
      title={
        editing
          ? "Show the rendered note (Ctrl+Shift+E)"
          : "Edit the Markdown source (Ctrl+Shift+E)"
      }
      onClick={toggle}
      data-testid="editor-mode-toggle"
    >
      {editing ? (
        <BookOpen size={14} aria-hidden="true" />
      ) : (
        <Pencil size={14} aria-hidden="true" />
      )}
      <span>{editing ? "Done" : "Edit"}</span>
    </button>
  );
}

/** chatgpt-md's "Chat": send this note, stream the reply into it. */
function ChatButton() {
  const openKey = useEditorStore((s) => s.open?.key ?? null);
  const request = useUIStore((s) => s.chatRequest);
  const streamingHere = request !== null && request.docKey === openKey;
  return (
    <button
      type="button"
      className={`${styles.chatButton} ${streamingHere ? styles.chatButtonOn : ""}`}
      aria-label={streamingHere ? "Stop chat reply" : "Chat"}
      title={
        streamingHere
          ? "Stop the reply"
          : "Chat: send this note to the model and append the reply (Ctrl+J)"
      }
      onClick={() => (streamingHere ? stopChat() : void sendChat())}
      disabled={request !== null && !streamingHere}
      data-testid="editor-chat-button"
    >
      {streamingHere ? (
        <Square size={13} aria-hidden="true" />
      ) : (
        <MessageSquare size={14} aria-hidden="true" />
      )}
      <span>{streamingHere ? "Stop" : "Chat"}</span>
    </button>
  );
}
