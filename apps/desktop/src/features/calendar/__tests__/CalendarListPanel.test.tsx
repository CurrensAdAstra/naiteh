import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CalendarEvent,
  CalendarSource,
  JournalOpenResult,
  TimelineDay,
  TimelineItem,
} from "../../../lib/types";
import { useCalendarStore } from "../../../state/calendarStore";
import { useEditorStore } from "../../../state/editorStore";
import { useSettingsStore } from "../../../state/settingsStore";
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
vi.mock("../../../lib/api/calendar", () => ({
  calendarList: vi.fn(),
  calendarEvents: vi.fn(),
  calendarRefresh: vi.fn(),
  calendarAdd: vi.fn(),
  calendarUpdate: vi.fn(),
  calendarRemove: vi.fn(),
  calendarEventNote: vi.fn(),
}));

import {
  calendarAdd,
  calendarEvents,
  calendarList,
  calendarRefresh,
  calendarRemove,
  calendarUpdate,
} from "../../../lib/api/calendar";
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
const mockedList = vi.mocked(calendarList);
const mockedEvents = vi.mocked(calendarEvents);
const mockedRefresh = vi.mocked(calendarRefresh);
const mockedAdd = vi.mocked(calendarAdd);
const mockedUpdate = vi.mocked(calendarUpdate);
const mockedRemove = vi.mocked(calendarRemove);

const TODAY = todayLocal();
const YESTERDAY = todayLocal(new Date(Date.now() - 86_400_000));

/** Local wall-clock RFC3339 timestamp for today at `h:mi`. */
function todayAt(h: number, mi = 0): string {
  const now = new Date();
  const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
  const off = -dt.getTimezoneOffset();
  const p = (n: number) => n.toString().padStart(2, "0");
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${TODAY}T${p(h)}:${p(mi)}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const journalItem: TimelineItem = {
  kind: "JournalEntry",
  date: TODAY,
  path: `/v/journal/${TODAY.slice(0, 4)}/${TODAY.slice(5, 7)}/${TODAY}.md`,
  mtime: 0,
  title: "Today entry",
  snippet: "the body",
  createdAt: null,
  placedAt: null,
  docKind: "journal",
  sourceHost: null,
};

const noteItem: TimelineItem = {
  kind: "Note",
  relPath: "notes/work/standup.md",
  title: "Standup",
  mtime: 0,
  snippet: "agenda",
  pinned: true,
  createdAt: null,
  placedAt: null,
  docKind: "note",
  sourceHost: null,
};

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

function dayWith(date: string, items: TimelineItem[]): TimelineDay {
  return { date, items };
}

async function showAgenda(user = userEvent.setup()) {
  await user.click(await screen.findByTestId("calendar-tab-agenda"));
  return user;
}

describe("CalendarListPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRange.mockReset();
    mockedPinned.mockReset();
    mockedJournalOpen.mockReset();
    mockedNotesRead.mockReset();
    mockedList.mockReset().mockResolvedValue([]);
    mockedEvents.mockReset().mockResolvedValue([]);
    mockedRefresh.mockReset().mockResolvedValue(undefined);
    mockedAdd.mockReset();
    mockedUpdate.mockReset();
    mockedRemove.mockReset();
    useEditorStore.setState({ open: null });
    useSettingsStore.setState({ config: null });
    useCalendarStore.setState({ selectedDate: TODAY, calendarsVersion: 0 });
  });

  // ---- Agenda tab (pre-existing timeline behaviour) ----

  it("Agenda: renders pinned section, today separator, and items", async () => {
    mockedRange.mockResolvedValue([dayWith(TODAY, [journalItem])]);
    mockedPinned.mockResolvedValue([noteItem]);
    render(<CalendarListPanel />);
    await showAgenda();
    expect(await screen.findByTestId("calendar-pinned")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("calendar-pinned")).getByText("Standup"),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`calendar-day-${TODAY}`)).toBeInTheDocument();
    expect(screen.getByText("Today entry")).toBeInTheDocument();
  });

  it('Agenda: renders "— start a journal entry" for empty days', async () => {
    mockedRange.mockResolvedValue([dayWith(YESTERDAY, [])]);
    mockedPinned.mockResolvedValue([]);
    render(<CalendarListPanel />);
    await showAgenda();
    expect(
      await screen.findByTestId(`calendar-empty-${YESTERDAY}`),
    ).toHaveTextContent("— start a journal entry");
  });

  it("Agenda: clicking an empty day opens the journal entry", async () => {
    mockedRange.mockResolvedValue([dayWith(YESTERDAY, [])]);
    mockedPinned.mockResolvedValue([]);
    const result: JournalOpenResult = {
      path: "ignored",
      content: "",
      exists: false,
      version: "v1",
    };
    mockedJournalOpen.mockResolvedValue(result);

    render(<CalendarListPanel />);
    const user = await showAgenda();
    await user.click(await screen.findByTestId(`calendar-empty-${YESTERDAY}`));
    await waitFor(() => {
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "journal",
        date: YESTERDAY,
        relPath: `journal/${YESTERDAY.slice(0, 4)}/${YESTERDAY.slice(5, 7)}/${YESTERDAY}.md`,
      });
    });
  });

  it("Agenda: clicking a journal item opens it via journalOpen", async () => {
    mockedRange.mockResolvedValue([dayWith(TODAY, [journalItem])]);
    mockedPinned.mockResolvedValue([]);
    mockedJournalOpen.mockResolvedValue({
      path: "ignored",
      content: "today body",
      exists: true,
      version: "v1",
    });
    render(<CalendarListPanel />);
    const user = await showAgenda();
    await user.click(await screen.findByTestId(`calendar-item-journal:${TODAY}`));
    await waitFor(() => {
      expect(mockedJournalOpen).toHaveBeenCalledWith(TODAY);
      expect(useEditorStore.getState().open?.content).toBe("today body");
    });
    expect(mockedNotesRead).not.toHaveBeenCalled();
  });

  it("surfaces backend errors from timelineRange", async () => {
    mockedRange.mockRejectedValue({ kind: "NotFound", message: "no vault" });
    mockedPinned.mockResolvedValue([]);
    render(<CalendarListPanel />);
    expect(
      await within(screen.getByTestId("calendar-body")).findByText(/no vault/i),
    ).toBeInTheDocument();
  });

  it("opens on the Agenda tab when calendar.subView is agenda", async () => {
    mockedRange.mockResolvedValue([dayWith(TODAY, [journalItem])]);
    mockedPinned.mockResolvedValue([]);
    useSettingsStore.setState({
      config: { calendar: { subView: "agenda" } } as never,
    });
    render(<CalendarListPanel />);
    expect(await screen.findByTestId(`calendar-day-${TODAY}`)).toBeInTheDocument();
    expect(screen.getByTestId("calendar-tab-agenda")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  // ---- Month grid -> day timeline ----

  it("has no Day tab: the day's events live in the timeline pane", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    render(<CalendarListPanel />);
    expect(await screen.findByTestId("calendar-tab-agenda")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByTestId("calendar-tab-day")).toBeNull();
    expect(screen.queryByTestId("calendar-dayview")).toBeNull();
  });

  it("clicking a day selects it for the timeline; Today jumps back", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<CalendarListPanel />);
    await user.click(await screen.findByTestId("calendar-grid-next"));
    const cells = screen.getAllByRole("gridcell");
    await user.click(cells[20]!);
    expect(cells[20]).toHaveAttribute("aria-selected", "true");
    const picked = useCalendarStore.getState().selectedDate;
    expect(picked).not.toBe(TODAY);
    expect(screen.getByTestId(`calendar-grid-cell-${picked}`)).toBe(cells[20]);
    await user.click(screen.getByTestId("calendar-grid-today"));
    expect(useCalendarStore.getState().selectedDate).toBe(TODAY);
  });

  it("follows a date picked elsewhere (timeline ‹ ›) to its month", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    render(<CalendarListPanel />);
    await screen.findByTestId("calendar-tab-agenda");
    act(() => useCalendarStore.getState().setSelectedDate("2031-03-15"));
    expect(await screen.findByTestId("calendar-grid-cell-2031-03-15")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("puts event dots on the month grid (fetch window = 42 days)", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    mockedEvents.mockResolvedValue([event({ id: "e1" })]);
    render(<CalendarListPanel />);
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`calendar-grid-cell-${TODAY}`)).getByTestId(
          "calendar-grid-dot",
        ),
      ).toBeInTheDocument(),
    );
    const [start, end] = mockedEvents.mock.calls[0]!;
    const span = (Date.parse(end) - Date.parse(start)) / 86_400_000;
    expect(Math.round(span)).toBe(42);
  });

  // ---- My calendars ----

  it("toggling a calendar calls calendar_update and tells the timeline", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    mockedList
      .mockResolvedValueOnce([work])
      .mockResolvedValue([{ ...work, enabled: false }]);
    mockedEvents.mockResolvedValue([event({ id: "e1" })]);
    mockedUpdate.mockResolvedValue({ ...work, enabled: false });
    const before = useCalendarStore.getState().calendarsVersion;
    const user = userEvent.setup();
    render(<CalendarListPanel />);
    await user.click(await screen.findByTestId("calendar-source-enabled-work"));
    expect(mockedUpdate).toHaveBeenCalledWith({ id: "work", enabled: false });
    await waitFor(() =>
      expect(useCalendarStore.getState().calendarsVersion).toBeGreaterThan(before),
    );
  });

  it("shows a sync-error warning with the error as its title", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    mockedList.mockResolvedValue([{ ...work, lastError: "HTTP 404" }]);
    render(<CalendarListPanel />);
    expect(await screen.findByTestId("calendar-source-error-work")).toHaveAttribute(
      "title",
      "HTTP 404",
    );
  });

  it("Remove asks for confirmation before calling calendar_remove", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    mockedList.mockResolvedValue([work]);
    mockedRemove.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CalendarListPanel />);
    await user.click(await screen.findByTestId("calendar-source-menu-work"));
    await user.click(screen.getByTestId("calendar-source-remove-work"));
    expect(mockedRemove).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("calendar-source-remove-confirm-work"));
    expect(mockedRemove).toHaveBeenCalledWith("work");
  });

  it("Refresh calls calendar_refresh and re-lists", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<CalendarListPanel />);
    await screen.findByTestId("calendar-refresh");
    await waitFor(() => expect(mockedList).toHaveBeenCalled());
    const before = mockedList.mock.calls.length;
    await user.click(screen.getByTestId("calendar-refresh"));
    await waitFor(() => expect(mockedRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockedList.mock.calls.length).toBeGreaterThan(before));
  });

  it("Add calendar validates input and shows backend errors", async () => {
    mockedRange.mockResolvedValue([]);
    mockedPinned.mockResolvedValue([]);
    mockedAdd.mockRejectedValue({ kind: "Network", message: "HTTP 403" });
    const user = userEvent.setup();
    render(<CalendarListPanel />);
    await user.click(await screen.findByTestId("calendar-add-open"));
    await user.click(screen.getByTestId("calendar-add-submit"));
    expect(screen.getByTestId("calendar-add-error")).toHaveTextContent(/name/i);
    await user.type(screen.getByTestId("calendar-add-name"), "Family");
    await user.type(screen.getByTestId("calendar-add-url"), "not a url");
    await user.click(screen.getByTestId("calendar-add-submit"));
    expect(screen.getByTestId("calendar-add-error")).toHaveTextContent(/webcal/i);
    expect(mockedAdd).not.toHaveBeenCalled();

    await user.clear(screen.getByTestId("calendar-add-url"));
    await user.type(
      screen.getByTestId("calendar-add-url"),
      "webcal://p01-caldav.icloud.com/published/2/abc",
    );
    await user.click(screen.getByTestId("calendar-swatch-green"));
    await user.click(screen.getByTestId("calendar-add-submit"));
    expect(mockedAdd).toHaveBeenCalledWith({
      name: "Family",
      url: "webcal://p01-caldav.icloud.com/published/2/abc",
      kind: "apple",
      color: "green",
    });
    expect(await screen.findByTestId("calendar-add-error")).toHaveTextContent("HTTP 403");
    expect(screen.getByTestId("calendar-add-dialog")).toBeInTheDocument();
  });
});
