import { create } from "zustand";

// architecture.md §5.3
export type ViewMode =
  | "journal"
  | "notes"
  | "calendar"
  | "search"
  | "tags"
  | "sync";

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
export type PendingAction = "evernoteImport" | "newNote" | "newFolder";

interface UIState {
  viewMode: ViewMode;
  listPanelWidth: number;
  journalSplitRatio: number;
  aiPanelOpen: boolean;
  commandPaletteOpen: boolean;
  /** The Obsidian-style settings modal overlays the whole shell. */
  settingsOpen: boolean;
  editorReadOnly: boolean;
  pendingAction: PendingAction | null;
  setViewMode: (mode: ViewMode) => void;
  setListPanelWidth: (px: number) => void;
  setJournalSplitRatio: (ratio: number) => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setSettingsOpen: (open: boolean) => void;
  setEditorReadOnly: (readOnly: boolean) => void;
  toggleEditorReadOnly: () => void;
  /** Open the settings modal and queue the Evernote import flow there. */
  requestEvernoteImport: () => void;
  /** Navigate to Notes and queue a new-note / new-folder prompt there. */
  requestNewNote: () => void;
  requestNewFolder: () => void;
  clearPendingAction: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "journal",
  listPanelWidth: LIST_PANEL_DEFAULT,
  journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
  aiPanelOpen: false,
  commandPaletteOpen: false,
  settingsOpen: false,
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
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setEditorReadOnly: (readOnly) => set({ editorReadOnly: readOnly }),
  toggleEditorReadOnly: () =>
    set((s) => ({ editorReadOnly: !s.editorReadOnly })),
  requestEvernoteImport: () =>
    set({ settingsOpen: true, pendingAction: "evernoteImport" }),
  requestNewNote: () =>
    set({ viewMode: "notes", pendingAction: "newNote" }),
  requestNewFolder: () =>
    set({ viewMode: "notes", pendingAction: "newFolder" }),
  clearPendingAction: () => set({ pendingAction: null }),
}));
