import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteMeta, TimelineItem } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { JournalListPanel } from "../JournalListPanel";

vi.mock("../../../lib/api/journal", () => ({
  quickCreate: vi.fn(),
  quickList: vi.fn(),
  activityRecent: vi.fn(),
  journalOpen: vi.fn(),
}));
vi.mock("../../../lib/api/notes", () => ({
  notesRead: vi.fn(),
}));

import {
  activityRecent,
  journalOpen,
  quickCreate,
  quickList,
} from "../../../lib/api/journal";
import { notesRead } from "../../../lib/api/notes";

const mockedQuickList = vi.mocked(quickList);
const mockedQuickCreate = vi.mocked(quickCreate);
const mockedActivityRecent = vi.mocked(activityRecent);
const mockedNotesRead = vi.mocked(notesRead);
const mockedJournalOpen = vi.mocked(journalOpen);

const noteFixture: NoteMeta = {
  path: "/v/notes/_inbox/2026-05-09T10-00-00.md",
  relPath: "notes/_inbox/2026-05-09T10-00-00.md",
  title: "2026-05-09T10-00-00",
  tags: [],
  mtime: Math.floor(Date.now() / 1000) - 60,
  size: 0,
  pinned: false,
};

const journalEntryFixture: TimelineItem = {
  kind: "JournalEntry",
  date: "2026-05-09",
  path: "/v/journal/2026/05/2026-05-09.md",
  mtime: Math.floor(Date.now() / 1000) - 30,
  title: "Day entry",
  snippet: "Today I worked on…",
};

const noteItemFixture: TimelineItem = {
  kind: "Note",
  relPath: "notes/work/standup.md",
  title: "Standup",
  mtime: Math.floor(Date.now() / 1000) - 90,
  snippet: "Pinned note body",
  pinned: true,
};

describe("JournalListPanel", () => {
  beforeEach(() => {
    mockedQuickList.mockReset();
    mockedQuickCreate.mockReset();
    mockedActivityRecent.mockReset();
    mockedNotesRead.mockReset();
    mockedJournalOpen.mockReset();
    useEditorStore.setState({ open: null });
  });

  it("renders empty states when both lists are empty", async () => {
    mockedQuickList.mockResolvedValue([]);
    mockedActivityRecent.mockResolvedValue([]);
    render(<JournalListPanel />);
    expect(
      await within(screen.getByTestId("journal-quick-capture")).findByText(
        /no quick notes yet/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("journal-recent-activity")).getByText(
        /no activity yet/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders quick notes and activity items", async () => {
    mockedQuickList.mockResolvedValue([noteFixture]);
    mockedActivityRecent.mockResolvedValue([
      journalEntryFixture,
      noteItemFixture,
    ]);
    render(<JournalListPanel />);
    expect(
      await within(screen.getByTestId("journal-quick-capture")).findByText(
        noteFixture.title,
      ),
    ).toBeInTheDocument();
    const activitySection = screen.getByTestId("journal-recent-activity");
    expect(within(activitySection).getByText("Day entry")).toBeInTheDocument();
    expect(within(activitySection).getByText("Standup")).toBeInTheDocument();
    // Pinned note exposes a star marker.
    expect(within(activitySection).getByLabelText("pinned")).toBeInTheDocument();
  });

  it('quick_create immediately opens the new note in the editor', async () => {
    mockedQuickList.mockResolvedValue([]);
    mockedActivityRecent.mockResolvedValue([]);
    mockedQuickCreate.mockResolvedValue(noteFixture);
    mockedNotesRead.mockResolvedValue("");
    const user = userEvent.setup();
    render(<JournalListPanel />);
    await screen.findByText(/no quick notes yet/i);

    // After create, refresh pulls the new note.
    mockedQuickList.mockResolvedValue([noteFixture]);

    await user.click(screen.getByRole("button", { name: /new quick note/i }));
    await waitFor(() => expect(mockedQuickCreate).toHaveBeenCalledTimes(1));
    await within(screen.getByTestId("journal-quick-capture")).findByText(
      noteFixture.title,
    );
    await waitFor(() => {
      expect(mockedNotesRead).toHaveBeenCalledWith(noteFixture.relPath);
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "note",
        relPath: noteFixture.relPath,
      });
    });
  });

  it("clicking a Quick Capture entry opens it via notesRead", async () => {
    mockedQuickList.mockResolvedValue([noteFixture]);
    mockedActivityRecent.mockResolvedValue([]);
    mockedNotesRead.mockResolvedValue("note body");
    const user = userEvent.setup();
    render(<JournalListPanel />);
    const button = await screen.findByTestId(
      `quick-note-${noteFixture.relPath}`,
    );
    await user.click(button);
    await waitFor(() => {
      expect(mockedNotesRead).toHaveBeenCalledWith(noteFixture.relPath);
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "note",
        relPath: noteFixture.relPath,
      });
    });
  });

  it("clicking a Recent Activity journal entry dispatches journalOpen", async () => {
    mockedQuickList.mockResolvedValue([]);
    mockedActivityRecent.mockResolvedValue([journalEntryFixture]);
    mockedJournalOpen.mockResolvedValue({
      path: "ignored",
      content: "day body",
      exists: true,
    });
    const user = userEvent.setup();
    render(<JournalListPanel />);
    const button = await screen.findByTestId(
      `activity-journal:${journalEntryFixture.date}`,
    );
    await user.click(button);
    await waitFor(() => {
      expect(mockedJournalOpen).toHaveBeenCalledWith(journalEntryFixture.date);
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "journal",
        date: journalEntryFixture.date,
        relPath: `journal/2026/05/${journalEntryFixture.date}.md`,
      });
    });
    expect(mockedNotesRead).not.toHaveBeenCalled();
  });

  it("clicking a Recent Activity note dispatches notesRead", async () => {
    mockedQuickList.mockResolvedValue([]);
    mockedActivityRecent.mockResolvedValue([noteItemFixture]);
    mockedNotesRead.mockResolvedValue("standup body");
    const user = userEvent.setup();
    render(<JournalListPanel />);
    const button = await screen.findByTestId(
      `activity-note:${noteItemFixture.relPath}`,
    );
    await user.click(button);
    await waitFor(() => {
      expect(mockedNotesRead).toHaveBeenCalledWith(noteItemFixture.relPath);
    });
  });

  it("surfaces backend errors", async () => {
    mockedQuickList.mockRejectedValue({ kind: "NotFound", message: "no vault" });
    mockedActivityRecent.mockResolvedValue([]);
    render(<JournalListPanel />);
    expect(
      await within(screen.getByTestId("journal-quick-capture")).findByText(
        /no vault/i,
      ),
    ).toBeInTheDocument();
  });
});
