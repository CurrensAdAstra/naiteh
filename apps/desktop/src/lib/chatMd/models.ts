import {
  AI_PROVIDERS,
  DEFAULT_BASE_URLS,
  type AiConfig,
  type AiProviderId,
} from "../types";

const KEYLESS: readonly AiProviderId[] = ["ollama", "lmstudio"];

/** Explicit registrations, or the effective providers of an older config. */
export function addedProviders(ai: AiConfig | undefined): AiProviderId[] {
  if (ai === undefined) return [];
  if (ai.addedProviders !== undefined) {
    return [...new Set(ai.addedProviders)].filter((id) =>
      AI_PROVIDERS.includes(id),
    );
  }
  return AI_PROVIDERS.filter(
    (id) =>
      ai.providers[id]?.hasApiKey ||
      (KEYLESS.includes(id) &&
        (ai.defaultModel.startsWith(`${id}@`) ||
          (ai.providers[id] !== undefined &&
            ai.providers[id].baseUrl.replace(/\/+$/, "") !==
              DEFAULT_BASE_URLS[id].replace(/\/+$/, "")))),
  );
}

/** Added providers whose models can be listed: a saved key or a local API. */
export function configuredProviders(ai: AiConfig | undefined): AiProviderId[] {
  return addedProviders(ai).filter(
    (id) => KEYLESS.includes(id) || ai?.providers[id]?.hasApiKey === true,
  );
}

/** `provider@model` shape check (the provider part is lower-case letters). */
export function isModelId(value: string): boolean {
  return /^[a-z]+@\S+$/.test(value.trim());
}
