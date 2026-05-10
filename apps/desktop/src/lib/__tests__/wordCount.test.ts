import { describe, expect, it } from "vitest";

import { countWords } from "../wordCount";

describe("countWords", () => {
  it("counts whitespace-separated tokens", () => {
    expect(countWords("hello world this is naiteh")).toBe(5);
  });

  it("returns 0 for empty / whitespace-only input", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("    \n\t  ")).toBe(0);
  });

  it("excludes front matter from the count", () => {
    const doc = "---\ntitle: Big\ntags: [a, b, c]\n---\nhello world";
    expect(countWords(doc)).toBe(2);
  });

  it("counts correctly when front matter is malformed (no closing fence)", () => {
    const doc = "---\nstart but never close\nhello world";
    // We give up isolating front matter and count the whole document.
    // Tokens: ['---', 'start', 'but', 'never', 'close', 'hello', 'world'].
    expect(countWords(doc)).toBe(7);
  });

  it("treats consecutive newlines as one separator", () => {
    expect(countWords("a\n\nb\n\n\nc")).toBe(3);
  });
});
