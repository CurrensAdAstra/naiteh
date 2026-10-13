import { describe, expect, it } from "vitest";

import {
  addTagToContent,
  getTagsFromContent,
  isPinnedInContent,
  removeTagFromContent,
  setPinnedInContent,
  setTagsInContent,
  togglePinnedInContent,
} from "../frontMatter";

describe("frontMatter", () => {
  describe("line endings", () => {
    const crlf = "---\r\ntitle: x\r\ntags: [a]\r\npinned: true\r\n---\r\nbody\r\n";

    it("reads CRLF front matter", () => {
      expect(isPinnedInContent(crlf)).toBe(true);
      expect(getTagsFromContent(crlf)).toEqual(["a"]);
    });

    it("keeps CRLF when rewriting", () => {
      expect(setPinnedInContent(crlf, false)).toBe(
        "---\r\ntitle: x\r\ntags: [a]\r\npinned: false\r\n---\r\nbody\r\n",
      );
      expect(addTagToContent(crlf, "b")).toBe(
        "---\r\ntitle: x\r\ntags: [a, b]\r\npinned: true\r\n---\r\nbody\r\n",
      );
    });

    it("accepts a closing fence at end of file", () => {
      expect(isPinnedInContent("---\npinned: true\n---")).toBe(true);
    });
  });

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

  describe("getTagsFromContent", () => {
    it("returns [] when no front matter", () => {
      expect(getTagsFromContent("just body")).toEqual([]);
    });

    it("parses a bare-word tag list", () => {
      expect(
        getTagsFromContent("---\ntags: [work, idea]\n---\nbody"),
      ).toEqual(["work", "idea"]);
    });

    it("parses a quoted tag list", () => {
      expect(
        getTagsFromContent(
          "---\ntags: [\"q a\", 'b']\n---\nbody",
        ),
      ).toEqual(["q a", "b"]);
    });

    it("dedupes duplicate tags from the source", () => {
      expect(
        getTagsFromContent("---\ntags: [a, a, b]\n---\nbody"),
      ).toEqual(["a", "b"]);
    });
  });

  describe("setTagsInContent", () => {
    it("creates fresh front matter when none exists", () => {
      const out = setTagsInContent("body only", ["work"]);
      expect(out).toBe("---\ntags: [work]\n---\nbody only");
    });

    it("does nothing when tags is empty and no front matter exists", () => {
      expect(setTagsInContent("body only", [])).toBe("body only");
    });

    it("removes the tags line when tags becomes empty", () => {
      const out = setTagsInContent(
        "---\ntitle: x\ntags: [a, b]\n---\nbody",
        [],
      );
      expect(out).toBe("---\ntitle: x\n---\nbody");
    });

    it("replaces an existing tags line", () => {
      const out = setTagsInContent(
        "---\ntitle: x\ntags: [a]\n---\nbody",
        ["b", "c"],
      );
      expect(out).toBe("---\ntitle: x\ntags: [b, c]\n---\nbody");
    });

    it("appends tags when front matter lacks the field", () => {
      const out = setTagsInContent(
        "---\ntitle: x\n---\nbody",
        ["new"],
      );
      expect(out).toBe("---\ntitle: x\ntags: [new]\n---\nbody");
    });

    it("quotes tags that contain spaces or special characters", () => {
      const out = setTagsInContent("body", ["hello world", "ok"]);
      expect(out).toContain('tags: ["hello world", ok]');
    });

    it("dedupes inputs", () => {
      const out = setTagsInContent("body", ["a", "a", "b"]);
      expect(out).toContain("tags: [a, b]");
    });
  });

  describe("addTagToContent / removeTagFromContent", () => {
    it("addTagToContent appends a new tag", () => {
      const out = addTagToContent("---\ntags: [a]\n---\nbody", "b");
      expect(getTagsFromContent(out)).toEqual(["a", "b"]);
    });

    it("addTagToContent is a no-op when the tag already exists", () => {
      const before = "---\ntags: [a, b]\n---\nbody";
      expect(addTagToContent(before, "a")).toBe(before);
    });

    it("addTagToContent ignores empty input", () => {
      expect(addTagToContent("body", "   ")).toBe("body");
    });

    it("removeTagFromContent strips the tag", () => {
      const out = removeTagFromContent(
        "---\ntags: [a, b, c]\n---\nbody",
        "b",
      );
      expect(getTagsFromContent(out)).toEqual(["a", "c"]);
    });

    it("removeTagFromContent is a no-op when the tag is absent", () => {
      const before = "---\ntags: [a]\n---\nbody";
      expect(removeTagFromContent(before, "missing")).toBe(before);
    });
  });

  describe("block-list tags", () => {
    const block = '---\ntitle: T\ntags:\n    - one\n    - "two words"\n    - \'it\'\'s\'\npinned: true\n---\nbody';

    it("reads block lists (indented or not, quoted items)", () => {
      expect(getTagsFromContent(block)).toEqual(["one", "two words", "it's"]);
      expect(getTagsFromContent("---\ntags:\n- a\n\n# c\n- b\nx: 1\n---\n")).toEqual(["a", "b"]);
    });

    it("reads CRLF block lists", () => {
      expect(getTagsFromContent("---\r\ntags:\r\n  - a\r\n  - b\r\n---\r\nbody")).toEqual([
        "a",
        "b",
      ]);
    });

    it("addTag keeps block style and indent", () => {
      expect(addTagToContent(block, "new")).toBe(
        '---\ntitle: T\ntags:\n    - one\n    - "two words"\n    - "it\'s"\n    - new\npinned: true\n---\nbody',
      );
    });

    it("removeTag keeps block style; removing the last drops the entry", () => {
      const doc = "---\r\ntags:\r\n  - a\r\n  - b\r\nx: 1\r\n---\r\nbody";
      expect(removeTagFromContent(doc, "a")).toBe("---\r\ntags:\r\n  - b\r\nx: 1\r\n---\r\nbody");
      expect(setTagsInContent(doc, [])).toBe("---\r\nx: 1\r\n---\r\nbody");
    });

    it("flow lists stay flow and new entries are flow", () => {
      expect(addTagToContent("---\ntags: [a]\n---\n", "b")).toBe("---\ntags: [a, b]\n---\n");
      expect(addTagToContent("---\ntitle: x\n---\n", "b")).toBe(
        "---\ntitle: x\ntags: [b]\n---\n",
      );
    });

    it("flow lists honour quoted commas and escapes", () => {
      expect(getTagsFromContent('---\ntags: ["a, b", \'c\', "q\\"x"]\n---\n')).toEqual([
        "a, b",
        "c",
        'q"x',
      ]);
    });

    it("pinned and other fields are untouched by tag edits", () => {
      const out = addTagToContent(block, "z");
      expect(isPinnedInContent(out)).toBe(true);
      expect(setPinnedInContent(out, false)).toContain("    - z\npinned: false");
    });
  });
});
