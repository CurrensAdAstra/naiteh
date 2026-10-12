import { describe, expect, it } from "vitest";

import type { CalendarEvent, TimelineItem } from "../../../lib/types";
import {
  DAY_MINUTES,
  EDITOR_MIN_WIDTH,
  HOUR_HEIGHT,
  MIN_BLOCK_MINUTES,
  TIMELINE_RESIZER_WIDTH,
  fitTimelineWidth,
  hourLabel,
  initialScrollMinute,
  NOTE_MARKER_MINUTES,
  layoutDay,
  layoutDayEvents,
  splitDayNotes,
  minuteToPx,
} from "../timelineLayout";

function local(y: number, mo: number, d: number, h: number, mi = 0): string {
  const dt = new Date(y, mo - 1, d, h, mi);
  const off = -dt.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:00${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const DAY = "2026-01-08";
function ev(
  id: string,
  sh: number,
  eh: number,
  extra: Partial<CalendarEvent> = {},
): CalendarEvent {
  return {
    id,
    calendarId: "c1",
    title: id,
    start: local(2026, 1, 8, sh),
    end: local(2026, 1, 8, eh),
    allDay: false,
    cancelled: false,
    location: null,
    description: null,
    noteRelPath: null,
    ...extra,
  };
}

const byId = (blocks: ReturnType<typeof layoutDayEvents>) =>
  Object.fromEntries(blocks.map((b) => [b.ev.id, b]));

describe("layoutDayEvents", () => {
  it("positions events by minutes from midnight", () => {
    const [b] = layoutDayEvents([ev("a", 9, 11)], DAY);
    expect(b).toMatchObject({ startMin: 540, endMin: 660, col: 0, cols: 1 });
    expect(minuteToPx(b!.startMin)).toBe(9 * HOUR_HEIGHT);
  });

  it("puts overlapping events side by side and keeps others full width", () => {
    const blocks = byId(
      layoutDayEvents(
        [ev("a", 9, 11), ev("b", 10, 12), ev("c", 10, 11), ev("d", 13, 14)],
        DAY,
      ),
    );
    expect([blocks.a!.col, blocks.b!.col, blocks.c!.col].sort()).toEqual([0, 1, 2]);
    for (const id of ["a", "b", "c"]) expect(blocks[id]!.cols).toBe(3);
    expect(blocks.d).toMatchObject({ col: 0, cols: 1 });
  });

  it("reuses a freed column within a cluster", () => {
    const blocks = byId(
      layoutDayEvents([ev("a", 9, 12), ev("b", 9, 10), ev("c", 10, 11)], DAY),
    );
    expect(blocks.a!.col).toBe(0);
    expect(blocks.b!.col).toBe(1);
    expect(blocks.c!.col).toBe(1);
    expect(blocks.c!.cols).toBe(2);
  });

  it("back-to-back events do not overlap", () => {
    const blocks = byId(layoutDayEvents([ev("a", 9, 10), ev("b", 10, 11)], DAY));
    expect(blocks.a!.cols).toBe(1);
    expect(blocks.b!.cols).toBe(1);
  });

  it("clips events crossing midnight to the day", () => {
    const before = ev("before", 0, 2, { start: local(2026, 1, 7, 22) });
    const after = ev("after", 23, 0, { end: local(2026, 1, 9, 2) });
    const blocks = byId(layoutDayEvents([before, after], DAY));
    expect(blocks.before).toMatchObject({ startMin: 0, endMin: 120 });
    expect(blocks.after).toMatchObject({ startMin: 23 * 60, endMin: DAY_MINUTES });
  });

  it("skips all-day events and other days; zero-length gets a minimum", () => {
    const blocks = layoutDayEvents(
      [
        ev("allday", 0, 0, { allDay: true, start: DAY, end: "2026-01-09" }),
        ev("other", 9, 10, {
          start: local(2026, 1, 9, 9),
          end: local(2026, 1, 9, 10),
        }),
        ev("zero", 9, 9),
      ],
      DAY,
    );
    expect(blocks.map((b) => b.ev.id)).toEqual(["zero"]);
    expect(blocks[0]!.endMin - blocks[0]!.startMin).toBe(MIN_BLOCK_MINUTES);
  });
});

describe("timeline helpers", () => {
  it("scrolls to an hour before now on today, else 8 AM", () => {
    expect(initialScrollMinute(true, new Date(2026, 0, 8, 14, 30))).toBe(13 * 60 + 30);
    expect(initialScrollMinute(true, new Date(2026, 0, 8, 0, 20))).toBe(0);
    expect(initialScrollMinute(false, new Date(2026, 0, 8, 14))).toBe(8 * 60);
  });

  it("labels hours in the locale's clock", () => {
    expect(hourLabel(9, "en-US")).toBe("9 AM");
    expect(hourLabel(21, "en-GB")).toMatch(/^21/);
  });

  it("fits the pane so the editor keeps its minimum, then collapses", () => {
    const fixed = EDITOR_MIN_WIDTH + TIMELINE_RESIZER_WIDTH;
    expect(fitTimelineWidth(0, 380)).toBe(380);
    expect(fitTimelineWidth(2000, 380)).toBe(380);
    expect(fitTimelineWidth(fixed + 300, 380)).toBe(300);
    expect(fitTimelineWidth(fixed + 279, 380)).toBeNull();
  });
});

function noteAt(relPath: string, placedAt: string | null): TimelineItem {
  return {
    kind: "Note",
    relPath,
    title: relPath,
    mtime: 0,
    snippet: "",
    pinned: false,
    createdAt: placedAt,
    placedAt,
    docKind: "note",
    sourceHost: null,
  };
}

describe("layoutDay (events + note markers)", () => {
  it("places markers at their time and shares overlap columns with events", () => {
    const blocks = layoutDay(
      [ev("a", 9, 10)],
      [
        noteAt("notes/n.md", local(2026, 1, 8, 9, 30)),
        noteAt("notes/late.md", local(2026, 1, 8, 15, 0)),
      ],
      DAY,
    );
    expect(blocks).toHaveLength(3);
    const event = blocks.find((b) => b.type === "event")!;
    const marker = blocks.find(
      (b) => b.type === "note" && b.item.kind === "Note" && b.item.relPath === "notes/n.md",
    )!;
    const late = blocks.find(
      (b) => b.type === "note" && b.item.kind === "Note" && b.item.relPath === "notes/late.md",
    )!;
    expect(marker.startMin).toBe(9 * 60 + 30);
    expect(marker.endMin).toBe(9 * 60 + 30 + NOTE_MARKER_MINUTES);
    expect(event.cols).toBe(2);
    expect(marker.cols).toBe(2);
    expect(marker.col).toBe(1);
    expect(late.cols).toBe(1);
    expect(late.col).toBe(0);
  });

  it("leaves untimed and other-day notes out of the grid", () => {
    const items = [
      noteAt("notes/dateonly.md", null),
      noteAt("notes/yesterday.md", local(2026, 1, 7, 12)),
      noteAt("notes/today.md", local(2026, 1, 8, 12)),
    ];
    const { timed, untimed } = splitDayNotes(items, DAY);
    expect(timed.map((i) => (i.kind === "Note" ? i.relPath : ""))).toEqual(["notes/today.md"]);
    expect(untimed).toHaveLength(2);
    expect(layoutDay([], items, DAY)).toHaveLength(1);
  });

  it("keeps a marker at 23:55 inside the day", () => {
    const [b] = layoutDay([], [noteAt("notes/n.md", local(2026, 1, 8, 23, 55))], DAY);
    expect(b!.endMin).toBe(DAY_MINUTES);
  });

  it("layoutDayEvents is unchanged for events only", () => {
    const blocks = layoutDayEvents([ev("a", 9, 10)], DAY);
    expect(blocks).toEqual([
      { ev: expect.objectContaining({ id: "a" }), startMin: 540, endMin: 600, col: 0, cols: 1 },
    ]);
  });
});
