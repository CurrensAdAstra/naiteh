import { describe, expect, it } from "vitest";

import {
  formatDayHeader,
  formatLocalDate,
  journalRelPathFor,
  rangeAround,
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
});
