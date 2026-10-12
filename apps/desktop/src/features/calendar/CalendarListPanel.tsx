import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  calendarEvents,
  calendarList,
  calendarRefresh,
} from "../../lib/api/calendar";
import { timelinePinned, timelineRange } from "../../lib/api/journal";
import { openDocument, type OpenTarget } from "../../lib/openDocument";
import { formatAppError } from "../../lib/types";
import type {
  CalendarEvent,
  CalendarSource,
  TimelineDay,
  TimelineItem,
} from "../../lib/types";
import { useCalendarStore } from "../../state/calendarStore";
import { useEditorStore } from "../../state/editorStore";
import { useVaultContentStore } from "../../state/vaultContentStore";
import { AgendaView } from "./AgendaView";
import { CalendarGrid } from "./CalendarGrid";
import { CalendarSources } from "./CalendarSources";
import {
  buildGridCells,
  endOfMonth,
  formatLocalDate,
  parseLocalDate,
  startOfMonth,
  todayLocal,
} from "./dateUtils";
import { addDays, datesWithEvents } from "./eventUtils";
import styles from "./CalendarListPanel.module.css";

export function CalendarListPanel() {
  const today = todayLocal();
  const [gridMonth, setGridMonth] = useState<Date>(() => new Date());
  // The selected day drives the day timeline pane next to the editor.
  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const bumpCalendars = useCalendarStore((s) => s.bumpCalendars);

  const [days, setDays] = useState<TimelineDay[]>([]);
  const [pinned, setPinned] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<CalendarSource[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openKey = useEditorStore((s) => s.open?.key ?? null);

  // Visible grid: 42 days starting on the Sunday on/before the 1st.
  const grid = useMemo(() => {
    const cells = buildGridCells(gridMonth);
    const first = cells[0]?.date ?? formatLocalDate(startOfMonth(gridMonth));
    const last = cells[cells.length - 1]?.date ?? first;
    return { from: first, toExclusive: addDays(last, 1), last };
  }, [gridMonth]);

  // Agenda range (unchanged): the displayed month, extended through today.
  const agendaRange = useMemo(() => {
    const todayDate = new Date();
    const monthStart = startOfMonth(gridMonth);
    const monthEnd = endOfMonth(gridMonth);
    const from = monthStart < todayDate ? monthStart : todayDate;
    const to = monthEnd > todayDate ? monthEnd : todayDate;
    return { from: formatLocalDate(from), to: formatLocalDate(to) };
  }, [gridMonth]);

  // One timeline fetch covers both the Agenda range and the whole grid
  // (dots on adjacent-month days).
  const fetchRange = useMemo(
    () => ({
      from: agendaRange.from < grid.from ? agendaRange.from : grid.from,
      to: agendaRange.to > grid.last ? agendaRange.to : grid.last,
    }),
    [agendaRange, grid],
  );

  const refreshTimeline = useCallback(async () => {
    try {
      const [rangeData, pins] = await Promise.all([
        timelineRange(fetchRange.from, fetchRange.to),
        timelinePinned(),
      ]);
      setDays(rangeData);
      setPinned(pins);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [fetchRange.from, fetchRange.to]);

  const loadCalendars = useCallback(async () => {
    try {
      setCalendars(await calendarList());
    } catch (e) {
      setEventsError(formatAppError(e));
    }
  }, []);

  const loadEvents = useCallback(async () => {
    try {
      setEvents(await calendarEvents(grid.from, grid.toExclusive));
      setEventsError(null);
    } catch (e) {
      setEventsError(formatAppError(e));
    }
  }, [grid.from, grid.toExclusive]);

  // Refetch on mount, month change, and whenever vault files change
  // elsewhere (sync, note create/rename/delete).
  const contentVersion = useVaultContentStore((s) => s.version);
  useEffect(() => {
    void refreshTimeline();
  }, [refreshTimeline, contentVersion]);
  useEffect(() => {
    void loadCalendars();
  }, [loadCalendars]);
  useEffect(() => {
    void loadEvents();
  }, [loadEvents, contentVersion]);

  // Hide events of calendars the user unchecked (the backend may already).
  const visibleEvents = useMemo(() => {
    const disabled = new Set(
      calendars.filter((c) => !c.enabled).map((c) => c.id),
    );
    return events.filter((ev) => !disabled.has(ev.calendarId));
  }, [events, calendars]);

  const datesWithContent = useMemo(() => {
    const set = datesWithEvents(visibleEvents, grid.from, grid.toExclusive);
    for (const day of days) {
      if (day.items.length > 0) set.add(day.date);
    }
    return set;
  }, [days, visibleEvents, grid]);

  const agendaDays = useMemo(
    () =>
      days.filter(
        (d) => d.date >= agendaRange.from && d.date <= agendaRange.to,
      ),
    [days, agendaRange],
  );

  const open = useCallback(async (target: OpenTarget) => {
    try {
      await openDocument(target);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  const handleOpenItem = useCallback(
    (item: TimelineItem) =>
      void open(
        item.kind === "JournalEntry"
          ? { kind: "journal", date: item.date }
          : { kind: "note", relPath: item.relPath },
      ),
    [open],
  );

  const handleOpenJournal = useCallback(
    (date: string) => void open({ kind: "journal", date }),
    [open],
  );

  // Keep the month grid on the selected day's month, whoever picked it
  // (the grid itself, or the timeline's ‹ › / Today buttons).
  useEffect(() => {
    const d = parseLocalDate(selectedDate);
    if (d === null) return;
    setGridMonth((cur) =>
      d.getMonth() === cur.getMonth() && d.getFullYear() === cur.getFullYear()
        ? cur
        : startOfMonth(d),
    );
  }, [selectedDate]);

  const handleSelectDate = useCallback(
    (date: string) => {
      setSelectedDate(date);
      // The Agenda scrolls the day into view.
      bodyRef.current
        ?.querySelector<HTMLElement>(`[data-testid="calendar-day-${date}"]`)
        ?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    },
    [setSelectedDate],
  );

  const handleToday = useCallback(() => {
    setGridMonth(new Date());
    setSelectedDate(todayLocal());
  }, [setSelectedDate]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await calendarRefresh();
      setEventsError(null);
    } catch (e) {
      setEventsError(formatAppError(e));
    } finally {
      setRefreshing(false);
    }
    await Promise.all([loadCalendars(), loadEvents()]);
    bumpCalendars();
  }, [loadCalendars, loadEvents, bumpCalendars]);

  const handleSourcesChanged = useCallback(() => {
    void Promise.all([loadCalendars(), loadEvents()]);
    bumpCalendars();
  }, [loadCalendars, loadEvents, bumpCalendars]);

  return (
    <div className={styles.panel} data-testid="list-panel-calendar">
      <header className={styles.header}>
        <h2 className={styles.title}>Calendar</h2>
      </header>
      <CalendarGrid
        month={gridMonth}
        today={today}
        activeDate={selectedDate}
        datesWithContent={datesWithContent}
        onChangeMonth={(next) => setGridMonth(next)}
        onSelectDate={handleSelectDate}
        onToday={handleToday}
      />
      {/* The selected day's events and notes live in the day timeline
          pane next to the editor; the list keeps the note Agenda. */}
      <div className={styles.tabs} role="tablist" aria-label="Calendar view">
        <button
          type="button"
          role="tab"
          aria-selected={true}
          className={`${styles.tab} ${styles.tabActive}`}
          data-testid="calendar-tab-agenda"
        >
          Agenda
        </button>
      </div>
      <div
        className={styles.body}
        data-testid="calendar-body"
        role="tabpanel"
        ref={bodyRef}
      >
        {error !== null && <p className={styles.error}>{error}</p>}
        {eventsError !== null && (
          <p className={styles.error} data-testid="calendar-events-error">
            {eventsError}
          </p>
        )}
        {error === null && (
          <AgendaView
            days={agendaDays}
            pinned={pinned}
            today={today}
            activeKey={openKey}
            onOpenItem={handleOpenItem}
            onOpenEmptyDay={handleOpenJournal}
          />
        )}
      </div>
      <CalendarSources
        calendars={calendars}
        refreshing={refreshing}
        onChanged={handleSourcesChanged}
        onRefresh={() => void handleRefresh()}
      />
    </div>
  );
}
