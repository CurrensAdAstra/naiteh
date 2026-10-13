import { describe, expect, it } from "vitest";

import type { CompareRow } from "../../../lib/api/backup";
import { driveDestination, filterRows, formatSize } from "../backupFormat";

const e = { size: 1, hash: "h", mtime: 0 };
const rows: CompareRow[] = [
  { relPath: "notes/a.md", entries: { local: e }, status: "same" },
  { relPath: "notes/b.md", entries: { local: e, d: null }, status: "missing" },
  { relPath: "journal/c.md", entries: { local: e }, status: "differs" },
];

describe("backupFormat", () => {
  it("filters by status and path", () => {
    const paths = (f: Parameters<typeof filterRows>[1], q = "") =>
      filterRows(rows, f, q).map((r) => r.relPath);
    expect(paths("all")).toEqual(["notes/b.md", "journal/c.md"]);
    expect(paths("missing")).toEqual(["notes/b.md"]);
    expect(paths("changed")).toEqual(["journal/c.md"]);
    expect(paths("identical")).toHaveLength(3);
    expect(paths("identical", "NOTES")).toEqual(["notes/a.md", "notes/b.md"]);
  });

  it("builds the Drive destination with the folder's separator", () => {
    expect(driveDestination("G:\\My Drive\\", "duramen")).toBe(
      "G:\\My Drive\\naiteh-backup\\duramen",
    );
    expect(driveDestination("/Users/me/Google Drive", "v")).toBe(
      "/Users/me/Google Drive/naiteh-backup/v",
    );
  });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
