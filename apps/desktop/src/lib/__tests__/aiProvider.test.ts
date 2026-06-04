import { describe, expect, it } from "vitest";

import {
  aiBaseIsLocal,
  aiReady,
  OLLAMA_BASE_URL,
  OPENAI_BASE_URL,
} from "../aiProvider";
import type { AiConfig } from "../types";

function ai(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    apiKey: null,
    model: "llama3.2",
    baseUrl: OLLAMA_BASE_URL,
    ...overrides,
  };
}

describe("aiBaseIsLocal", () => {
  it("recognises localhost / loopback hosts", () => {
    expect(aiBaseIsLocal("http://localhost:11434/v1")).toBe(true);
    expect(aiBaseIsLocal("http://127.0.0.1:11434/v1")).toBe(true);
    expect(aiBaseIsLocal("http://[::1]:11434/v1")).toBe(true);
  });

  it("treats hosted endpoints as non-local", () => {
    expect(aiBaseIsLocal(OPENAI_BASE_URL)).toBe(false);
    expect(aiBaseIsLocal("https://api.example.com/v1")).toBe(false);
  });

  it("returns false for an unparseable URL", () => {
    expect(aiBaseIsLocal("not a url")).toBe(false);
  });
});

describe("aiReady", () => {
  it("local provider needs only a model, no key", () => {
    expect(aiReady(ai({ apiKey: null, baseUrl: OLLAMA_BASE_URL }))).toBe(true);
  });

  it("hosted provider needs a key", () => {
    expect(
      aiReady(ai({ apiKey: null, baseUrl: OPENAI_BASE_URL })),
    ).toBe(false);
    expect(
      aiReady(ai({ apiKey: "sk-x", baseUrl: OPENAI_BASE_URL })),
    ).toBe(true);
  });

  it("is never ready without a model", () => {
    expect(aiReady(ai({ model: "  ", baseUrl: OLLAMA_BASE_URL }))).toBe(false);
    expect(
      aiReady(ai({ model: "", apiKey: "sk-x", baseUrl: OPENAI_BASE_URL })),
    ).toBe(false);
  });
});
