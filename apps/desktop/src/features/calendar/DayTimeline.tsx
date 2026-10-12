import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FilePlus,
  FileText,
  Link2,
  MapPin,
  PanelLeftClose,
  Pencil,
  StickyNote,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  calendarEventNote,
  calendarEvents,
  calendarList,
} from "../../lib/api/calendar";
import { timelineRange } from "../../lib/api/journal";
import { openDocument, type OpenTarget } from "../../lib/openDocument";
import {
  formatAppError,
  type CalendarEvent,
  type CalendarSource,
  type TimelineItem,
} from "../../lib/types";
import { useCalendarStore } from "../../state/calendarStore";
import { useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { useVaultContentStore } from "../../state/vaultContentStore";
import { todayLocal } from "./dateUtils";
import {
  addDays,
  calendarColorVar,
  eventsForDay,
  formatFullDate,
  formatTimeRange,
  timelineItemKey,
} from "./eventUtils";
import {
  HOUR_HEIGHT,
  hourLabel,
  initialScrollMinute,
  layoutDay,
  minuteToPx,
  minutesIntoDay,
  splitDayNotes,
} from "./timelineLayout";
import styles from "./DayTimeline.module.css";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const eventKey = (ev: CalendarEvent) => `${ev.calendarId}/${ev.id}`;
const titleOf = (ev: CalendarEvent) => (ev.title === "" ? "(No title)" : ev.title);

/** Shown in the header toggle's tooltip and the legend under it. */
export const NOTES_LOCAL_ONLY_TEXT =
  "Notes and clips are shown here only — they are not added to your calendars.";

const KIND_LABEL = { note: "Note", clip: "Clip", journal: "Journal entry" } as const;

function DocKindIcon({ item, size }: { item: TimelineItem; size: number }) {
  if (item.docKind === "clip") return <Link2 size={size} aria-hidden="true" />;
  if (item.docKind === "journal") return <BookOpen size={size} aria-hidden="true" />;
  return <Pencil size={size} aria-hidden="true" />;
}

const openTargetOf = (item: TimelineItem): OpenTarget =>
  item.kind === "JournalEntry"
    ? { kind: "journal", date: item.date }
    : { kind: "note", relPath: item.relPath };

function formatClock(iso: string | null): string {
  if (iso === null) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

interface DayTimelineProps {
  /** Hide the pane (Calendar mode then shows a toggle instead). */
  onHide?: () => void;
}

/**
 * Calendar mode's middle pane: one day as an hour grid (00:00–24:00)
 * with the subscribed calendars' events, the day's notes in the all-day
 * strip, and a current-time line on today.
 */
export function DayTimeline({ onHide }: DayTimelineProps) {
  const date = useCalendarStore((s) => s.selectedDate);
  const setDate = useCalendarStore((s) => s.setSelectedDate);
  const calendarsVersion = useCalendarStore((s) => s.calendarsVersion);
  const contentVersion = useVaultContentStore((s) => s.version);
  const openKey = useEditorStore((s) => s.open?.key ?? null);
  const showNotes = useUIStore((s) => s.dayTimelineShowNotes);
  const setShowNotes = useUIStore((s) => s.setDayTimelineShowNotes);

  const [calendars, setCalendars] = useState<CalendarSource[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [notes, setNotes] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const scrollRef = useRef<HTMLDivElement>(null);

  const isToday = date === todayLocal(now);

  const loadEvents = useCallback(async () => {
    try {
      const [cals, evs] = await Promise.all([
        calendarList(),
        calendarEvents(date, addDays(date, 1)),
      ]);
      setCalendars(cals);
      setEvents(evs);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [date]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents, calendarsVersion, contentVersion]);

  useEffect(() => {
    let cancelled = false;
    timelineRange(date, date)
      .then((days) => {
        if (!cancelled) setNotes(days.find((d) => d.date === date)?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [date, contentVersion]);

  useEffect(() => setDetailsKey(null), [date]);

  // The current-time line moves once a minute while today is shown.
  useEffect(() => {
    if (!isToday) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [isToday]);

  // Scroll to an hour before now (today) or 8 AM whenever the day changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    el.scrollTop = minuteToPx(initialScrollMinute(isToday, new Date()));
    // Only on day change, not on every minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const colorById = useMemo(
    () => new Map(calendars.map((c) => [c.id, c.color] as const)),
    [calendars],
  );
  const visible = useMemo(() => {
    const disabled = new Set(calendars.filter((c) => !c.enabled).map((c) => c.id));
    return events.filter((ev) => !disabled.has(ev.calendarId));
  }, [events, calendars]);
  const { allDay } = useMemo(() => eventsForDay(visible, date), [visible, date]);
  // Notes / clips are local display data: they only feed the layout
  // below and never reach any calendar_* API.
  const untimedNotes = useMemo(
    () => splitDayNotes(notes, date).untimed,
    [notes, date],
  );
  const blocks = useMemo(
    () => layoutDay(visible, showNotes ? notes : [], date),
    [visible, notes, showNotes, date],
  );
  const details = useMemo(
    () => visible.find((ev) => eventKey(ev) === detailsKey) ?? null,
    [visible, detailsKey],
  );

  const open = useCallback(async (target: OpenTarget) => {
    try {
      await openDocument(target);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  const handleEventNote = useCallback(
    async (ev: CalendarEvent) => {
      setBusyKey(eventKey(ev));
      try {
        let relPath = ev.noteRelPath;
        if (relPath === null) {
          const meta = await calendarEventNote({
            calendarId: ev.calendarId,
            eventId: ev.id,
            title: ev.title,
            start: ev.start,
            allDay: ev.allDay,
          });
          relPath = meta.relPath;
        }
        await openDocument({ kind: "note", relPath });
        if (ev.noteRelPath === null) await loadEvents();
        setError(null);
      } catch (e) {
        setError(formatAppError(e));
      } finally {
        setBusyKey(null);
      }
    },
    [loadEvents],
  );

  const toggleDetails = (ev: CalendarEvent) =>
    setDetailsKey((cur) => (cur === eventKey(ev) ? null : eventKey(ev)));

  const noteButton = (ev: CalendarEvent, className: string) => {
    const label = ev.noteRelPath !== null ? "Open note" : "Add note";
    return (
      <button
        type="button"
        className={className}
        aria-label={label}
        title={`${label}: ${titleOf(ev)}`}
        disabled={busyKey === eventKey(ev)}
        onClick={() => void handleEventNote(ev)}
        data-testid={`timeline-event-note-${ev.id}`}
      >
        {ev.noteRelPath !== null ? (
          <FileText size={12} aria-hidden="true" />
        ) : (
          <FilePlus size={12} aria-hidden="true" />
        )}
        <span className={styles.noteLabel}>{label}</span>
      </button>
    );
  };

  const nowMin = minutesIntoDay(now);

  return (
    <section
      className={styles.pane}
      aria-label="Day timeline"
      data-testid="day-timeline"
    >
      <header className={styles.header}>
        <h2 className={styles.date} data-testid="day-timeline-date">
          {formatFullDate(date)}
        </h2>
        <div className={styles.nav}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Previous day"
            onClick={() => setDate(addDays(date, -1))}
            data-testid="day-timeline-prev"
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.todayButton}
            onClick={() => setDate(todayLocal())}
            data-testid="day-timeline-today"
          >
            Today
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Next day"
            onClick={() => setDate(addDays(date, 1))}
            data-testid="day-timeline-next"
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${showNotes ? styles.toggleOn : ""}`}
            aria-label="Show notes & clips"
            aria-pressed={showNotes}
            title={`Show notes & clips. ${NOTES_LOCAL_ONLY_TEXT}`}
            onClick={() => setShowNotes(!showNotes)}
            data-testid="day-timeline-notes-toggle"
          >
            <StickyNote size={14} aria-hidden="true" />
          </button>
          {onHide !== undefined && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Hide day timeline"
              title="Hide day timeline"
              onClick={onHide}
              data-testid="day-timeline-hide"
            >
              <PanelLeftClose size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {showNotes && (
        <p className={styles.legend} data-testid="day-timeline-legend">
          {NOTES_LOCAL_ONLY_TEXT}
        </p>
      )}

      {error !== null && (
        <p className={styles.error} data-testid="day-timeline-error">
          {error}
        </p>
      )}

      <div className={styles.allDay} aria-label="All day" role="group">
        <span className={styles.allDayLabel}>All day</span>
        <div className={styles.chips} data-testid="day-timeline-allday">
          {allDay.map((ev) => (
            <button
              key={eventKey(ev)}
              type="button"
              className={`${styles.chip} ${styles.eventChip} ${ev.cancelled ? styles.cancelled : ""}`}
              style={{ "--event-color": calendarColorVar(colorById.get(ev.calendarId)) } as CSSProperties}
              aria-expanded={detailsKey === eventKey(ev)}
              onClick={() => toggleDetails(ev)}
              data-testid={`timeline-allday-${ev.id}`}
            >
              <span className={styles.chipText}>{titleOf(ev)}</span>
            </button>
          ))}
          {(showNotes ? untimedNotes : notes).map((item) => (
            <button
              key={timelineItemKey(item)}
              type="button"
              className={`${styles.chip} ${openKey === timelineItemKey(item) ? styles.chipActive : ""}`}
              aria-label={`Open ${KIND_LABEL[item.docKind].toLowerCase()} ${item.title}`}
              onClick={() => void open(openTargetOf(item))}
              data-testid={`timeline-note-${timelineItemKey(item)}`}
            >
              <DocKindIcon item={item} size={11} />
              <span className={styles.chipText}>{item.title}</span>
            </button>
          ))}
          {!notes.some((n) => n.kind === "JournalEntry") && (
            <button
              type="button"
              className={`${styles.chip} ${styles.chipGhost}`}
              onClick={() => void open({ kind: "journal", date })}
              data-testid="timeline-journal"
            >
              <FilePlus size={11} aria-hidden="true" />
              <span className={styles.chipText}>Journal entry</span>
            </button>
          )}
        </div>
      </div>

      {details !== null && (
        <div
          className={styles.details}
          role="region"
          aria-label="Event details"
          data-testid={`timeline-details-${details.id}`}
        >
          <div className={styles.detailsHeader}>
            <span className={styles.detailsTitle}>{titleOf(details)}</span>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Close details"
              onClick={() => setDetailsKey(null)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
          <p className={styles.detailLine}>{formatTimeRange(details, date)}</p>
          {details.cancelled && <p className={styles.detailLine}>Cancelled</p>}
          {(details.location ?? "").trim() !== "" && (
            <p className={styles.detailLine}>
              <MapPin size={12} aria-hidden="true" />
              <span className={styles.detailText}>{details.location}</span>
            </p>
          )}
          {(details.description ?? "").trim() !== "" && (
            <p className={styles.description}>{details.description}</p>
          )}
          {noteButton(details, styles.detailsNote ?? "")}
        </div>
      )}

      <div className={styles.scroll} ref={scrollRef} data-testid="day-timeline-scroll">
        <div className={styles.grid} style={{ height: HOUR_HEIGHT * 24 }}>
          {HOURS.map((h) => (
            <div
              key={h}
              className={styles.hour}
              style={{ top: h * HOUR_HEIGHT, height: HOUR_HEIGHT }}
            >
              <span className={styles.hourLabel}>{h === 0 ? "" : hourLabel(h)}</span>
            </div>
          ))}
          <div className={styles.events}>
            {blocks.map((block) => {
              if (block.type === "note") {
                const { item, startMin, endMin, col, cols } = block;
                const key = timelineItemKey(item);
                const top = minuteToPx(startMin);
                const time = formatClock(item.placedAt);
                const from = item.sourceHost !== null ? `, from ${item.sourceHost}` : "";
                return (
                  <button
                    key={key}
                    type="button"
                    className={`${styles.marker} ${openKey === key ? styles.markerActive : ""}`}
                    style={{
                      top,
                      height: Math.max(minuteToPx(endMin) - top - 1, 12),
                      left: `${(col / cols) * 100}%`,
                      width: `calc(${(100 / cols) * 0.85}% - 2px)`,
                    }}
                    aria-label={`Open ${KIND_LABEL[item.docKind].toLowerCase()} ${item.title}, ${time}${from}`}
                    title={`${KIND_LABEL[item.docKind]}: ${item.title}. ${NOTES_LOCAL_ONLY_TEXT}`}
                    onClick={() => void open(openTargetOf(item))}
                    data-testid={`timeline-marker-${key}`}
                    data-doc-kind={item.docKind}
                  >
                    <DocKindIcon item={item} size={11} />
                    <span className={styles.markerTitle}>{item.title}</span>
                    <span className={styles.markerTime}>{time}</span>
                    {item.sourceHost !== null && (
                      <span className={styles.markerHost}>{item.sourceHost}</span>
                    )}
                  </button>
                );
              }
              const { ev, startMin, endMin, col, cols } = block;
              const top = minuteToPx(startMin);
              const height = Math.max(minuteToPx(endMin) - top - 1, 14);
              const time = formatTimeRange(ev, date);
              const style = {
                top,
                height,
                left: `${(col / cols) * 100}%`,
                width: `calc(${100 / cols}% - 2px)`,
                "--event-color": calendarColorVar(colorById.get(ev.calendarId)),
              } as CSSProperties;
              return (
                <div
                  key={eventKey(ev)}
                  className={`${styles.block} ${ev.cancelled ? styles.cancelled : ""} ${height < 36 ? styles.blockCompact : ""}`}
                  style={style}
                  data-testid={`timeline-event-${ev.id}`}
                >
                  <button
                    type="button"
                    className={styles.blockMain}
                    aria-label={`${titleOf(ev)}, ${time}${ev.cancelled ? ", cancelled" : ""}`}
                    aria-expanded={detailsKey === eventKey(ev)}
                    onClick={() => toggleDetails(ev)}
                  >
                    <span className={styles.blockTitle}>{titleOf(ev)}</span>
                    <span className={styles.blockTime}>{time}</span>
                  </button>
                  {noteButton(ev, styles.blockNote ?? "")}
                </div>
              );
            })}
          </div>
          {isToday && (
            <div
              className={styles.nowLine}
              style={{ top: minuteToPx(nowMin) }}
              aria-hidden="true"
              data-testid="day-timeline-now"
            />
          )}
        </div>
      </div>
    </section>
  );
}
