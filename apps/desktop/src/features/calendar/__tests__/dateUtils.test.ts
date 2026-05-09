import { describe, expect, it } from "vitest";

import {
  addMonths,
  buildGridCells,
  endOfMonth,
  formatDayHeader,
  formatLocalDate,
  journalRelPathFor,
  monthLabel,
  rangeAround,
  startOfMonth,
  todayLocal,
} from "../dateUtils";

describe("dateUtils", () => {
  it("formatLocalDate zero-pads year/month/day", () => {
    expect(formatLocalDate(new Date(2026, 4, 9))).toBe("2026-05-09");
    expect(formatLocalDate(new Date(2026, 0, 1))).toBe("2026-01-01");
  });

  it("todayLocal accepts an injected Date for testability", () => {
    expect(todayLocal(new Date(2026, 4, 9))).toBe("2026-05-09");
  });

  it("rangeAround returns the inclusive window in YYYY-MM-DD", () => {
    expect(rangeAround("2026-05-09", 2, 0)).toEqual({
      from: "2026-05-07",
      to: "2026-05-09",
    });
    expect(rangeAround("2026-05-09", 0, 2)).toEqual({
      from: "2026-05-09",
      to: "2026-05-11",
    });
  });

  it("formatDayHeader prefixes 'Today' when the date matches", () => {
    expect(formatDayHeader("2026-05-09", "2026-05-09")).toMatch(/^Today/);
    expect(formatDayHeader("2026-05-08", "2026-05-09")).not.toMatch(/Today/);
  });

  it("journalRelPathFor builds the architecture-canonical path", () => {
    expect(journalRelPathFor("2026-05-09")).toBe(
      "journal/2026/05/2026-05-09.md",
    );
  });

  it("startOfMonth / endOfMonth return month boundaries", () => {
    const d = new Date(2026, 4, 17);
    expect(formatLocalDate(startOfMonth(d))).toBe("2026-05-01");
    expect(formatLocalDate(endOfMonth(d))).toBe("2026-05-31");
  });

  it("addMonths shifts by N months and clamps to day 1", () => {
    expect(formatLocalDate(addMonths(new Date(2026, 4, 17), 1))).toBe(
      "2026-06-01",
    );
    expect(formatLocalDate(addMonths(new Date(2026, 0, 31), -1))).toBe(
      "2025-12-01",
    );
  });

  it("monthLabel uses the full month name + 4-digit year", () => {
    expect(monthLabel(new Date(2026, 4, 1))).toBe("May 2026");
    expect(monthLabel(new Date(2026, 11, 31))).toBe("December 2026");
  });

  it("buildGridCells produces 42 cells starting on Sunday", () => {
    const cells = buildGridCells(new Date(2026, 4, 1));
    expect(cells).toHaveLength(42);
    // 2026-05-01 is a Friday, so the grid starts at the previous Sunday
    // (2026-04-26).
    expect(cells[0]?.date).toBe("2026-04-26");
    expect(cells[0]?.inMonth).toBe(false);
    const may1 = cells.find((c) => c.date === "2026-05-01");
    expect(may1?.inMonth).toBe(true);
  });

  it("buildGridCells flags days outside the current month", () => {
    const cells = buildGridCells(new Date(2026, 4, 15));
    const inMonth = cells.filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]?.date).toBe("2026-05-01");
    expect(inMonth[inMonth.length - 1]?.date).toBe("2026-05-31");
  });
});
