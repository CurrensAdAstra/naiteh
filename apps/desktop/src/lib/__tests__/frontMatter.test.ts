import { describe, expect, it } from "vitest";

import {
  isPinnedInContent,
  setPinnedInContent,
  togglePinnedInContent,
} from "../frontMatter";

describe("frontMatter", () => {
  describe("isPinnedInContent", () => {
    it("returns false when no front matter", () => {
      expect(isPinnedInContent("body only")).toBe(false);
    });

    it("returns false when front matter omits pinned", () => {
      expect(isPinnedInContent("---\ntitle: x\n---\nbody")).toBe(false);
    });

    it("returns true when front matter has pinned: true", () => {
      expect(
        isPinnedInContent("---\ntitle: x\npinned: true\n---\nbody"),
      ).toBe(true);
    });

    it("treats pinned: false as not pinned", () => {
      expect(
        isPinnedInContent("---\npinned: false\n---\nbody"),
      ).toBe(false);
    });

    it("ignores malformed front matter", () => {
      expect(isPinnedInContent("---\nno fence end\nbody")).toBe(false);
    });
  });

  describe("setPinnedInContent", () => {
    it("inserts a fresh block when pinning a doc with no front matter", () => {
      const out = setPinnedInContent("body\n", true);
      expect(out).toBe("---\npinned: true\n---\nbody\n");
    });

    it("does nothing when unpinning a doc with no front matter", () => {
      const before = "body\n";
      expect(setPinnedInContent(before, false)).toBe(before);
    });

    it("replaces an existing pinned line", () => {
      const out = setPinnedInContent(
        "---\ntitle: x\npinned: false\n---\nbody",
        true,
      );
      expect(out).toBe("---\ntitle: x\npinned: true\n---\nbody");
    });

    it("appends a pinned line when front matter lacks one", () => {
      const out = setPinnedInContent("---\ntitle: x\n---\nbody", true);
      expect(out).toBe("---\ntitle: x\npinned: true\n---\nbody");
    });

    it("preserves the rest of the document body", () => {
      const before =
        "---\ntitle: x\n---\nfirst paragraph\n\nsecond paragraph";
      const after = setPinnedInContent(before, true);
      expect(after.endsWith("first paragraph\n\nsecond paragraph")).toBe(
        true,
      );
    });
  });

  describe("togglePinnedInContent", () => {
    it("flips pinned from absent to true", () => {
      const out = togglePinnedInContent("---\ntitle: x\n---\nb");
      expect(isPinnedInContent(out)).toBe(true);
    });

    it("flips pinned from true to false", () => {
      const out = togglePinnedInContent(
        "---\npinned: true\n---\nb",
      );
      expect(isPinnedInContent(out)).toBe(false);
    });
  });
});
