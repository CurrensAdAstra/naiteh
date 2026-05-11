import { create } from "zustand";

// architecture.md §5.3
export type ViewMode =
  | "journal"
  | "notes"
  | "calendar"
  | "search"
  | "tags"
  | "sync"
  | "settings";

// architecture.md §5.1
export const LIST_PANEL_MIN = 200;
export const LIST_PANEL_MAX = 480;
export const LIST_PANEL_DEFAULT = 280;

// architecture.md §5.5
export const JOURNAL_SPLIT_MIN = 0.1;
export const JOURNAL_SPLIT_MAX = 0.9;
export const JOURNAL_SPLIT_DEFAULT = 0.5;

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

interface UIState {
  viewMode: ViewMode;
  listPanelWidth: number;
  journalSplitRatio: number;
  aiPanelOpen: boolean;
  editorReadOnly: boolean;
  setViewMode: (mode: ViewMode) => void;
  setListPanelWidth: (px: number) => void;
  setJournalSplitRatio: (ratio: number) => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setEditorReadOnly: (readOnly: boolean) => void;
  toggleEditorReadOnly: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "journal",
  listPanelWidth: LIST_PANEL_DEFAULT,
  journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
  aiPanelOpen: false,
  editorReadOnly: false,
  setViewMode: (mode) => set({ viewMode: mode }),
  setListPanelWidth: (px) =>
    set({ listPanelWidth: clamp(px, LIST_PANEL_MIN, LIST_PANEL_MAX) }),
  setJournalSplitRatio: (ratio) =>
    set({
      journalSplitRatio: clamp(ratio, JOURNAL_SPLIT_MIN, JOURNAL_SPLIT_MAX),
    }),
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  setEditorReadOnly: (readOnly) => set({ editorReadOnly: readOnly }),
  toggleEditorReadOnly: () =>
    set((s) => ({ editorReadOnly: !s.editorReadOnly })),
}));
