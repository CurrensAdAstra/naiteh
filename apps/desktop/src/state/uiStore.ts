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

/**
 * A one-shot action requested from outside the React tree (e.g. a
 * native menu click) that a panel performs once it's mounted. The
 * requester also switches `viewMode` so the relevant panel is on screen.
 */
export type PendingAction = "evernoteImport";

interface UIState {
  viewMode: ViewMode;
  listPanelWidth: number;
  journalSplitRatio: number;
  aiPanelOpen: boolean;
  commandPaletteOpen: boolean;
  editorReadOnly: boolean;
  pendingAction: PendingAction | null;
  setViewMode: (mode: ViewMode) => void;
  setListPanelWidth: (px: number) => void;
  setJournalSplitRatio: (ratio: number) => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setEditorReadOnly: (readOnly: boolean) => void;
  toggleEditorReadOnly: () => void;
  /** Navigate to Settings and queue the Evernote import flow there. */
  requestEvernoteImport: () => void;
  clearPendingAction: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "journal",
  listPanelWidth: LIST_PANEL_DEFAULT,
  journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
  aiPanelOpen: false,
  commandPaletteOpen: false,
  editorReadOnly: false,
  pendingAction: null,
  setViewMode: (mode) => set({ viewMode: mode }),
  setListPanelWidth: (px) =>
    set({ listPanelWidth: clamp(px, LIST_PANEL_MIN, LIST_PANEL_MAX) }),
  setJournalSplitRatio: (ratio) =>
    set({
      journalSplitRatio: clamp(ratio, JOURNAL_SPLIT_MIN, JOURNAL_SPLIT_MAX),
    }),
  setAiPanelOpen: (open) => set({ aiPanelOpen: open }),
  toggleAiPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setEditorReadOnly: (readOnly) => set({ editorReadOnly: readOnly }),
  toggleEditorReadOnly: () =>
    set((s) => ({ editorReadOnly: !s.editorReadOnly })),
  requestEvernoteImport: () =>
    set({ viewMode: "settings", pendingAction: "evernoteImport" }),
  clearPendingAction: () => set({ pendingAction: null }),
}));
