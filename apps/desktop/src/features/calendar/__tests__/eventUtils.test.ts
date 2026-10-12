import { describe, expect, it } from "vitest";

import type { CalendarEvent } from "../../../lib/types";
import {
  datesWithEvents,
  eventsForDay,
  formatClock,
  formatTimeRange,
  isValidFeedUrl,
  kindForUrl,
} from "../eventUtils";

function ev(partial: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    calendarId: "c1",
    title: partial.id,
    start: "2026-01-08",
    end: "2026-01-09",
    allDay: false,
    cancelled: false,
    location: null,
    description: null,
    noteRelPath: null,
    ...partial,
  };
}

/** Local wall-clock timestamp with the machine's own offset. */
function local(y: number, mo: number, d: number, h: number, mi = 0): string {
  const dt = new Date(y, mo - 1, d, h, mi);
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

describe("eventsForDay", () => {
  it("splits all-day events and orders timed events by start", () => {
    const events = [
      ev({ id: "late", start: local(2026, 1, 8, 15), end: local(2026, 1, 8, 16) }),
      ev({ id: "allday", allDay: true, start: "2026-01-08", end: "2026-01-09" }),
      ev({ id: "early", start: local(2026, 1, 8, 9), end: local(2026, 1, 8, 10) }),
      ev({ id: "other-day", start: local(2026, 1, 9, 9), end: local(2026, 1, 9, 10) }),
    ];
    const day = eventsForDay(events, "2026-01-08");
    expect(day.allDay.map((e) => e.id)).toEqual(["allday"]);
    expect(day.timed.map((e) => e.id)).toEqual(["early", "late"]);
  });

  it("treats the all-day end date as exclusive", () => {
    const multi = ev({ id: "trip", allDay: true, start: "2026-01-08", end: "2026-01-10" });
    expect(eventsForDay([multi], "2026-01-09").allDay).toHaveLength(1);
    expect(eventsForDay([multi], "2026-01-10").allDay).toHaveLength(0);
  });

  it("shows an event crossing midnight on both days", () => {
    const late = ev({ id: "x", start: local(2026, 1, 8, 23), end: local(2026, 1, 9, 1) });
    expect(eventsForDay([late], "2026-01-08").timed).toHaveLength(1);
    expect(eventsForDay([late], "2026-01-09").timed).toHaveLength(1);
    expect(eventsForDay([late], "2026-01-10").timed).toHaveLength(0);
  });

  it("does not spill an event ending exactly at midnight", () => {
    const e = ev({ id: "x", start: local(2026, 1, 8, 22), end: local(2026, 1, 9, 0) });
    expect(eventsForDay([e], "2026-01-09").timed).toHaveLength(0);
    expect(formatTimeRange(e, "2026-01-08")).toBe("22:00–00:00");
  });
});

describe("formatTimeRange", () => {
  it("formats a same-day range", () => {
    const e = ev({ id: "a", start: local(2026, 1, 8, 10), end: local(2026, 1, 8, 11, 30) });
    expect(formatTimeRange(e, "2026-01-08")).toBe("10:00–11:30");
  });

  it("marks the next-day end and the continuation day", () => {
    const e = ev({ id: "a", start: local(2026, 1, 8, 23), end: local(2026, 1, 9, 1) });
    expect(formatTimeRange(e, "2026-01-08")).toBe("23:00–01:00 +1");
    expect(formatTimeRange(e, "2026-01-09")).toBe("Until 01:00");
  });

  it("converts RFC3339 offsets to local time", () => {
    const start = "2026-01-08T10:00:00+09:00";
    const end = "2026-01-08T11:00:00+09:00";
    const s = new Date(start);
    const date = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
    const label = formatTimeRange(ev({ id: "a", start, end }), date);
    expect(label.startsWith(`${formatClock(start)}–${formatClock(end)}`)).toBe(true);
    // UTC 01:00 is the same instant.
    expect(formatClock("2026-01-08T01:00:00Z")).toBe(formatClock(start));
  });

  it("labels the middle of a multi-day timed event as all day", () => {
    const e = ev({ id: "a", start: local(2026, 1, 7, 9), end: local(2026, 1, 9, 9) });
    expect(formatTimeRange(e, "2026-01-08")).toBe("All day");
  });
});

describe("datesWithEvents", () => {
  it("marks every day an event touches inside the window", () => {
    const set = datesWithEvents(
      [
        ev({ id: "a", allDay: true, start: "2026-01-30", end: "2026-02-02" }),
        ev({ id: "b", start: local(2026, 1, 5, 23), end: local(2026, 1, 6, 2) }),
      ],
      "2026-01-01",
      "2026-02-01",
    );
    expect([...set].sort()).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-30",
      "2026-01-31",
    ]);
  });
});

describe("feed helpers", () => {
  it("validates and classifies feed URLs", () => {
    expect(isValidFeedUrl("https://calendar.google.com/calendar/ical/x/basic.ics")).toBe(true);
    expect(isValidFeedUrl("webcal://p01-caldav.icloud.com/published/2/abc")).toBe(true);
    expect(isValidFeedUrl("calendar.google.com")).toBe(false);
    expect(isValidFeedUrl("")).toBe(false);
    expect(kindForUrl("https://calendar.google.com/x.ics")).toBe("google");
    expect(kindForUrl("webcal://p01-caldav.icloud.com/published/2/abc")).toBe("apple");
    expect(kindForUrl("https://example.com/team.ics")).toBe("ics");
  });
});
