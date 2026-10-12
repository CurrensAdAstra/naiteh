import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";

import { addMonths, buildGridCells, monthLabel } from "./dateUtils";
import styles from "./CalendarGrid.module.css";

interface CalendarGridProps {
  /** Any date inside the displayed month (only year/month are read). */
  month: Date;
  /** Today's local-date string (YYYY-MM-DD) for the today marker. */
  today: string;
  /** Optional active selection (YYYY-MM-DD). */
  activeDate: string | null;
  /** Set of YYYY-MM-DD strings that should display the dot indicator. */
  datesWithContent: ReadonlySet<string>;
  onChangeMonth: (next: Date) => void;
  onSelectDate: (date: string) => void;
  /** When given, a "Today" button jumps back to today. */
  onToday?: () => void;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** Compact month picker for the calendar list panel (200–480px wide). */
export function CalendarGrid({
  month,
  today,
  activeDate,
  datesWithContent,
  onChangeMonth,
  onSelectDate,
  onToday,
}: CalendarGridProps) {
  const cells = useMemo(() => buildGridCells(month), [month]);
  const label = monthLabel(month);

  return (
    <div className={styles.grid} data-testid="calendar-grid">
      <div className={styles.header}>
        <div className={styles.label} data-testid="calendar-grid-label">
          {label}
        </div>
        {onToday !== undefined && (
          <button
            type="button"
            className={styles.todayButton}
            onClick={onToday}
            data-testid="calendar-grid-today"
          >
            Today
          </button>
        )}
        <button
          type="button"
          className={styles.navButton}
          aria-label="Previous month"
          onClick={() => onChangeMonth(addMonths(month, -1))}
          data-testid="calendar-grid-prev"
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.navButton}
          aria-label="Next month"
          onClick={() => onChangeMonth(addMonths(month, 1))}
          data-testid="calendar-grid-next"
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.weekdays} aria-hidden="true">
        {WEEKDAYS.map((d) => (
          <span key={d} className={styles.weekday}>
            {d}
          </span>
        ))}
      </div>
      <div className={styles.days} role="grid">
        {cells.map((cell) => {
          const isToday = cell.date === today;
          const isActive = cell.date === activeDate;
          const hasContent = datesWithContent.has(cell.date);
          const cls = [
            styles.cell,
            cell.inMonth ? "" : styles.outOfMonth,
            isToday ? styles.today : "",
            isActive ? styles.active : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              className={cls}
              aria-current={isToday ? "date" : undefined}
              aria-selected={isActive}
              aria-label={cell.date}
              onClick={() => onSelectDate(cell.date)}
              data-testid={`calendar-grid-cell-${cell.date}`}
            >
              <span className={styles.dayNumber}>
                {Number(cell.date.slice(8, 10))}
              </span>
              <span
                className={`${styles.dot} ${hasContent ? "" : styles.dotHidden}`}
                aria-hidden="true"
                data-testid={hasContent ? "calendar-grid-dot" : undefined}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
