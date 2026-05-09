import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/notes", () => ({
  notesRead: vi.fn(),
}));
vi.mock("../api/journal", () => ({
  journalOpen: vi.fn(),
}));

import { journalOpen } from "../api/journal";
import { notesRead } from "../api/notes";
import { openByRelPath } from "../openByRelPath";
import { useEditorStore } from "../../state/editorStore";

const mockedNotesRead = vi.mocked(notesRead);
const mockedJournalOpen = vi.mocked(journalOpen);

describe("openByRelPath", () => {
  beforeEach(() => {
    mockedNotesRead.mockReset();
    mockedJournalOpen.mockReset();
    useEditorStore.setState({ open: null });
  });

  it("dispatches to notesRead for note paths", async () => {
    mockedNotesRead.mockResolvedValue("body");
    await openByRelPath("notes/work/standup.md");
    expect(mockedNotesRead).toHaveBeenCalledWith("notes/work/standup.md");
    expect(useEditorStore.getState().open?.source).toEqual({
      kind: "note",
      relPath: "notes/work/standup.md",
    });
  });

  it("dispatches to journalOpen for canonical journal paths", async () => {
    mockedJournalOpen.mockResolvedValue({
      path: "ignored",
      content: "day",
      exists: true,
    });
    await openByRelPath("journal/2026/05/2026-05-09.md");
    expect(mockedJournalOpen).toHaveBeenCalledWith("2026-05-09");
    expect(useEditorStore.getState().open?.source).toEqual({
      kind: "journal",
      date: "2026-05-09",
      relPath: "journal/2026/05/2026-05-09.md",
    });
  });

  it("treats non-canonical 'journal/...' paths as plain notes", async () => {
    mockedNotesRead.mockResolvedValue("note body");
    await openByRelPath("journal/draft.md");
    expect(mockedNotesRead).toHaveBeenCalledWith("journal/draft.md");
    expect(mockedJournalOpen).not.toHaveBeenCalled();
  });
});
