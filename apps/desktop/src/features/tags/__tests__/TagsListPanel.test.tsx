import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteMeta, TagCount } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { TagsListPanel } from "../TagsListPanel";

vi.mock("../../../lib/api/tags", () => ({
  tagsList: vi.fn(),
  tagsNotes: vi.fn(),
}));
vi.mock("../../../lib/api/notes", () => ({
  notesRead: vi.fn(),
}));
vi.mock("../../../lib/api/journal", () => ({
  journalOpen: vi.fn(),
}));

import { journalOpen } from "../../../lib/api/journal";
import { notesRead } from "../../../lib/api/notes";
import { tagsList, tagsNotes } from "../../../lib/api/tags";

const mockedTagsList = vi.mocked(tagsList);
const mockedTagsNotes = vi.mocked(tagsNotes);
const mockedNotesRead = vi.mocked(notesRead);
const mockedJournalOpen = vi.mocked(journalOpen);

function tag(t: string, c: number): TagCount {
  return { tag: t, count: c };
}

function note(relPath: string, title: string): NoteMeta {
  return {
    path: `/v/${relPath}`,
    relPath,
    title,
    tags: [],
    mtime: 0,
    size: 0,
    pinned: false,
  };
}

describe("TagsListPanel", () => {
  beforeEach(() => {
    mockedTagsList.mockReset();
    mockedTagsNotes.mockReset();
    mockedNotesRead.mockReset();
    mockedJournalOpen.mockReset();
    useEditorStore.setState({ open: null });
  });

  it("renders the empty state when no tags exist", async () => {
    mockedTagsList.mockResolvedValue([]);
    render(<TagsListPanel />);
    expect(await screen.findByText(/no tags yet/i)).toBeInTheDocument();
  });

  it("renders tag rows with counts, descending by count", async () => {
    mockedTagsList.mockResolvedValue([tag("work", 3), tag("idea", 1)]);
    render(<TagsListPanel />);
    const list = await screen.findByTestId("tags-list");
    const items = within(list).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["work3", "idea1"]);
  });

  it("clicking a tag fetches and renders its notes", async () => {
    mockedTagsList.mockResolvedValue([tag("work", 2)]);
    mockedTagsNotes.mockResolvedValue([
      note("notes/work/standup.md", "Standup"),
      note("notes/work/plan.md", "Plan"),
    ]);

    const user = userEvent.setup();
    render(<TagsListPanel />);
    await user.click(await screen.findByTestId("tag-work"));

    await waitFor(() => {
      expect(mockedTagsNotes).toHaveBeenCalledWith("work");
    });
    const notesList = await screen.findByTestId("tags-notes-list");
    expect(within(notesList).getByText("Standup")).toBeInTheDocument();
    expect(within(notesList).getByText("Plan")).toBeInTheDocument();
  });

  it("clicking a note opens it via notesRead", async () => {
    mockedTagsList.mockResolvedValue([tag("work", 1)]);
    mockedTagsNotes.mockResolvedValue([
      note("notes/work/standup.md", "Standup"),
    ]);
    mockedNotesRead.mockResolvedValue("standup body");

    const user = userEvent.setup();
    render(<TagsListPanel />);
    await user.click(await screen.findByTestId("tag-work"));
    const noteRow = await screen.findByTestId(
      "tag-note-notes/work/standup.md",
    );
    await user.click(noteRow);
    await waitFor(() => {
      expect(mockedNotesRead).toHaveBeenCalledWith("notes/work/standup.md");
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "note",
        relPath: "notes/work/standup.md",
      });
    });
    expect(mockedJournalOpen).not.toHaveBeenCalled();
  });

  it("clicking a journal-shaped relPath dispatches to journalOpen", async () => {
    mockedTagsList.mockResolvedValue([tag("daily", 1)]);
    mockedTagsNotes.mockResolvedValue([
      note("journal/2026/05/2026-05-09.md", "Day"),
    ]);
    mockedJournalOpen.mockResolvedValue({
      path: "ignored",
      content: "day body",
      exists: true,
    });

    const user = userEvent.setup();
    render(<TagsListPanel />);
    await user.click(await screen.findByTestId("tag-daily"));
    const row = await screen.findByTestId(
      "tag-note-journal/2026/05/2026-05-09.md",
    );
    await user.click(row);
    await waitFor(() => {
      expect(mockedJournalOpen).toHaveBeenCalledWith("2026-05-09");
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "journal",
        date: "2026-05-09",
        relPath: "journal/2026/05/2026-05-09.md",
      });
    });
    expect(mockedNotesRead).not.toHaveBeenCalled();
  });

  it("highlights the currently open note in the tag results", async () => {
    mockedTagsList.mockResolvedValue([tag("work", 1)]);
    mockedTagsNotes.mockResolvedValue([
      note("notes/work/standup.md", "Standup"),
    ]);
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/work/standup.md" },
        key: "note:notes/work/standup.md",
        content: "x",
        savedContent: "x",
      },
    });

    const user = userEvent.setup();
    render(<TagsListPanel />);
    await user.click(await screen.findByTestId("tag-work"));
    const row = await screen.findByTestId(
      "tag-note-notes/work/standup.md",
    );
    expect(row.className).toMatch(/noteRowActive/);
  });

  it("surfaces backend errors", async () => {
    mockedTagsList.mockRejectedValue({
      kind: "NotFound",
      message: "no vault",
    });
    render(<TagsListPanel />);
    expect(
      await within(screen.getByTestId("list-panel-tags")).findByText(
        /no vault/i,
      ),
    ).toBeInTheDocument();
  });
});
