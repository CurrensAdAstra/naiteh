/** Format a Date as a vault-canonical YYYY-MM-DD string in local time. */
export function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Today's local-date string. */
export function todayLocal(now: Date = new Date()): string {
  return formatLocalDate(now);
}

/** Given a YYYY-MM-DD, return the Mon Jan 2 style label for the day header. */
export function formatDayHeader(date: string, today: string): string {
  if (date === today) {
    const d = parseLocalDate(date) ?? new Date();
    return `Today · ${weekdayShort(d)} ${monthShort(d)} ${d.getDate()}`;
  }
  const d = parseLocalDate(date);
  if (d === null) return date;
  return `${weekdayShort(d)} ${monthShort(d)} ${d.getDate()}`;
}

/** Build the `journal/YYYY/MM/YYYY-MM-DD.md` path for a date. */
export function journalRelPathFor(date: string): string {
  return `journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
}

/** Compute the inclusive [from, to] range for a window centered on today. */
export function rangeAround(
  today: string,
  daysBefore: number,
  daysAfter: number = 0,
): { from: string; to: string } {
  const t = parseLocalDate(today) ?? new Date();
  const from = new Date(t);
  from.setDate(from.getDate() - daysBefore);
  const to = new Date(t);
  to.setDate(to.getDate() + daysAfter);
  return { from: formatLocalDate(from), to: formatLocalDate(to) };
}

function parseLocalDate(s: string): Date | null {
  if (s.length !== 10 || s[4] !== "-" || s[7] !== "-") return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  return new Date(y, m - 1, d);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function weekdayShort(d: Date): string {
  return WEEKDAYS[d.getDay()] ?? "";
}

function monthShort(d: Date): string {
  return MONTHS[d.getMonth()] ?? "";
}
