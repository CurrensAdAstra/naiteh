import { Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  journalOpen,
  timelinePinned,
  timelineRange,
} from "../../lib/api/journal";
import { notesRead } from "../../lib/api/notes";
import { formatAppError } from "../../lib/types";
import type { TimelineDay, TimelineItem } from "../../lib/types";
import { useEditorStore } from "../../state/editorStore";
import {
  formatDayHeader,
  journalRelPathFor,
  rangeAround,
  todayLocal,
} from "./dateUtils";
import styles from "./CalendarListPanel.module.css";

const DAYS_BEFORE_TODAY = 60;

export function CalendarListPanel() {
  const [days, setDays] = useState<TimelineDay[]>([]);
  const [pinned, setPinned] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const today = todayLocal();
  const openKey = useEditorStore((s) => s.open?.key ?? null);
  const openNoteAction = useEditorStore((s) => s.openNote);
  const openJournalAction = useEditorStore((s) => s.openJournal);

  const refresh = useCallback(async () => {
    try {
      const { from, to } = rangeAround(today, DAYS_BEFORE_TODAY, 0);
      const [range, pins] = await Promise.all([
        timelineRange(from, to),
        timelinePinned(),
      ]);
      setDays(range);
      setPinned(pins);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [today]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpenItem = useCallback(
    async (item: TimelineItem) => {
      try {
        if (item.kind === "JournalEntry") {
          const result = await journalOpen(item.date);
          openJournalAction(item.date, journalRelPathFor(item.date), result.content);
        } else {
          const content = await notesRead(item.relPath);
          openNoteAction(item.relPath, content);
        }
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [openJournalAction, openNoteAction],
  );

  const handleOpenEmptyDay = useCallback(
    async (date: string) => {
      try {
        const result = await journalOpen(date);
        openJournalAction(date, journalRelPathFor(date), result.content);
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [openJournalAction],
  );

  return (
    <div className={styles.panel} data-testid="list-panel-calendar">
      <header className={styles.header}>
        <h2 className={styles.title}>Calendar</h2>
      </header>
      <div className={styles.body} data-testid="calendar-body">
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
        {error === null && days.map((day) => (
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
