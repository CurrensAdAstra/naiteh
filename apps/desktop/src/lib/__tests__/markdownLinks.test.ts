import { describe, expect, it } from "vitest";

import {
  candidatePaths,
  classifyLink,
  dirOf,
  imageSource,
  normalizeRelPath,
  slugify,
} from "../markdownLinks";

describe("markdownLinks", () => {
  it("dirOf returns the parent folder", () => {
    expect(dirOf("notes/a/b.md")).toBe("notes/a");
    expect(dirOf("b.md")).toBe("");
  });

  it("normalizeRelPath collapses dots and refuses escapes", () => {
    expect(normalizeRelPath("notes/./a/../b.md")).toBe("notes/b.md");
    expect(normalizeRelPath("notes\\a.md")).toBe("notes/a.md");
    expect(normalizeRelPath("//notes//a.md")).toBe("notes/a.md");
    expect(normalizeRelPath("../outside.md")).toBeNull();
    expect(normalizeRelPath("notes/../../x")).toBeNull();
    expect(normalizeRelPath("./")).toBeNull();
  });

  it("candidatePaths tries note-relative, then vault-relative", () => {
    expect(candidatePaths("notes/trip/index.md", "photo.png")).toEqual([
      "notes/trip/photo.png",
      "photo.png",
    ]);
    expect(
      candidatePaths("notes/a.md", "attachments/shot.png"),
    ).toEqual(["notes/attachments/shot.png", "attachments/shot.png"]);
    expect(candidatePaths("notes/a/b.md", "../c.md")).toEqual(["notes/c.md"]);
    expect(candidatePaths("notes/a.md", "/attachments/x.png")).toEqual([
      "attachments/x.png",
    ]);
  });

  it("candidatePaths decodes percent-encoding", () => {
    expect(candidatePaths("notes/a.md", "my%20photo.png")).toEqual([
      "notes/my photo.png",
      "my photo.png",
    ]);
  });

  it("classifyLink routes by scheme and extension", () => {
    expect(classifyLink("https://example.com", "notes/a.md")).toEqual({
      kind: "external",
      url: "https://example.com",
    });
    expect(classifyLink("mailto:a@b.c", "notes/a.md").kind).toBe("external");
    expect(classifyLink("#Next Steps", "notes/a.md")).toEqual({
      kind: "anchor",
      id: "Next Steps",
    });
    expect(classifyLink("other.md#part", "notes/a.md")).toEqual({
      kind: "document",
      candidates: ["notes/other.md", "other.md"],
    });
    expect(classifyLink("attachments/doc.pdf", "notes/a.md").kind).toBe("file");
  });

  it("classifyLink blocks dangerous or empty targets", () => {
    for (const href of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "vbscript:x",
      "file:///etc/passwd",
      "C:/Windows/win.ini",
      "data:text/html,<script>",
      "",
      undefined,
      "../../outside.md",
    ]) {
      expect(classifyLink(href, "notes/a.md")).toEqual({ kind: "blocked" });
    }
  });

  it("imageSource distinguishes data, remote, vault and blocked", () => {
    expect(imageSource("data:image/png;base64,AAA", "notes/a.md")).toEqual({
      kind: "data",
      url: "data:image/png;base64,AAA",
    });
    expect(imageSource("https://x.test/a.png", "notes/a.md").kind).toBe(
      "remote",
    );
    expect(imageSource("attachments/a.png", "notes/a.md")).toEqual({
      kind: "vault",
      candidates: ["notes/attachments/a.png", "attachments/a.png"],
    });
    expect(imageSource("javascript:x", "notes/a.md").kind).toBe("blocked");
    expect(imageSource("data:text/html,x", "notes/a.md").kind).toBe("blocked");
  });

  it("slugify matches GitHub-style heading ids", () => {
    expect(slugify("Next Steps!")).toBe("next-steps");
    expect(slugify("  다음 단계 (2) ")).toBe("다음-단계-2");
    expect(slugify("a_b-c")).toBe("a_b-c");
  });
});
