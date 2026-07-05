import { describe, expect, it } from "vitest";

import {
  codeBlockLanguages,
  resolveFenceLanguage,
} from "../codeBlockLanguages";

describe("codeBlockLanguages registry", () => {
  it("covers the common languages", () => {
    for (const name of [
      "python",
      "rust",
      "typescript",
      "javascript",
      "go",
      "sql",
      "json",
      "yaml",
      "html",
      "css",
      "shell",
    ]) {
      expect(resolveFenceLanguage(name), name).not.toBeNull();
    }
  });

  it("honours aliases and extension-style infos", () => {
    expect(resolveFenceLanguage("js")?.name).toBe("JavaScript");
    expect(resolveFenceLanguage("ts")?.name).toBe("TypeScript");
    // Not an alias — resolved via the extension fallback.
    expect(resolveFenceLanguage("py")?.name).toBe("Python");
    expect(resolveFenceLanguage("rs")?.name).toBe("Rust");
  });

  it("returns null for unknown or empty info strings", () => {
    expect(resolveFenceLanguage("definitely-not-a-language")).toBeNull();
    expect(resolveFenceLanguage("")).toBeNull();
    expect(resolveFenceLanguage("   ")).toBeNull();
  });

  it("lazy-loads a real parser for a resolved language", async () => {
    const desc = resolveFenceLanguage("python");
    expect(desc).not.toBeNull();
    const lang = await desc!.load();
    // A loaded LanguageSupport carries the language whose parser can
    // actually tokenize source — presence of `language` is the contract
    // the markdown nesting relies on.
    expect(lang.language).toBeDefined();
  });

  it("registry is non-trivially large (language-data wired, not a stub)", () => {
    expect(codeBlockLanguages.length).toBeGreaterThan(50);
  });
});
