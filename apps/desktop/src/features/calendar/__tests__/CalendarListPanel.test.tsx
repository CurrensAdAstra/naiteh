import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  JournalOpenResult,
  TimelineDay,
  TimelineItem,
} from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { CalendarListPanel } from "../CalendarListPanel";
import { todayLocal } from "../dateUtils";

vi.mock("../../../lib/api/journal", () => ({
  timelineRange: vi.fn(),
  timelinePinned: vi.fn(),
  journalOpen: vi.fn(),
}));
vi.mock("../../../lib/api/notes", () => ({
  notesRead: vi.fn(),
}));

import {
  journalOpen,
  timelinePinned,
  timelineRange,
} from "../../../lib/api/journal";
import { notesRead } from "../../../lib/api/notes";

const mockedRange = vi.mocked(timelineRange);
const mockedPinned = vi.mocked(timelinePinned);
const mockedJournalOpen = vi.mocked(journalOpen);
const mockedNotesRead = vi.mocked(notesRead);

const TODAY = todayLocal();
const YESTERDAY = todayLocal(new Date(Date.now() - 86_400_000));

const journalItem: TimelineItem = {
  kind: "JournalEntry",
  date: TODAY,
  path: `/v/journal/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/${TODAY}.md`,
  mtime: 0,
  title: "Today entry",
  snippet: "the body",
};

const noteItem: TimelineItem = {
  kind: "Note",
  relPath: "notes/work/standup.md",
  title: "Standup",
  mtime: 0,
  snippet: "agenda",
  pinned: true,
};

function dayWith(date: string, items: TimelineItem[]): TimelineDay {
  return { date, items };
}

describe("CalendarListPanel", () => {
  beforeEach(() => {
    mockedRange.mockReset();
    mockedPinned.mockReset();
    mockedJournalOpen.mockReset();
    mockedNotesRead.mockReset();
    useEditorStore.setState({ open: null });
  });

  it("renders pinned section, today separator, and items", async () => {
    mockedRange.mockResolvedValue([dayWith(TODAY, [journalItem])]);
    mockedPinned.mockResolvedValue([noteItem]);
    render(<CalendarListPanel />);
    expect(
      await screen.findByTestId("calendar-pinned"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("calendar-pinned")).getByText("Standup"),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`calendar-day-${TODAY}`)).toBeInTheDocument();
    expect(screen.getByText("Today entry")).toBeInTheDocument();
  });

  it('renders "— start a journal entry" placeholder for empty days', async () => {
    mockedRange.mockResolvedValue([dayWith(YESTERDAY, [])]);
    mockedPinned.mockResolvedValue([]);
    render(<CalendarListPanel />);
    expect(
      await screen.findByTestId(`calendar-empty-${YESTERDAY}`),
    ).toBeInTheDocument();
  });

  it("clicking an empty day opens the journal entry in the editor", async () => {
    mockedRange.mockResolvedValue([dayWith(YESTERDAY, [])]);
    mockedPinned.mockResolvedValue([]);
    const result: JournalOpenResult = {
      path: "ignored",
      content: "",
      exists: false,
    };
    mockedJournalOpen.mockResolvedValue(result);

    const user = userEvent.setup();
    render(<CalendarListPanel />);
    const placeholder = await screen.findByTestId(
      `calendar-empty-${YESTERDAY}`,
    );
    await user.click(placeholder);
    await waitFor(() => {
      const open = useEditorStore.getState().open;
      expect(open).not.toBeNull();
      expect(open!.source).toEqual({
        kind: "journal",
        date: YESTERDAY,
        relPath: `journal/${YESTERDAY.slice(0, 4)}/${YESTERDAY.slice(5, 7)}/${YESTERDAY}.md`,
      });
    });
  });

  it("clicking a journal item opens it via journalOpen", async () => {
    mockedRange.mockResolvedValue([dayWith(TODAY, [journalItem])]);
    mockedPinned.mockResolvedValue([]);
    mockedJournalOpen.mockResolvedValue({
      path: "ignored",
      content: "today body",
      exists: true,
    });

    const user = userEvent.setup();
    render(<CalendarListPanel />);
    const item = await screen.findByTestId(
      `calendar-item-journal:${TODAY}`,
    );
    await user.click(item);
    await waitFor(() => {
      expect(mockedJournalOpen).toHaveBeenCalledWith(TODAY);
      expect(useEditorStore.getState().open?.content).toBe("today body");
    });
    expect(mockedNotesRead).not.toHaveBeenCalled();
  });

  it("clicking a note item opens it via notesRead", async () => {
    mockedRange.mockResolvedValue([dayWith(TODAY, [noteItem])]);
    mockedPinned.mockResolvedValue([]);
    mockedNotesRead.mockResolvedValue("note body");

    const user = userEvent.setup();
    render(<CalendarListPanel />);
    const item = await screen.findByTestId(
      `calendar-item-note:notes/work/standup.md`,
    );
    await user.click(item);
    await waitFor(() => {
      expect(mockedNotesRead).toHaveBeenCalledWith("notes/work/standup.md");
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "note",
        relPath: "notes/work/standup.md",
      });
    });
    expect(mockedJournalOpen).not.toHaveBeenCalled();
  });

  it("surfaces backend errors from timelineRange", async () => {
    mockedRange.mockRejectedValue({ kind: "NotFound", message: "no vault" });
    mockedPinned.mockResolvedValue([]);
    render(<CalendarListPanel />);
    expect(
      await within(screen.getByTestId("calendar-body")).findByText(
        /no vault/i,
      ),
    ).toBeInTheDocument();
  });
});
