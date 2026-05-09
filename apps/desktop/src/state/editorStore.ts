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

interface EditorState {
  open: OpenFile | null;
  openNote: (relPath: string, content: string) => void;
  openJournal: (date: string, relPath: string, content: string) => void;
  closeNote: () => void;
  setContent: (content: string) => void;
  markSaved: () => void;
}

function keyFor(source: OpenSource): string {
  return source.kind === "note"
    ? `note:${source.relPath}`
    : `journal:${source.date}`;
}

export const useEditorStore = create<EditorState>((set) => ({
  open: null,
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
}));

export function isDirty(open: OpenFile): boolean {
  return open.content !== open.savedContent;
}
