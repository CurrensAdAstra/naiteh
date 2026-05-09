import type { EditorView } from "@codemirror/view";
import { create } from "zustand";

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
  /** Content currently in the editor (may be ahead of disk). */
  content: string;
}

export interface CurrentSelection {
  /** Selected text (empty when the cursor is collapsed). */
  text: string;
  from: number;
  to: number;
}

interface EditorState {
  open: OpenFile | null;
  /**
   * Live CodeMirror view; set by EditorPanel on mount. Stored here (rather
   * than in a ref) so sibling panels — most importantly AiPanel — can read
   * the current selection and dispatch replacements without prop drilling.
   * Not serialised by zustand.
   */
  view: EditorView | null;
  openNote: (relPath: string, content: string) => void;
  openJournal: (date: string, relPath: string, content: string) => void;
  closeNote: () => void;
  setContent: (content: string) => void;
  markSaved: () => void;
  setView: (view: EditorView | null) => void;
}

function keyFor(source: OpenSource): string {
  return source.kind === "note"
    ? `note:${source.relPath}`
    : `journal:${source.date}`;
}

export const useEditorStore = create<EditorState>((set) => ({
  open: null,
  view: null,
  openNote: (relPath, content) =>
    set({
      open: {
        source: { kind: "note", relPath },
        key: keyFor({ kind: "note", relPath }),
        savedContent: content,
        content,
      },
    }),
  openJournal: (date, relPath, content) =>
    set({
      open: {
        source: { kind: "journal", date, relPath },
        key: keyFor({ kind: "journal", date, relPath }),
        savedContent: content,
        content,
      },
    }),
  closeNote: () => set({ open: null }),
  setContent: (content) =>
    set((state) =>
      state.open === null ? state : { open: { ...state.open, content } },
    ),
  markSaved: () =>
    set((state) =>
      state.open === null
        ? state
        : { open: { ...state.open, savedContent: state.open.content } },
    ),
  setView: (view) => set({ view }),
}));

export function isDirty(open: OpenFile): boolean {
  return open.content !== open.savedContent;
}

/**
 * Read the current editor selection (or the entire document when nothing
 * is selected). Returns null when no editor view is mounted.
 */
export function readCurrentSelection(): CurrentSelection | null {
  const view = useEditorStore.getState().view;
  if (view === null) return null;
  const range = view.state.selection.main;
  if (range.from === range.to) {
    const text = view.state.doc.toString();
    return { text, from: 0, to: view.state.doc.length };
  }
  const text = view.state.sliceDoc(range.from, range.to);
  return { text, from: range.from, to: range.to };
}

/**
 * Replace the supplied range in the current editor view. Returns true on
 * success, false when no view is mounted.
 */
export function replaceRange(from: number, to: number, insert: string): boolean {
  const view = useEditorStore.getState().view;
  if (view === null) return false;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from, head: from + insert.length },
  });
  view.focus();
  return true;
}
