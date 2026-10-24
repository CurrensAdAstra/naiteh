import {
  DEFAULT_AI_SETTINGS,
  type AiProviderId,
  type AiSettings,
} from "../../../lib/types";

export const PROVIDER_NAMES: Record<AiProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  zai: "Z.ai",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
};

export function isLocalProvider(id: AiProviderId): boolean {
  return id === "ollama" || id === "lmstudio";
}

/** Scalar updates leave provider registrations and credentials alone. */
export function settingsOf(ai: AiSettings | undefined): AiSettings {
  const source = ai ?? DEFAULT_AI_SETTINGS;
  return {
    defaultModel: source.defaultModel,
    temperature: source.temperature,
    maxTokens: source.maxTokens,
    stream: source.stream,
    headingLevel: source.headingLevel,
    inferTitleLanguage: source.inferTitleLanguage,
    chatsFolder: source.chatsFolder,
    agentsFolder: source.agentsFolder,
  };
}
