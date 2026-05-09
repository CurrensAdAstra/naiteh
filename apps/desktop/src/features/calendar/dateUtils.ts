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

export function parseLocalDate(s: string): Date | null {
  if (s.length !== 10 || s[4] !== "-" || s[7] !== "-") return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  return new Date(y, m - 1, d);
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function addMonths(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

/** "May 2026" — 4-digit year, full English month name. */
export function monthLabel(d: Date): string {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

export interface GridCell {
  date: string;
  inMonth: boolean;
}

/**
 * Build a 6-row × 7-col grid (always 42 cells) for the month containing
 * `month`, padded with the trailing days of the previous month at the start
 * and the leading days of the next month at the end. Weeks are Sunday-first.
 */
export function buildGridCells(month: Date): GridCell[] {
  const first = startOfMonth(month);
  const last = endOfMonth(month);
  const startWeekday = first.getDay(); // 0 = Sun
  const cells: GridCell[] = [];

  for (let i = startWeekday - 1; i >= 0; i--) {
    const d = new Date(first);
    d.setDate(d.getDate() - (i + 1));
    cells.push({ date: formatLocalDate(d), inMonth: false });
  }
  for (let day = 1; day <= last.getDate(); day++) {
    const d = new Date(month.getFullYear(), month.getMonth(), day);
    cells.push({ date: formatLocalDate(d), inMonth: true });
  }
  while (cells.length < 42) {
    const tail = cells[cells.length - 1];
    if (tail === undefined) break;
    const tailDate = parseLocalDate(tail.date);
    if (tailDate === null) break;
    const next = new Date(tailDate);
    next.setDate(next.getDate() + 1);
    cells.push({ date: formatLocalDate(next), inMonth: false });
  }
  return cells;
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
