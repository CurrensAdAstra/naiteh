import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CalendarEvent, CalendarSource, NoteMeta } from "../../../lib/types";
import { useCalendarStore } from "../../../state/calendarStore";
import { useEditorStore } from "../../../state/editorStore";
import { useUIStore } from "../../../state/uiStore";
import { addDays, formatFullDate } from "../eventUtils";
import { todayLocal } from "../dateUtils";
import type { TimelineItem } from "../../../lib/types";
import { DayTimeline, NOTES_LOCAL_ONLY_TEXT } from "../DayTimeline";

vi.mock("../../../lib/api/journal", () => ({
  timelineRange: vi.fn(),
  timelinePinned: vi.fn(),
  journalOpen: vi.fn(),
}));
vi.mock("../../../lib/api/notes", () => ({ notesRead: vi.fn() }));
vi.mock("../../../lib/api/calendar", () => ({
  calendarList: vi.fn(),
  calendarEvents: vi.fn(),
  calendarEventNote: vi.fn(),
}));

import {
  calendarEventNote,
  calendarEvents,
  calendarList,
} from "../../../lib/api/calendar";
import { timelineRange } from "../../../lib/api/journal";
import { notesRead } from "../../../lib/api/notes";

const mockedRange = vi.mocked(timelineRange);
const mockedList = vi.mocked(calendarList);
const mockedEvents = vi.mocked(calendarEvents);
const mockedEventNote = vi.mocked(calendarEventNote);
const mockedNotesRead = vi.mocked(notesRead);

const TODAY = todayLocal();

function todayAt(h: number, mi = 0): string {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
  const off = -dt.getTimezoneOffset();
  const p = (n: number) => n.toString().padStart(2, "0");
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${TODAY}T${p(h)}:${p(mi)}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const work: CalendarSource = {
  id: "work",
  name: "Work",
  kind: "google",
  color: "blue",
  enabled: true,
  urlHost: "calendar.google.com",
  lastSyncedAt: 1,
  lastError: null,
};

function event(partial: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    calendarId: "work",
    title: partial.id,
    start: todayAt(9),
    end: todayAt(10),
    allDay: false,
    cancelled: false,
    location: null,
    description: null,
    noteRelPath: null,
    ...partial,
  };
}

describe("DayTimeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRange.mockReset().mockResolvedValue([]);
    mockedList.mockReset().mockResolvedValue([work]);
    mockedEvents.mockReset().mockResolvedValue([]);
    mockedEventNote.mockReset();
    mockedNotesRead.mockReset();
    useEditorStore.setState({ open: null });
    useUIStore.setState({ dayTimelineShowNotes: true });
    useCalendarStore.setState({ selectedDate: TODAY, calendarsVersion: 0 });
  });

  it("shows the long date, fetches one day, and navigates ‹ › / Today", async () => {
    const user = userEvent.setup();
    render(<DayTimeline />);
    expect(screen.getByTestId("day-timeline-date")).toHaveTextContent(
      formatFullDate(TODAY),
    );
    await waitFor(() =>
      expect(mockedEvents).toHaveBeenCalledWith(TODAY, addDays(TODAY, 1)),
    );
    await user.click(screen.getByRole("button", { name: "Next day" }));
    expect(useCalendarStore.getState().selectedDate).toBe(addDays(TODAY, 1));
    await waitFor(() =>
      expect(mockedEvents).toHaveBeenCalledWith(addDays(TODAY, 1), addDays(TODAY, 2)),
    );
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    await user.click(screen.getByRole("button", { name: "Previous day" }));
    expect(useCalendarStore.getState().selectedDate).toBe(addDays(TODAY, -1));
    await user.click(screen.getByTestId("day-timeline-today"));
    expect(useCalendarStore.getState().selectedDate).toBe(TODAY);
  });

  it("renders 24 hour rows and the now line only on today", () => {
    const { rerender } = render(<DayTimeline />);
    expect(screen.getByTestId("day-timeline-now")).toBeInTheDocument();
    useCalendarStore.setState({ selectedDate: addDays(TODAY, 1) });
    rerender(<DayTimeline />);
    expect(screen.queryByTestId("day-timeline-now")).toBeNull();
  });

  it("places timed events as labelled blocks; overlaps share the width", async () => {
    mockedEvents.mockResolvedValue([
      event({ id: "a", title: "Planning", start: todayAt(9), end: todayAt(11) }),
      event({ id: "b", title: "Sync", start: todayAt(10), end: todayAt(11) }),
      event({ id: "gone", title: "Old", cancelled: true, start: todayAt(14), end: todayAt(15) }),
      event({ id: "hol", title: "Holiday", allDay: true, start: TODAY, end: addDays(TODAY, 1) }),
    ]);
    render(<DayTimeline />);
    const a = await screen.findByTestId("timeline-event-a");
    expect(a.style.top).toBe(`${9 * 56}px`);
    expect(a.style.height).toBe(`${2 * 56 - 1}px`);
    expect(a.style.width).toBe("calc(50% - 2px)");
    expect(screen.getByTestId("timeline-event-b").style.left).toBe("50%");
    expect(
      within(a).getByRole("button", { name: /^Planning, 09:00–11:00$/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("timeline-event-gone").className).toMatch(/cancelled/);
    expect(
      within(screen.getByTestId("day-timeline-allday")).getByText("Holiday"),
    ).toBeInTheDocument();
  });

  it("clicking a block shows its details", async () => {
    mockedEvents.mockResolvedValue([
      event({ id: "a", title: "Planning", location: "Room 4", description: "Bring numbers" }),
    ]);
    const user = userEvent.setup();
    render(<DayTimeline />);
    const block = await screen.findByTestId("timeline-event-a");
    await user.click(within(block).getByRole("button", { name: /Planning/ }));
    const details = screen.getByRole("region", { name: "Event details" });
    expect(details).toHaveTextContent("09:00–10:00");
    expect(details).toHaveTextContent("Room 4");
    expect(details).toHaveTextContent("Bring numbers");
  });

  it("hides events of disabled calendars", async () => {
    mockedList.mockResolvedValue([{ ...work, enabled: false }]);
    mockedEvents.mockResolvedValue([event({ id: "a" })]);
    render(<DayTimeline />);
    await waitFor(() => expect(mockedEvents).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("timeline-event-a")).toBeNull());
  });

  it("Add note creates the meeting note, opens it, and refetches", async () => {
    const ev = event({ id: "e1", title: "Planning" });
    mockedEvents
      .mockResolvedValueOnce([ev])
      .mockResolvedValue([{ ...ev, noteRelPath: "meetings/planning.md" }]);
    const meta: NoteMeta = {
      path: "/v/meetings/planning.md",
      relPath: "meetings/planning.md",
      title: "Planning",
      tags: [],
      mtime: 0,
      size: 0,
      pinned: false,
    };
    mockedEventNote.mockResolvedValue(meta);
    mockedNotesRead.mockResolvedValue({ content: "# Planning", version: "v1" });
    const user = userEvent.setup();
    render(<DayTimeline />);
    const button = await screen.findByTestId("timeline-event-note-e1");
    expect(button).toHaveAccessibleName("Add note");
    await user.click(button);
    await waitFor(() =>
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "note",
        relPath: "meetings/planning.md",
      }),
    );
    expect(mockedEventNote).toHaveBeenCalledWith({
      calendarId: "work",
      eventId: "e1",
      title: "Planning",
      start: ev.start,
      allDay: false,
    });
    await waitFor(() =>
      expect(screen.getByTestId("timeline-event-note-e1")).toHaveAccessibleName(
        "Open note",
      ),
    );
  });

  it("Open note opens the linked note without creating one", async () => {
    mockedEvents.mockResolvedValue([event({ id: "e1", noteRelPath: "meetings/x.md" })]);
    mockedNotesRead.mockResolvedValue({ content: "x", version: "v1" });
    const user = userEvent.setup();
    render(<DayTimeline />);
    const button = await screen.findByTestId("timeline-event-note-e1");
    expect(button).toHaveAccessibleName("Open note");
    await user.click(button);
    await waitFor(() => expect(mockedNotesRead).toHaveBeenCalledWith("meetings/x.md"));
    expect(mockedEventNote).not.toHaveBeenCalled();
  });

  it("shows the day's notes as chips that open the note", async () => {
    mockedRange.mockResolvedValue([
      {
        date: TODAY,
        items: [
          {
            kind: "Note",
            relPath: "notes/standup.md",
            title: "Standup",
            mtime: 0,
            snippet: "",
            pinned: false,
            createdAt: null,
            placedAt: null,
            docKind: "note",
            sourceHost: null,
          },
        ],
      },
    ]);
    mockedNotesRead.mockResolvedValue({ content: "s", version: "v1" });
    const user = userEvent.setup();
    render(<DayTimeline />);
    await user.click(await screen.findByRole("button", { name: "Open note Standup" }));
    await waitFor(() => expect(mockedNotesRead).toHaveBeenCalledWith("notes/standup.md"));
  });

  it("refetches when calendars change", async () => {
    render(<DayTimeline />);
    await waitFor(() => expect(mockedEvents).toHaveBeenCalledTimes(1));
    useCalendarStore.getState().bumpCalendars();
    await waitFor(() => expect(mockedEvents).toHaveBeenCalledTimes(2));
  });
});

function item(
  relPath: string,
  placedAt: string | null,
  extra: Partial<TimelineItem> = {},
): TimelineItem {
  return {
    kind: "Note",
    relPath,
    title: relPath.replace(/^notes\/|\.md$/g, ""),
    mtime: 0,
    snippet: "",
    pinned: false,
    createdAt: placedAt,
    placedAt,
    docKind: "note",
    sourceHost: null,
    ...extra,
  } as TimelineItem;
}

describe("DayTimeline note & clip markers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedList.mockReset().mockResolvedValue([work]);
    mockedEvents.mockReset().mockResolvedValue([event({ id: "e1" })]);
    mockedEventNote.mockReset();
    mockedNotesRead.mockReset().mockResolvedValue({ content: "s", version: "v1" });
    useEditorStore.setState({ open: null });
    useUIStore.setState({ dayTimelineShowNotes: true });
    useCalendarStore.setState({ selectedDate: TODAY, calendarsVersion: 0 });
    mockedRange.mockReset().mockResolvedValue([
      {
        date: TODAY,
        items: [
          item("notes/idea.md", todayAt(9, 30)),
          item("notes/article.md", todayAt(14), {
            docKind: "clip",
            sourceHost: "news.example.com",
          }),
          item("notes/undated.md", null),
        ],
      },
    ]);
  });

  it("draws timed notes and clips as markers and untimed ones as chips", async () => {
    render(<DayTimeline />);
    const note = await screen.findByTestId("timeline-marker-note:notes/idea.md");
    expect(note).toHaveAttribute("data-doc-kind", "note");
    const clip = screen.getByTestId("timeline-marker-note:notes/article.md");
    expect(clip).toHaveAttribute("data-doc-kind", "clip");
    expect(clip).toHaveTextContent("news.example.com");
    // 14:00 on the 56px hour grid.
    expect(clip.style.top).toBe(`${14 * 56}px`);
    expect(screen.queryByTestId("timeline-marker-note:notes/undated.md")).toBeNull();
    const allDay = screen.getByTestId("day-timeline-allday");
    expect(within(allDay).getByTestId("timeline-note-note:notes/undated.md")).toBeInTheDocument();
    expect(within(allDay).queryByTestId("timeline-note-note:notes/idea.md")).toBeNull();
    // The calendar event is still drawn alongside.
    expect(screen.getByTestId("timeline-event-e1")).toBeInTheDocument();
  });

  it("opens the note in the editor when a marker is clicked", async () => {
    const user = userEvent.setup();
    render(<DayTimeline />);
    await user.click(await screen.findByTestId("timeline-marker-note:notes/article.md"));
    await waitFor(() => expect(mockedNotesRead).toHaveBeenCalledWith("notes/article.md"));
    expect(mockedEventNote).not.toHaveBeenCalled();
  });

  it("shows the local-only legend and toggles markers off and on", async () => {
    const user = userEvent.setup();
    render(<DayTimeline />);
    await screen.findByTestId("timeline-marker-note:notes/idea.md");
    expect(screen.getByTestId("day-timeline-legend")).toHaveTextContent(
      "Notes and clips are shown here only — they are not added to your calendars.",
    );
    const toggle = screen.getByRole("button", { name: "Show notes & clips" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.title).toContain(NOTES_LOCAL_ONLY_TEXT);

    await user.click(toggle);
    expect(useUIStore.getState().dayTimelineShowNotes).toBe(false);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("timeline-marker-note:notes/idea.md")).toBeNull();
    expect(screen.queryByTestId("day-timeline-legend")).toBeNull();
    // Off: every note is still reachable as an all-day chip.
    expect(screen.getByTestId("timeline-note-note:notes/idea.md")).toBeInTheDocument();

    await user.click(toggle);
    expect(screen.getByTestId("timeline-marker-note:notes/idea.md")).toBeInTheDocument();
  });

  it("never passes notes or clips to any calendar API", async () => {
    const user = userEvent.setup();
    render(<DayTimeline />);
    await user.click(await screen.findByTestId("timeline-marker-note:notes/idea.md"));
    await user.click(screen.getByTestId("day-timeline-notes-toggle"));
    await user.click(screen.getByTestId("day-timeline-notes-toggle"));
    await waitFor(() => expect(mockedNotesRead).toHaveBeenCalled());
    const calendarCalls = [
      ...mockedList.mock.calls,
      ...mockedEvents.mock.calls,
      ...mockedEventNote.mock.calls,
    ];
    const serialized = JSON.stringify(calendarCalls);
    for (const needle of ["notes/", "news.example.com", "idea", "article", "undated"]) {
      expect(serialized).not.toContain(needle);
    }
    expect(mockedEventNote).not.toHaveBeenCalled();
    for (const call of mockedEvents.mock.calls) {
      expect(call).toEqual([TODAY, addDays(TODAY, 1)]);
    }
  });
});
