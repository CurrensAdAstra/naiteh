import type { AiConfig } from "./types";

/** OpenAI-compatible base URL for a default local Ollama install. */
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * True when the AI base URL points at the local machine (Ollama, LM
 * Studio, etc.). Local providers need no API key, so the "ready" check
 * and the Settings UI treat them differently from a hosted API.
 */
export function aiBaseIsLocal(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Client-side mirror of the backend's endpoint rule: `https://` for any
 * host, plain `http://` only for this machine (localhost, 127.0.0.1,
 * [::1]) so an API key or note text never crosses the network
 * unencrypted. Returns an error message, or `null` when the URL is fine.
 */
export function validateAiBaseUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return "Enter an endpoint URL.";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "Endpoint must be a full URL, e.g. https://api.openai.com/v1.";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    if (isLoopbackHost(url.hostname)) return null;
    return "Plain http:// is only allowed for localhost, 127.0.0.1 or [::1]. Use https:// for remote endpoints.";
  }
  return "Endpoint must start with https:// (or http:// for localhost).";
}

/**
 * Whether AI Assist can run: a model is set, and either an API key is
 * configured or the provider is local (key-free).
 */
export function aiReady(ai: AiConfig): boolean {
  const hasModel = ai.model.trim() !== "";
  return hasModel && (ai.hasApiKey || aiBaseIsLocal(ai.baseUrl));
}
