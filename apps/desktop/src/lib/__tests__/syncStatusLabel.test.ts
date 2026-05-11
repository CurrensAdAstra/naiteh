import { describe, expect, it } from "vitest";

import { describeSyncStatus } from "../syncStatusLabel";
import type { SyncStatus } from "../types";

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    remoteUrl: null,
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: false,
    lastSync: null,
    ...overrides,
  };
}

describe("describeSyncStatus", () => {
  it("not-initialised vault shows 'Sync: off'", () => {
    expect(describeSyncStatus(null, true, NOW_MS)).toBe("Sync: off");
  });

  it("null status with no flag is em-dash", () => {
    expect(describeSyncStatus(null, false, NOW_MS)).toBe("Sync: —");
  });

  it("dirty working tree always wins", () => {
    expect(describeSyncStatus(status({ dirty: true, lastSync: NOW_SEC - 10 }), false, NOW_MS)).toBe(
      "Sync: pending",
    );
  });

  it("no lastSync and no remote → 'local only'", () => {
    expect(describeSyncStatus(status(), false, NOW_MS)).toBe("Sync: local only");
  });

  it("no lastSync but remote configured → 'never'", () => {
    expect(
      describeSyncStatus(
        status({ remoteUrl: "https://example.com/r.git" }),
        false,
        NOW_MS,
      ),
    ).toBe("Sync: never");
  });

  it("recent lastSync → relative time", () => {
    expect(describeSyncStatus(status({ lastSync: NOW_SEC - 60 }), false, NOW_MS)).toBe(
      "Sync: 1m ago",
    );
    expect(describeSyncStatus(status({ lastSync: NOW_SEC - 3600 }), false, NOW_MS)).toBe(
      "Sync: 1h ago",
    );
  });

  it("'just now' for sub-5-second deltas", () => {
    expect(describeSyncStatus(status({ lastSync: NOW_SEC - 2 }), false, NOW_MS)).toBe(
      "Sync: just now",
    );
  });
});
