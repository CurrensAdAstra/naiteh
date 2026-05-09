import { create } from "zustand";

interface OpenNote {
  relPath: string;
  /** The content as it exists on disk (last saved). */
  savedContent: string;
  /** The content currently in the editor (may be ahead of disk). */
  content: string;
}

interface EditorState {
  open: OpenNote | null;
  openNote: (relPath: string, content: string) => void;
  closeNote: () => void;
  setContent: (content: string) => void;
  markSaved: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  open: null,
  openNote: (relPath, content) =>
    set({ open: { relPath, savedContent: content, content } }),
  closeNote: () => set({ open: null }),
  setContent: (content) =>
    set((state) =>
      state.open === null
        ? state
        : { open: { ...state.open, content } },
    ),
  markSaved: () =>
    set((state) =>
      state.open === null
        ? state
        : { open: { ...state.open, savedContent: state.open.content } },
    ),
}));

export function isDirty(open: OpenNote): boolean {
  return open.content !== open.savedContent;
}
