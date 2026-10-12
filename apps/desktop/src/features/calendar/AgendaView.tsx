import { Pin, Star } from "lucide-react";

import type { TimelineDay, TimelineItem } from "../../lib/types";
import { formatDayHeader } from "./dateUtils";
import { timelineItemKey } from "./eventUtils";
import styles from "./CalendarListPanel.module.css";

/**
 * The "Agenda" tab: pinned notes, then every day of the timeline range
 * (journal entries + notes), newest data from `timeline_range`.
 */
interface AgendaViewProps {
  days: TimelineDay[];
  pinned: TimelineItem[];
  today: string;
  activeKey: string | null;
  onOpenItem: (item: TimelineItem) => void;
  onOpenEmptyDay: (date: string) => void;
}

export function AgendaView({
  days,
  pinned,
  today,
  activeKey,
  onOpenItem,
  onOpenEmptyDay,
}: AgendaViewProps) {
  return (
    <>
      {pinned.length > 0 && (
        <section
          className={styles.pinnedSection}
          aria-label="On the Agenda"
          data-testid="calendar-pinned"
        >
          <div className={styles.pinnedHeader}>
            <Star size={14} aria-hidden="true" />
            On the Agenda
          </div>
          <ul className={styles.plainList}>
            {pinned.map((item) => (
              <TimelineItemRow
                key={timelineItemKey(item)}
                item={item}
                active={activeKey === timelineItemKey(item)}
                onOpen={() => onOpenItem(item)}
              />
            ))}
          </ul>
        </section>
      )}
      {days.map((day) => (
        <DaySection
          key={day.date}
          day={day}
          today={today}
          activeKey={activeKey}
          onOpenItem={onOpenItem}
          onOpenEmptyDay={onOpenEmptyDay}
        />
      ))}
    </>
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
  return (
    <section aria-label={headerLabel} data-testid={`calendar-day-${day.date}`}>
      <div
        className={`${styles.dayHeader} ${isToday ? styles.dayHeaderToday : ""}`}
      >
        {headerLabel}
      </div>
      {day.items.length === 0 ? (
        <button
          type="button"
          className={styles.placeholderRow}
          onClick={() => onOpenEmptyDay(day.date)}
          data-testid={`calendar-empty-${day.date}`}
        >
          — start a journal entry
        </button>
      ) : (
        <ul className={styles.plainList}>
          {day.items.map((item) => (
            <TimelineItemRow
              key={timelineItemKey(item)}
              item={item}
              active={activeKey === timelineItemKey(item)}
              onOpen={() => onOpenItem(item)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface TimelineItemRowProps {
  item: TimelineItem;
  active: boolean;
  onOpen: () => void;
}

/** One journal entry / note row (shared by the Agenda and Day tabs). */
export function TimelineItemRow({ item, active, onOpen }: TimelineItemRowProps) {
  const isJournal = item.kind === "JournalEntry";
  return (
    <li className={styles.listItem}>
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
            <Pin
              size={11}
              className={styles.pinned}
              aria-label="pinned"
            />
          )}
        </span>
        {item.snippet !== "" && (
          <span className={styles.itemSnippet}>{item.snippet}</span>
        )}
      </button>
    </li>
  );
}
