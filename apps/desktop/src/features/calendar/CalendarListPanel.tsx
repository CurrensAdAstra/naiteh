import { Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  journalOpen,
  timelinePinned,
  timelineRange,
} from "../../lib/api/journal";
import { notesRead } from "../../lib/api/notes";
import { formatAppError } from "../../lib/types";
import type { TimelineDay, TimelineItem } from "../../lib/types";
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import { CalendarGrid } from "./CalendarGrid";
import {
  endOfMonth,
  formatDayHeader,
  formatLocalDate,
  journalRelPathFor,
  startOfMonth,
  todayLocal,
} from "./dateUtils";
import styles from "./CalendarListPanel.module.css";

export function CalendarListPanel() {
  const today = todayLocal();
  const [gridMonth, setGridMonth] = useState<Date>(() => new Date());
  const [days, setDays] = useState<TimelineDay[]>([]);
  const [pinned, setPinned] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openKey = useEditorStore((s) => s.open?.key ?? null);
  const openNoteAction = useEditorStore((s) => s.openNote);
  const openJournalAction = useEditorStore((s) => s.openJournal);
  const logAction = useAuthStore((s) => s.logAction);

  // Resolve the timeline range from the displayed grid month: always covers
  // the visible grid AND extends through today so the timeline below always
  // includes recent days even when the user navigates back.
  const range = useMemo(() => {
    const todayDate = new Date();
    const monthStart = startOfMonth(gridMonth);
    const monthEnd = endOfMonth(gridMonth);
    const from = monthStart < todayDate ? monthStart : todayDate;
    const to = monthEnd > todayDate ? monthEnd : todayDate;
    return { from: formatLocalDate(from), to: formatLocalDate(to) };
  }, [gridMonth]);

  const refresh = useCallback(async () => {
    try {
      const [rangeData, pins] = await Promise.all([
        timelineRange(range.from, range.to),
        timelinePinned(),
      ]);
      setDays(rangeData);
      setPinned(pins);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [range.from, range.to]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const datesWithContent = useMemo(() => {
    const set = new Set<string>();
    for (const day of days) {
      if (day.items.length > 0) set.add(day.date);
    }
    return set;
  }, [days]);

  const handleOpenItem = useCallback(
    async (item: TimelineItem) => {
      try {
        if (item.kind === "JournalEntry") {
          const result = await journalOpen(item.date);
          openJournalAction(
            item.date,
            journalRelPathFor(item.date),
            result.content,
          );
          void logAction("journal_open", item.date).catch(() => {});
        } else {
          const content = await notesRead(item.relPath);
          openNoteAction(item.relPath, content);
          void logAction("note_open", item.relPath).catch(() => {});
        }
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [logAction, openJournalAction, openNoteAction],
  );

  const handleOpenEmptyDay = useCallback(
    async (date: string) => {
      try {
        const result = await journalOpen(date);
        openJournalAction(date, journalRelPathFor(date), result.content);
        void logAction("journal_open", date).catch(() => {});
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [logAction, openJournalAction],
  );

  const handleSelectDate = useCallback((date: string) => {
    setSelectedDate(date);
    const node = bodyRef.current?.querySelector<HTMLElement>(
      `[data-testid="calendar-day-${date}"]`,
    );
    if (node !== null && node !== undefined) {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

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
        onSelectDate={(date) => void handleSelectDate(date)}
      />
      <div
        className={styles.body}
        data-testid="calendar-body"
        ref={bodyRef}
      >
        {error !== null && <p className={styles.error}>{error}</p>}
        {error === null && pinned.length > 0 && (
          <section
            className={styles.pinnedSection}
            aria-label="On the Agenda"
            data-testid="calendar-pinned"
          >
            <div className={styles.pinnedHeader}>
              <Star size={14} aria-hidden="true" />
              On the Agenda
            </div>
            <ul className={styles.pinnedList}>
              {pinned.map((item) => (
                <ItemRow
                  key={timelineItemKey(item)}
                  item={item}
                  active={openKey === itemEditorKey(item)}
                  onOpen={() => void handleOpenItem(item)}
                />
              ))}
            </ul>
          </section>
        )}
        {error === null &&
          days.map((day) => (
            <DaySection
              key={day.date}
              day={day}
              today={today}
              activeKey={openKey}
              onOpenItem={(item) => void handleOpenItem(item)}
              onOpenEmptyDay={(d) => void handleOpenEmptyDay(d)}
            />
          ))}
      </div>
    </div>
  );
}

interface DaySectionProps {
  day: TimelineDay;
  today: string;
  activeKey: string | null;
  onOpenItem: (item: TimelineItem) => void;
  onOpenEmptyDay: (date: string) => void;
}

function DaySection({
  day,
  today,
  activeKey,
  onOpenItem,
  onOpenEmptyDay,
}: DaySectionProps) {
  const headerLabel = formatDayHeader(day.date, today);
  const isToday = day.date === today;
  const isEmpty = day.items.length === 0;
  return (
    <section
      aria-label={headerLabel}
      data-testid={`calendar-day-${day.date}`}
    >
      <div
        className={`${styles.dayHeader} ${isToday ? styles.dayHeaderToday : ""}`}
      >
        {headerLabel}
      </div>
      {isEmpty ? (
        <button
          type="button"
          className={styles.placeholderRow}
          onClick={() => onOpenEmptyDay(day.date)}
          data-testid={`calendar-empty-${day.date}`}
        >
          — start a journal entry
        </button>
      ) : (
        <ul className={styles.dayItems}>
          {day.items.map((item) => (
            <ItemRow
              key={timelineItemKey(item)}
              item={item}
              active={activeKey === itemEditorKey(item)}
              onOpen={() => onOpenItem(item)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface ItemRowProps {
  item: TimelineItem;
  active: boolean;
  onOpen: () => void;
}

function ItemRow({ item, active, onOpen }: ItemRowProps) {
  const isJournal = item.kind === "JournalEntry";
  return (
    <li>
      <button
        type="button"
        className={`${styles.item} ${active ? styles.itemActive : ""}`}
        onClick={onOpen}
        data-testid={`calendar-item-${timelineItemKey(item)}`}
      >
        <span className={styles.itemHeader}>
          <span
            className={styles.kindBadge}
            title={isJournal ? "Journal" : "Note"}
          >
            {isJournal ? "J" : "N"}
          </span>
          <span className={styles.itemTitle}>{item.title}</span>
          {item.kind === "Note" && item.pinned && (
            <span className={styles.pinned} aria-label="pinned" title="pinned">
              ★
            </span>
          )}
        </span>
        {item.snippet !== "" && (
          <span className={styles.itemSnippet}>{item.snippet}</span>
        )}
      </button>
    </li>
  );
}

function timelineItemKey(item: TimelineItem): string {
  return item.kind === "JournalEntry"
    ? `journal:${item.date}`
    : `note:${item.relPath}`;
}

function itemEditorKey(item: TimelineItem): string {
  return item.kind === "JournalEntry"
    ? `journal:${item.date}`
    : `note:${item.relPath}`;
}
