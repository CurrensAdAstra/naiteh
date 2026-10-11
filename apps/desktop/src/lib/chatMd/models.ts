import { AI_PROVIDERS, type AiConfig, type AiProviderId } from "../types";

const KEYLESS: readonly AiProviderId[] = ["ollama", "lmstudio"];

/** Providers whose models can be listed: a key is saved, or it is local. */
export function configuredProviders(ai: AiConfig | undefined): AiProviderId[] {
  if (ai === undefined) return [...KEYLESS];
  return AI_PROVIDERS.filter(
    (id) => KEYLESS.includes(id) || ai.providers[id]?.hasApiKey === true,
  );
}

/** `provider@model` shape check (the provider part is lower-case letters). */
export function isModelId(value: string): boolean {
  return /^[a-z]+@\S+$/.test(value.trim());
}
