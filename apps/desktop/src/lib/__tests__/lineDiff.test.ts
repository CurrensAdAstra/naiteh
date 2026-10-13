import { describe, expect, it } from "vitest";

import { diffLines, diffStats, splitLines } from "../lineDiff";

const kinds = (a: string, b: string) =>
  diffLines(a, b).map((l) => `${l.kind === "same" ? " " : l.kind === "add" ? "+" : "-"}${l.text}`);

describe("lineDiff", () => {
  it("splits lines, normalizing CRLF and ignoring the final newline", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\rb")).toEqual(["a", "b"]);
  });

  it("reports identical text as all same, with line numbers", () => {
    const out = diffLines("a\nb\n", "a\nb\n");
    expect(out).toEqual([
      { kind: "same", text: "a", oldLine: 1, newLine: 1 },
      { kind: "same", text: "b", oldLine: 2, newLine: 2 },
    ]);
  });

  it("finds a changed middle line", () => {
    expect(kinds("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
  });

  it("handles insertions and deletions via LCS", () => {
    expect(kinds("a\nb\nc\nd", "a\nc\nd\ne")).toEqual([" a", "-b", " c", " d", "+e"]);
    expect(kinds("x\na\ny\nb", "a\nb")).toEqual(["-x", " a", "-y", " b"]);
  });

  it("treats an empty side as a full add / delete", () => {
    expect(kinds("", "a\nb")).toEqual(["+a", "+b"]);
    expect(kinds("a", "")).toEqual(["-a"]);
  });

  it("numbers lines on each side", () => {
    const out = diffLines("a\nb\nc", "a\nx\ny\nc");
    expect(out.at(-1)).toEqual({ kind: "same", text: "c", oldLine: 3, newLine: 4 });
    expect(out.find((l) => l.kind === "add" && l.text === "y")?.newLine).toBe(3);
  });

  it("counts added and removed lines", () => {
    expect(diffStats(diffLines("a\nb\nc", "a\nB\nc\nd"))).toEqual({ added: 2, removed: 1 });
  });
});
