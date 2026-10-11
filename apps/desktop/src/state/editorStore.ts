import type { EditorView } from "@codemirror/view";
import { create } from "zustand";

import { useUIStore } from "./uiStore";

/**
 * Where the open content lives in the vault. Calendar-mode journal entries
 * are addressed by date; freeform notes by their vault-relative path.
 */
export type OpenSource =
  | { kind: "note"; relPath: string }
  | { kind: "journal"; date: string; relPath: string };

export interface OpenFile {
  source: OpenSource;
  /** Stable identity used by the editor view; rebuilds when this changes. */
  key: string;
  /** Content as it exists on disk (last saved). */
  savedContent: string;
  /**
   * Version token (hex SHA-256 of the file bytes) of `savedContent` on
   * disk; `""` for a journal entry that doesn't exist yet. Sent back as
   * `expectedVersion` on every autosave so a file changed outside naiteh
   * is never overwritten blindly.
   */
  savedVersion: string;
  /** Content currently in the editor (may be ahead of disk). */
  content: string;
}

/**
 * The open document changed on disk while it had unsaved local edits (or
 * an autosave was refused with `StaleWrite`). Autosave is held for `key`
 * until the user resolves it (lib/externalChange); `diskVersion` is the
 * version the file has now — `""` when it was removed.
 */
export interface ExternalChange {
  key: string;
  diskVersion: string;
}

export interface CurrentSelection {
  /** Selected text (empty when the cursor is collapsed). */
  text: string;
  from: number;
  to: number;
}

/** Last autosave failure, scoped to the note it happened on. */
export interface SaveError {
  key: string;
  message: string;
}

interface EditorState {
  open: OpenFile | null;
  /**
   * Bumped whenever the open document's text is replaced from outside the
   * editor (fresh open, re-open of the same path, reload after sync). The
   * CodeMirror view is rebuilt on `(key, revision)` so it never keeps
   * showing stale text the store has already moved past.
   */
  revision: number;
  /** Most recent autosave failure (null when the last save succeeded). */
  saveError: SaveError | null;
  /** Unresolved conflict with the file on disk (see {@link ExternalChange}). */
  externalChange: ExternalChange | null;
  /**
   * Live CodeMirror view; set by EditorPanel on mount. Stored here (rather
   * than in a ref) so sibling panels — most importantly AiPanel — can read
   * the current selection and dispatch replacements without prop drilling.
   * Not serialised by zustand.
   */
  view: EditorView | null;
  openNote: (relPath: string, content: string, version: string) => void;
  openJournal: (
    date: string,
    relPath: string,
    content: string,
    version: string,
  ) => void;
  closeNote: () => void;
  /** Close the note *and* drop the view / error state (logout, vault switch). */
  resetEditor: () => void;
  setContent: (content: string) => void;
  /**
   * Record that `content` was written to disk for the note identified by
   * `key`. No-op when a different note is open now. Only the written text
   * becomes `savedContent` — edits typed during the write stay dirty.
   */
  markSaved: (key: string, content: string, version: string) => void;
  /**
   * Replace the open document with fresh disk content (e.g. after a sync
   * pull). Marks it clean and bumps `revision` so the view reloads.
   */
  reloadOpen: (key: string, content: string, version: string) => void;
  /**
   * Point the open document at a new location (rename / folder move)
   * while keeping the in-memory content and dirty state.
   */
  retargetOpen: (fromKey: string, source: OpenSource) => void;
  setSaveError: (key: string, message: string | null) => void;
  /** Enter (or, with `null`, leave) the changed-on-disk conflict state. */
  setExternalChange: (change: ExternalChange | null) => void;
  setView: (view: EditorView | null) => void;
}

export function keyFor(source: OpenSource): string {
  return source.kind === "note"
    ? `note:${source.relPath}`
    : `journal:${source.date}`;
}

export const useEditorStore = create<EditorState>((set) => ({
  open: null,
  revision: 0,
  saveError: null,
  externalChange: null,
  view: null,
  openNote: (relPath, content, version) =>
    set((s) => ({
      open: {
        source: { kind: "note", relPath },
        key: keyFor({ kind: "note", relPath }),
        savedContent: content,
        savedVersion: version,
        content,
      },
      revision: s.revision + 1,
      externalChange: null,
    })),
  openJournal: (date, relPath, content, version) =>
    set((s) => ({
      open: {
        source: { kind: "journal", date, relPath },
        key: keyFor({ kind: "journal", date, relPath }),
        savedContent: content,
        savedVersion: version,
        content,
      },
      revision: s.revision + 1,
      externalChange: null,
    })),
  closeNote: () => set({ open: null, externalChange: null }),
  resetEditor: () => {
    cancelPendingOpens();
    set({ open: null, view: null, saveError: null, externalChange: null });
  },
  setContent: (content) =>
    set((state) =>
      state.open === null || state.open.content === content
        ? state
        : { open: { ...state.open, content } },
    ),
  markSaved: (key, content, version) =>
    set((state) => {
      if (state.open === null || state.open.key !== key) return state;
      if (
        state.open.savedContent === content &&
        state.open.savedVersion === version
      ) {
        return state;
      }
      return {
        open: { ...state.open, savedContent: content, savedVersion: version },
      };
    }),
  reloadOpen: (key, content, version) =>
    set((state) => {
      if (state.open === null || state.open.key !== key) return state;
      return {
        open: {
          ...state.open,
          content,
          savedContent: content,
          savedVersion: version,
        },
        revision: state.revision + 1,
        saveError: state.saveError?.key === key ? null : state.saveError,
      };
    }),
  retargetOpen: (fromKey, source) =>
    set((state) => {
      if (state.open === null || state.open.key !== fromKey) return state;
      const key = keyFor(source);
      return {
        open: { ...state.open, source, key },
        saveError: state.saveError?.key === fromKey ? null : state.saveError,
        externalChange:
          state.externalChange?.key === fromKey
            ? { ...state.externalChange, key }
            : state.externalChange,
      };
    }),
  setSaveError: (key, message) =>
    set((state) => {
      if (message === null) {
        return state.saveError?.key === key ? { saveError: null } : state;
      }
      return { saveError: { key, message } };
    }),
  setExternalChange: (change) =>
    set((state) => {
      if (change === null) {
        return state.externalChange === null ? state : { externalChange: null };
      }
      // Only the open document can be in conflict.
      if (state.open === null || state.open.key !== change.key) return state;
      return { externalChange: change };
    }),
  setView: (view) => set({ view }),
}));

/** True while the open document is in the changed-on-disk conflict state. */
export function hasExternalChange(
  state: Pick<EditorState, "open" | "externalChange">,
): boolean {
  return (
    state.open !== null &&
    state.externalChange !== null &&
    state.externalChange.key === state.open.key
  );
}

export function isDirty(open: OpenFile): boolean {
  return open.content !== open.savedContent;
}

// ── open-request sequencing ─────────────────────────────────────────────
//
// Opening a document is async (flush + IPC read). Each request takes a
// ticket; only the newest ticket may apply its result, so clicking A then
// B never ends with A open because A's read resolved last.

let openTicket = 0;

/** Start a new open request; returns its ticket. */
export function beginOpen(): number {
  openTicket += 1;
  return openTicket;
}

/** True while `ticket` is still the most recent open request. */
export function isLatestOpen(ticket: number): boolean {
  return ticket === openTicket;
}

/** Invalidate every in-flight open request (logout, vault switch). */
export function cancelPendingOpens(): void {
  openTicket += 1;
}

// ── view helpers ────────────────────────────────────────────────────────

function hasLiveView(view: EditorView | null): view is EditorView {
  return view !== null && view.state !== undefined;
}

/** Key of the open document, or null when nothing is open. */
export function currentOpenKey(): string | null {
  return useEditorStore.getState().open?.key ?? null;
}

/**
 * The open document's current text — from the live view when mounted
 * (authoritative), otherwise from the store. Null when nothing is open.
 */
export function readCurrentDoc(): string | null {
  const { open, view } = useEditorStore.getState();
  if (open === null) return null;
  if (hasLiveView(view)) return view.state.doc.toString();
  return open.content;
}

/**
 * Read the current editor selection (or the entire document when nothing
 * is selected). Returns null when no editor view is mounted. In view mode
 * the source editor is hidden, so its selection is stale and invisible —
 * the whole document is used instead.
 */
export function readCurrentSelection(): CurrentSelection | null {
  const view = useEditorStore.getState().view;
  if (view === null) return null;
  const range = view.state.selection.main;
  if (range.from === range.to || useUIStore.getState().editorMode === "view") {
    const text = view.state.doc.toString();
    return { text, from: 0, to: view.state.doc.length };
  }
  const text = view.state.sliceDoc(range.from, range.to);
  return { text, from: range.from, to: range.to };
}

/**
 * Mirror the view's document into `open.content` for the note identified
 * by `key`. The view's updateListener normally does this already (inside
 * `dispatch`); calling it again is idempotent and covers views without
 * that listener (tests, a view mid-teardown).
 */
function syncStoreFromView(key: string, view: EditorView): void {
  const doc = view.state.doc.toString();
  useEditorStore.setState((s) =>
    s.open === null || s.open.key !== key || s.open.content === doc
      ? s
      : { open: { ...s.open, content: doc } },
  );
}

/**
 * Replace the entire editor document, preserving the cursor at its
 * current offset clamped to the new length. Afterwards the store's
 * `open.content` always equals the view's document.
 */
export function replaceWholeDocument(insert: string): boolean {
  const state = useEditorStore.getState();
  const open = state.open;
  if (open === null) return false;
  const view = state.view;
  if (hasLiveView(view)) {
    const cursor = Math.min(view.state.selection.main.head, insert.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert },
      selection: { anchor: cursor, head: cursor },
    });
    if (typeof view.focus === "function") view.focus();
    syncStoreFromView(open.key, view);
    return true;
  }
  useEditorStore.setState((s) =>
    s.open === null || s.open.key !== open.key
      ? s
      : { open: { ...s.open, content: insert } },
  );
  return true;
}

/**
 * Replace the supplied range in the current editor view. Returns true on
 * success, false when no note is open or the range is out of bounds.
 *
 * The store is re-synced from the view *after* the dispatch rather than
 * splicing `insert` into `open.content` a second time: the view's
 * updateListener has already mirrored the change synchronously, so a
 * second splice would duplicate the inserted text.
 */
export function replaceRange(from: number, to: number, insert: string): boolean {
  const { view, open } = useEditorStore.getState();
  if (open === null) return false;
  if (!hasLiveView(view)) {
    if (from < 0 || from > to || to > open.content.length) return false;
    const next = `${open.content.slice(0, from)}${insert}${open.content.slice(to)}`;
    useEditorStore.setState({ open: { ...open, content: next } });
    return true;
  }
  if (from < 0 || from > to || to > view.state.doc.length) return false;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from, head: from + insert.length },
  });
  if (typeof view.focus === "function") view.focus();
  syncStoreFromView(open.key, view);
  return true;
}

export function insertAtCursor(insert: string): boolean {
  const open = useEditorStore.getState().open;
  if (open === null) return false;
  const view = useEditorStore.getState().view;
  if (!hasLiveView(view)) {
    return replaceRange(open.content.length, open.content.length, insert);
  }
  const range = view.state.selection.main;
  return replaceRange(range.from, range.to, insert);
}
