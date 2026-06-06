import { beforeEach, describe, expect, it } from "vitest";

import {
  JOURNAL_SPLIT_DEFAULT,
  JOURNAL_SPLIT_MAX,
  JOURNAL_SPLIT_MIN,
  LIST_PANEL_DEFAULT,
  LIST_PANEL_MAX,
  LIST_PANEL_MIN,
  useUIStore,
  type ViewMode,
} from "../uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: "journal",
      listPanelWidth: LIST_PANEL_DEFAULT,
      journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
      aiPanelOpen: false,
      commandPaletteOpen: false,
      editorReadOnly: false,
    });
  });

  it("ViewMode union exposes the seven documented modes", () => {
    const modes: ViewMode[] = [
      "journal",
      "notes",
      "calendar",
      "search",
      "tags",
      "sync",
      "settings",
    ];
    // type-level: each literal must satisfy ViewMode (compile-time check).
    expect(modes).toHaveLength(7);
  });

  it("setViewMode swaps the active mode", () => {
    useUIStore.getState().setViewMode("calendar");
    expect(useUIStore.getState().viewMode).toBe("calendar");
  });

  it("setListPanelWidth clamps below the minimum", () => {
    useUIStore.getState().setListPanelWidth(50);
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MIN);
  });

  it("setListPanelWidth clamps above the maximum", () => {
    useUIStore.getState().setListPanelWidth(9_999);
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MAX);
  });

  it("setListPanelWidth accepts values inside the range", () => {
    useUIStore.getState().setListPanelWidth(320);
    expect(useUIStore.getState().listPanelWidth).toBe(320);
  });

  it("setJournalSplitRatio clamps below the minimum", () => {
    useUIStore.getState().setJournalSplitRatio(-1);
    expect(useUIStore.getState().journalSplitRatio).toBe(JOURNAL_SPLIT_MIN);
  });

  it("setJournalSplitRatio clamps above the maximum", () => {
    useUIStore.getState().setJournalSplitRatio(1.5);
    expect(useUIStore.getState().journalSplitRatio).toBe(JOURNAL_SPLIT_MAX);
  });

  it("toggles the command palette", () => {
    useUIStore.getState().setCommandPaletteOpen(true);
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);

    useUIStore.getState().toggleCommandPalette();
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });

  it("requestEvernoteImport navigates to Settings and queues the action", () => {
    useUIStore.getState().requestEvernoteImport();
    expect(useUIStore.getState().viewMode).toBe("settings");
    expect(useUIStore.getState().pendingAction).toBe("evernoteImport");

    useUIStore.getState().clearPendingAction();
    expect(useUIStore.getState().pendingAction).toBeNull();
  });

  it("requestNewNote / requestNewFolder navigate to Notes and queue", () => {
    useUIStore.getState().requestNewNote();
    expect(useUIStore.getState().viewMode).toBe("notes");
    expect(useUIStore.getState().pendingAction).toBe("newNote");

    useUIStore.getState().requestNewFolder();
    expect(useUIStore.getState().viewMode).toBe("notes");
    expect(useUIStore.getState().pendingAction).toBe("newFolder");
  });
});
