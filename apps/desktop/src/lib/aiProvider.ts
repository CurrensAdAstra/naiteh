import type { AiConfig } from "./types";

/** OpenAI-compatible base URL for a default local Ollama install. */
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * True when the AI base URL points at the local machine (Ollama, LM
 * Studio, etc.). Local providers need no API key, so the "ready" check
 * and the Settings UI treat them differently from a hosted API.
 */
export function aiBaseIsLocal(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * Whether AI Assist can run: a model is set, and either an API key is
 * configured or the provider is local (key-free).
 */
export function aiReady(ai: AiConfig): boolean {
  const hasModel = ai.model.trim() !== "";
  const hasKey = ai.apiKey !== null && ai.apiKey.trim() !== "";
  return hasModel && (hasKey || aiBaseIsLocal(ai.baseUrl));
}
