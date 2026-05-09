import { describe, expect, it } from "vitest";

import { formatRelative } from "../formatRelative";

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

describe("formatRelative", () => {
  it("returns em dash for invalid input", () => {
    expect(formatRelative(0, NOW_MS)).toBe("—");
    expect(formatRelative(-1, NOW_MS)).toBe("—");
    expect(formatRelative(Number.NaN, NOW_MS)).toBe("—");
  });

  it("formats sub-minute deltas", () => {
    expect(formatRelative(NOW_SEC - 1, NOW_MS)).toBe("just now");
    expect(formatRelative(NOW_SEC - 30, NOW_MS)).toBe("30s ago");
  });

  it("formats minutes / hours / days", () => {
    expect(formatRelative(NOW_SEC - 90, NOW_MS)).toBe("1m ago");
    expect(formatRelative(NOW_SEC - 3601, NOW_MS)).toBe("1h ago");
    expect(formatRelative(NOW_SEC - 86_401, NOW_MS)).toBe("1d ago");
  });

  it("falls back to a date string past one week", () => {
    const old = NOW_SEC - 604_801;
    const out = formatRelative(old, NOW_MS);
    expect(out).not.toMatch(/ago/);
    expect(out.length).toBeGreaterThan(0);
  });
});
