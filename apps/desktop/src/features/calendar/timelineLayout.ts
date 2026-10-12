import type { CalendarEvent, TimelineItem } from "../../lib/types";
import { DAY_TIMELINE_MIN } from "../../state/uiStore";
import { parseLocalDate } from "./dateUtils";

/**
 * Pure geometry for the Calendar mode day timeline (DayTimeline.tsx):
 * where each timed event sits on the 00:00–24:00 hour grid, how
 * overlapping events share the width, and how wide the pane may be.
 */

export const HOUR_HEIGHT = 56;
export const DAY_MINUTES = 24 * 60;
/** Shortest drawn block, so zero-length / 5-minute events stay clickable. */
export const MIN_BLOCK_MINUTES = 20;
/** Visual height of a note / clip / journal marker on the hour grid. */
export const NOTE_MARKER_MINUTES = 15;

export interface TimelineBlock {
  ev: CalendarEvent;
  /** Minutes from local midnight, clipped to the day. */
  startMin: number;
  endMin: number;
  /** Column within its overlap cluster and the cluster's column count. */
  col: number;
  cols: number;
}

function dayBounds(date: string): { start: number; end: number } | null {
  const d = parseLocalDate(date);
  if (d === null) return null;
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return { start: d.getTime(), end: next.getTime() };
}

/**
 * Lay out the timed events touching `date`. Events crossing midnight are
 * clipped to the day; overlapping events are placed side by side, every
 * event of an overlap cluster getting the same column count.
 */
export function layoutDayEvents(
  events: readonly CalendarEvent[],
  date: string,
): TimelineBlock[] {
  return layoutDay(events, [], date).flatMap((b) =>
    b.type === "event"
      ? [{ ev: b.ev, startMin: b.startMin, endMin: b.endMin, col: b.col, cols: b.cols }]
      : [],
  );
}

/** A note / clip / journal marker placed on the hour grid. */
export interface NoteMarkerBlock {
  item: TimelineItem;
  startMin: number;
  endMin: number;
  col: number;
  cols: number;
}

export type DayBlock =
  | (TimelineBlock & { type: "event" })
  | (NoteMarkerBlock & { type: "note" });

/**
 * Split the day's timeline items into those drawn at a time on the grid
 * (their `placedAt` falls on `date`) and those shown as all-day chips
 * (no usable time, e.g. a date-only `created`).
 */
export function splitDayNotes(
  items: readonly TimelineItem[],
  date: string,
): { timed: TimelineItem[]; untimed: TimelineItem[] } {
  const day = dayBounds(date);
  const timed: TimelineItem[] = [];
  const untimed: TimelineItem[] = [];
  for (const item of items) {
    const t = item.placedAt === null ? NaN : new Date(item.placedAt).getTime();
    if (day !== null && !Number.isNaN(t) && t >= day.start && t < day.end) {
      timed.push(item);
    } else {
      untimed.push(item);
    }
  }
  return { timed, untimed };
}

/**
 * Lay out timed events and timed note markers together: markers take
 * NOTE_MARKER_MINUTES of height and share overlap columns with events.
 * Items whose `placedAt` isn't on `date` are left out (see splitDayNotes).
 */
export function layoutDay(
  events: readonly CalendarEvent[],
  notes: readonly TimelineItem[],
  date: string,
): DayBlock[] {
  const day = dayBounds(date);
  if (day === null) return [];
  // Real day length (23h / 25h across DST) mapped onto 24 grid hours.
  const dayMs = day.end - day.start;
  const toMin = (t: number) =>
    Math.min(DAY_MINUTES, Math.max(0, ((t - day.start) / dayMs) * DAY_MINUTES));

  const items: DayBlock[] = [];
  for (const item of splitDayNotes(notes, date).timed) {
    const startMin = Math.min(
      toMin(new Date(item.placedAt ?? "").getTime()),
      DAY_MINUTES - NOTE_MARKER_MINUTES,
    );
    items.push({
      type: "note",
      item,
      startMin,
      endMin: startMin + NOTE_MARKER_MINUTES,
      col: 0,
      cols: 1,
    });
  }
  for (const ev of events) {
    if (ev.allDay) continue;
    const s = new Date(ev.start).getTime();
    if (Number.isNaN(s)) continue;
    const parsedEnd = new Date(ev.end).getTime();
    const e = Number.isNaN(parsedEnd) ? s : Math.max(parsedEnd, s);
    const touches =
      e === s ? s >= day.start && s < day.end : s < day.end && e > day.start;
    if (!touches) continue;
    const startMin = toMin(s);
    let endMin = Math.max(toMin(e), startMin + MIN_BLOCK_MINUTES);
    if (endMin > DAY_MINUTES) endMin = DAY_MINUTES;
    items.push({ type: "event", ev, startMin, endMin, col: 0, cols: 1 });
  }
  const label = (b: DayBlock) => (b.type === "event" ? b.ev.title : b.item.title);
  items.sort(
    (a, b) =>
      a.startMin - b.startMin ||
      b.endMin - a.endMin ||
      // Events before notes at the same slot.
      (a.type === b.type ? 0 : a.type === "event" ? -1 : 1) ||
      label(a).localeCompare(label(b)),
  );

  // Sweep: a cluster ends when the next block starts after every
  // block so far has ended; inside it, greedy first-free column.
  let cluster: DayBlock[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const b of cluster) b.cols = colEnds.length;
    cluster = [];
    colEnds = [];
  };
  for (const b of items) {
    if (cluster.length > 0 && b.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= b.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(b.endMin);
    } else {
      colEnds[col] = b.endMin;
    }
    b.col = col;
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  flush();
  return items;
}

/** Pixel offset of a minute-of-day on the hour grid. */
export function minuteToPx(min: number): number {
  return (min / 60) * HOUR_HEIGHT;
}

/** Minutes since local midnight of `now` (for the current-time line). */
export function minutesIntoDay(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** Where the grid scrolls on open: an hour before now (today) or 8 AM. */
export function initialScrollMinute(isToday: boolean, now: Date): number {
  return isToday ? Math.max(0, minutesIntoDay(now) - 60) : 8 * 60;
}

/** "9 AM" / "09" / "21 h" — the hour label in the user's locale. */
export function hourLabel(hour: number, locale?: string): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(locale, {
    hour: "numeric",
  });
}

// ---- Pane width (Calendar mode: list | timeline | editor) ----

export const EDITOR_MIN_WIDTH = 320;
export const TIMELINE_RESIZER_WIDTH = 5;

/**
 * Width the timeline pane actually gets inside a `containerWidth` px
 * editor cell: the preferred width, shrunk so the editor keeps
 * EDITOR_MIN_WIDTH; `null` (collapse to a toggle) once even
 * DAY_TIMELINE_MIN no longer fits. An unmeasured (0) container keeps
 * the preferred width.
 */
export function fitTimelineWidth(
  containerWidth: number,
  preferred: number,
): number | null {
  if (!(containerWidth > 0)) return preferred;
  const room = containerWidth - EDITOR_MIN_WIDTH - TIMELINE_RESIZER_WIDTH;
  if (room < DAY_TIMELINE_MIN) return null;
  return Math.min(preferred, room);
}
