import { describe, expect, it } from "vitest";

import {
  aiBaseIsLocal,
  aiReady,
  OLLAMA_BASE_URL,
  OPENAI_BASE_URL,
  validateAiBaseUrl,
} from "../aiProvider";
import type { AiConfig } from "../types";

function ai(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    hasApiKey: false,
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

describe("validateAiBaseUrl", () => {
  it("accepts https anywhere and http only on loopback", () => {
    expect(validateAiBaseUrl(OPENAI_BASE_URL)).toBeNull();
    expect(validateAiBaseUrl("https://llm.example.com:8443/v1")).toBeNull();
    expect(validateAiBaseUrl("http://localhost:11434/v1")).toBeNull();
    expect(validateAiBaseUrl("http://127.0.0.1:1234/v1")).toBeNull();
    expect(validateAiBaseUrl("http://[::1]:1234/v1")).toBeNull();
  });

  it("rejects plain http to a remote host", () => {
    expect(validateAiBaseUrl("http://api.example.com/v1")).toMatch(
      /only allowed for localhost/i,
    );
  });

  it("rejects empty, unparseable and non-http schemes", () => {
    expect(validateAiBaseUrl("  ")).toMatch(/enter an endpoint/i);
    expect(validateAiBaseUrl("api.openai.com")).toMatch(/full URL/i);
    expect(validateAiBaseUrl("ftp://example.com")).toMatch(/https:\/\//);
  });
});

describe("aiReady", () => {
  it("local provider needs only a model, no key", () => {
    expect(aiReady(ai({ hasApiKey: false, baseUrl: OLLAMA_BASE_URL }))).toBe(
      true,
    );
  });

  it("hosted provider needs a key", () => {
    expect(aiReady(ai({ hasApiKey: false, baseUrl: OPENAI_BASE_URL }))).toBe(
      false,
    );
    expect(aiReady(ai({ hasApiKey: true, baseUrl: OPENAI_BASE_URL }))).toBe(
      true,
    );
  });

  it("is never ready without a model", () => {
    expect(aiReady(ai({ model: "  ", baseUrl: OLLAMA_BASE_URL }))).toBe(false);
    expect(
      aiReady(ai({ model: "", hasApiKey: true, baseUrl: OPENAI_BASE_URL })),
    ).toBe(false);
  });
});
