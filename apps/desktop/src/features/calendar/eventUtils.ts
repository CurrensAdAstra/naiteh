import type {
  CalendarColor,
  CalendarEvent,
  TimelineItem,
} from "../../lib/types";
import { formatLocalDate, parseLocalDate } from "./dateUtils";

/**
 * Pure helpers for the Day tab: which events touch a local date, in what
 * order, and how their times read. Timed events carry RFC3339 timestamps
 * with an offset; they are shown in the machine's local time zone.
 * All-day events carry `YYYY-MM-DD` dates with an exclusive end.
 */

const DAY_MS = 86_400_000;

function startOfLocalDay(date: string): number | null {
  const d = parseLocalDate(date);
  return d === null ? null : d.getTime();
}

function nextLocalDay(date: string): number | null {
  const d = parseLocalDate(date);
  if (d === null) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function ms(ts: string): number {
  return new Date(ts).getTime();
}

/** All-day end, tolerating a missing/equal end as a one-day event. */
function allDayEnd(ev: CalendarEvent): string {
  return ev.end > ev.start ? ev.end : addDays(ev.start, 1);
}

export function addDays(date: string, delta: number): string {
  const d = parseLocalDate(date);
  if (d === null) return date;
  return formatLocalDate(
    new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta),
  );
}

/** True when the event overlaps the local day `date`. */
export function eventTouchesDate(ev: CalendarEvent, date: string): boolean {
  if (ev.allDay) return ev.start <= date && date < allDayEnd(ev);
  const dayStart = startOfLocalDay(date);
  const dayEnd = nextLocalDay(date);
  if (dayStart === null || dayEnd === null) return false;
  const s = ms(ev.start);
  const e = Math.max(ms(ev.end), s);
  if (Number.isNaN(s)) return false;
  // Zero-length events count on the day they start.
  if (e === s) return s >= dayStart && s < dayEnd;
  return s < dayEnd && e > dayStart;
}

export interface DayEvents {
  allDay: CalendarEvent[];
  timed: CalendarEvent[];
}

/** Split and order the events of one local day. */
export function eventsForDay(
  events: readonly CalendarEvent[],
  date: string,
): DayEvents {
  const touching = events.filter((ev) => eventTouchesDate(ev, date));
  const byTitle = (a: CalendarEvent, b: CalendarEvent) =>
    a.title.localeCompare(b.title);
  const allDay = touching.filter((ev) => ev.allDay).sort(byTitle);
  const timed = touching
    .filter((ev) => !ev.allDay)
    .sort((a, b) => ms(a.start) - ms(b.start) || ms(a.end) - ms(b.end) || byTitle(a, b));
  return { allDay, timed };
}

/** Every local date (within `[from, to)`) touched by at least one event. */
export function datesWithEvents(
  events: readonly CalendarEvent[],
  from: string,
  to: string,
): Set<string> {
  const out = new Set<string>();
  const start = startOfLocalDay(from);
  const end = startOfLocalDay(to);
  if (start === null || end === null) return out;
  for (const ev of events) {
    if (ev.allDay) {
      for (let d = ev.start < from ? from : ev.start; d < allDayEnd(ev) && d < to; d = addDays(d, 1)) {
        out.add(d);
      }
      continue;
    }
    const s = ms(ev.start);
    if (Number.isNaN(s)) continue;
    const e = Math.max(ms(ev.end), s);
    let d = formatLocalDate(new Date(Math.max(s, start)));
    // Walk local days until the event ends (bounded by the window).
    for (let i = 0; i < 400 && d < to; i++, d = addDays(d, 1)) {
      if (eventTouchesDate(ev, d)) out.add(d);
      const next = nextLocalDay(d);
      if (next === null || next >= e) break;
    }
  }
  return out;
}

/** "09:05" in local time (24-hour clock). */
export function formatClock(ts: string | number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Time label of a timed event as seen on `date`:
 * - same-day: "10:00–11:00"
 * - starts on `date`, ends later: "23:00–01:00 +1"
 * - started before `date`: "Until 01:00" (or "All day" when it also
 *   continues past `date`)
 */
export function formatTimeRange(ev: CalendarEvent, date: string): string {
  if (ev.allDay) return "All day";
  const dayStart = startOfLocalDay(date) ?? 0;
  const dayEnd = nextLocalDay(date) ?? dayStart + DAY_MS;
  const s = ms(ev.start);
  const e = Math.max(ms(ev.end), s);
  const startsBefore = s < dayStart;
  const endsAfter = e > dayEnd;
  if (startsBefore && endsAfter) return "All day";
  if (startsBefore) return `Until ${formatClock(e)}`;
  if (s === e) return formatClock(s);
  const endDate = formatLocalDate(new Date(e));
  const startDate = formatLocalDate(new Date(s));
  const days = Math.round(
    ((startOfLocalDay(endDate) ?? 0) - (startOfLocalDay(startDate) ?? 0)) /
      DAY_MS,
  );
  // An event ending exactly at midnight does not spill into the next day.
  const spill = e === dayEnd ? 0 : days;
  const suffix = spill > 0 ? ` +${spill}` : "";
  return `${formatClock(s)}–${formatClock(e)}${suffix}`;
}

/** "Monday, January 8" in the user's locale. */
export function formatLongDate(date: string): string {
  const d = parseLocalDate(date);
  if (d === null) return date;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** "Monday, January 8, 2026" in the user's locale. */
export function formatFullDate(date: string): string {
  const d = parseLocalDate(date);
  if (d === null) return date;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Infer the feed kind from its URL host. */
export function kindForUrl(url: string): "google" | "apple" | "ics" {
  let host = "";
  try {
    host = new URL(url.replace(/^webcals?:\/\//i, "https://")).hostname;
  } catch {
    return "ics";
  }
  if (host === "calendar.google.com" || host.endsWith(".google.com")) {
    return "google";
  }
  if (host.endsWith("icloud.com")) return "apple";
  return "ics";
}

/** Accepts http(s) and webcal(s) URLs with a host. */
export function isValidFeedUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!/^(https?|webcals?):\/\//i.test(trimmed)) return false;
  try {
    const u = new URL(trimmed.replace(/^webcals?:\/\//i, "https://"));
    return u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** CSS custom property for a calendar color token (tokens.css). */
export function calendarColorVar(color: CalendarColor | undefined): string {
  return `var(--color-cal-${color ?? "gray"})`;
}

/** Doubles as the editorStore `open.key` of the item when it's open. */
export function timelineItemKey(item: TimelineItem): string {
  return item.kind === "JournalEntry"
    ? `journal:${item.date}`
    : `note:${item.relPath}`;
}
