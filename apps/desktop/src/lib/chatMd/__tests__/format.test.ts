import { describe, expect, it } from "vitest";

import {
  getFrontMatterField,
  replaceBody,
  setFrontMatterField,
} from "../../frontMatter";
import { chatHeader, chatTitle, parseRoleHeading, roleLabel } from "../format";
import { configuredProviders, isModelId } from "../models";
import { defaultAiConfig } from "../../types";

describe("chatHeader (chatgpt-md getHeaderRole)", () => {
  it("formats an assistant header with the model", () => {
    expect(chatHeader("assistant", 3, "openai@gpt-4.1-mini")).toBe(
      '\n\n<hr class="__chatgpt_plugin">\n\n### role::assistant<span style="font-size: small;"> (openai@gpt-4.1-mini)</span>\n\n',
    );
  });

  it("formats a user header without a model and clamps the level", () => {
    expect(chatHeader("user", 1)).toBe(
      '\n\n<hr class="__chatgpt_plugin">\n\n# role::user\n\n',
    );
    expect(chatHeader("user", 9)).toContain("###### role::user");
    expect(chatHeader("user", 0)).toContain("\n# role::user");
  });
});

describe("role headings", () => {
  it("parses role and model", () => {
    expect(parseRoleHeading("role::assistant (openai@gpt-x)")).toEqual({
      role: "assistant",
      model: "openai@gpt-x",
    });
    expect(parseRoleHeading("role::user")).toEqual({ role: "user", model: null });
    expect(parseRoleHeading("A normal heading")).toBeNull();
    expect(roleLabel("user")).toBe("You");
    expect(roleLabel("assistant")).toBe("Assistant");
  });

  it("titles new chats like chatgpt-md", () => {
    expect(chatTitle(new Date(2026, 0, 5, 7, 3))).toBe("Chat 2026-01-05 0703");
  });
});

describe("front-matter fields", () => {
  it("reads, upserts and removes scalar fields", () => {
    const doc = '---\ntitle: "A: b"\nmodel: openai@x\n---\nbody';
    expect(getFrontMatterField(doc, "title")).toBe("A: b");
    expect(getFrontMatterField(doc, "missing")).toBeNull();
    expect(setFrontMatterField(doc, "model", "ollama@llama3")).toBe(
      '---\ntitle: "A: b"\nmodel: ollama@llama3\n---\nbody',
    );
    expect(setFrontMatterField(doc, "model", null)).toBe(
      '---\ntitle: "A: b"\n---\nbody',
    );
    expect(setFrontMatterField("plain", "model", "openai@x")).toBe(
      "---\nmodel: openai@x\n---\nplain",
    );
  });

  it("keeps CRLF line endings", () => {
    expect(setFrontMatterField("---\r\na: 1\r\n---\r\nx", "b", "2")).toBe(
      "---\r\na: 1\r\nb: 2\r\n---\r\nx",
    );
  });

  it("replaceBody keeps the front matter verbatim", () => {
    expect(replaceBody("---\na: 1\n---\nold", "")).toBe("---\na: 1\n---\n");
    expect(replaceBody("no block", "new")).toBe("new");
  });
});

describe("models", () => {
  it("lists only providers with a key, plus the local ones", () => {
    const ai = defaultAiConfig();
    expect(configuredProviders(ai)).toEqual(["ollama", "lmstudio"]);
    ai.providers.anthropic = { ...ai.providers.anthropic, hasApiKey: true };
    expect(configuredProviders(ai)).toEqual(["anthropic", "ollama", "lmstudio"]);
    expect(isModelId("openai@gpt-4o")).toBe(true);
    expect(isModelId("gpt-4o")).toBe(false);
  });
});
