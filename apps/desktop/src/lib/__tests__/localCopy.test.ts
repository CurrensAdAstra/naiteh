import { describe, expect, it } from "vitest";

import { localCopyRelPath } from "../localCopy";

describe("localCopyRelPath", () => {
  const at = new Date(2026, 4, 11, 9, 30, 12); // 2026-05-11 09:30:12 local

  it("puts the copy next to the note with a .local-<timestamp>.md suffix", () => {
    expect(localCopyRelPath("notes/work/ideas.md", at)).toBe(
      "notes/work/ideas.local-20260511-093012.md",
    );
  });

  it("works for journal entries (an ordinary note beside the entry)", () => {
    expect(localCopyRelPath("journal/2026/05/2026-05-11.md", at)).toBe(
      "journal/2026/05/2026-05-11.local-20260511-093012.md",
    );
  });

  it("handles files without a directory or extension", () => {
    expect(localCopyRelPath("README", at)).toBe("README.local-20260511-093012.md");
    expect(localCopyRelPath("notes/.hidden", at)).toBe(
      "notes/.hidden.local-20260511-093012.md",
    );
  });
});
