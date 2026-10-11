import { create } from "zustand";

// architecture.md "ViewMode" (UI Architecture)
export type ViewMode =
  | "journal"
  | "notes"
  | "calendar"
  | "search"
  | "tags"
  | "sync";

// architecture.md "Layout (desktop, v1)" (UI Architecture)
export const LIST_PANEL_MIN = 200;
export const LIST_PANEL_MAX = 480;
export const LIST_PANEL_DEFAULT = 280;

// architecture.md "Journal mode (quick capture + activity summary)"
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
export type PendingAction =
  | "evernoteImport"
  | "newNote"
  | "newFolder"
  | "showBackup";

/**
 * How the open document is shown. `view` (the default) renders the
 * Markdown; `edit` shows the source editor. Opening a different document
 * returns to `view` unless the opener asks for `edit` (new notes).
 */
export type EditorMode = "view" | "edit";

interface UIState {
  viewMode: ViewMode;
  listPanelWidth: number;
  journalSplitRatio: number;
  aiPanelOpen: boolean;
  commandPaletteOpen: boolean;
  /** The Obsidian-style settings modal overlays the whole shell. */
  settingsOpen: boolean;
  editorMode: EditorMode;
  pendingAction: PendingAction | null;
  /**
   * The vault file watcher reported an error (`vault:watch-error`): list
   * panels and the open note no longer follow changes made outside naiteh
   * until the vault is reopened. Holds the backend's message.
   */
  liveUpdatesUnavailable: string | null;
  /**
   * A short, transient status-bar message ("Unsaved edits kept as …"),
   * cleared by the status bar after a few seconds.
   */
  notice: string | null;
  setViewMode: (mode: ViewMode) => void;
  setListPanelWidth: (px: number) => void;
  setJournalSplitRatio: (ratio: number) => void;
  setAiPanelOpen: (open: boolean) => void;
  toggleAiPanel: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  setSettingsOpen: (open: boolean) => void;
  setEditorMode: (mode: EditorMode) => void;
  toggleEditorMode: () => void;
  /** Open the settings modal and queue the Evernote import flow there. */
  requestEvernoteImport: () => void;
  /** Open the settings modal on its Backup section. */
  requestBackupSettings: () => void;
  /** Navigate to Notes and queue a new-note / new-folder prompt there. */
  requestNewNote: () => void;
  requestNewFolder: () => void;
  clearPendingAction: () => void;
  setLiveUpdatesUnavailable: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  viewMode: "journal",
  listPanelWidth: LIST_PANEL_DEFAULT,
  journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
  aiPanelOpen: false,
  commandPaletteOpen: false,
  settingsOpen: false,
  editorMode: "view",
  pendingAction: null,
  liveUpdatesUnavailable: null,
  notice: null,
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
  setEditorMode: (mode) => set({ editorMode: mode }),
  toggleEditorMode: () =>
    set((s) => ({ editorMode: s.editorMode === "view" ? "edit" : "view" })),
  requestEvernoteImport: () =>
    set({ settingsOpen: true, pendingAction: "evernoteImport" }),
  requestBackupSettings: () =>
    set({ settingsOpen: true, pendingAction: "showBackup" }),
  requestNewNote: () =>
    set({ viewMode: "notes", pendingAction: "newNote" }),
  requestNewFolder: () =>
    set({ viewMode: "notes", pendingAction: "newFolder" }),
  clearPendingAction: () => set({ pendingAction: null }),
  setLiveUpdatesUnavailable: (message) =>
    set({ liveUpdatesUnavailable: message }),
  setNotice: (message) => set({ notice: message }),
}));
