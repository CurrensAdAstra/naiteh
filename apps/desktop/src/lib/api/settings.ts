import type { AppConfig } from "../types";
import { hasTauriRuntime, invoke } from "./invoke";

function defaultWebConfig(): AppConfig {
  return {
    activeVault: null,
    knownVaults: [],
    theme: "light",
    editor: {
      fontSize: 14,
      lineWrapping: true,
    },
    calendar: {
      subView: "timeline",
    },
    journal: {
      splitRatio: 0.5,
    },
    ai: {
      hasApiKey: false,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
  };
}

export function appConfigGet(): Promise<AppConfig> {
  if (!hasTauriRuntime()) return Promise.resolve(defaultWebConfig());
  return invoke<AppConfig>("app_config_get");
}

export function appConfigSetEditor(
  fontSize: number,
  lineWrapping: boolean,
): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    return Promise.resolve({
      ...defaultWebConfig(),
      editor: { fontSize, lineWrapping },
    });
  }
  return invoke<AppConfig>("app_config_set_editor", {
    fontSize,
    lineWrapping,
  });
}

/**
 * Update AI Assist settings. The API key is write-only: the backend
 * never returns it (only `ai.hasApiKey`).
 *
 * - `apiKey` non-empty → replace the stored key
 * - `apiKey: null`, `clearApiKey: false` → keep the stored key
 * - `clearApiKey: true` → remove the stored key
 * - `baseUrl: null` → keep the stored endpoint
 */
export interface AiSettingsUpdate {
  apiKey: string | null;
  clearApiKey: boolean;
  model: string;
  baseUrl: string | null;
}

export function appConfigSetAi(update: AiSettingsUpdate): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    const defaults = defaultWebConfig();
    return Promise.resolve({
      ...defaults,
      ai: {
        hasApiKey: !update.clearApiKey && update.apiKey !== null,
        model: update.model,
        baseUrl: update.baseUrl ?? defaults.ai.baseUrl,
      },
    });
  }
  return invoke<AppConfig>("app_config_set_ai", {
    apiKey: update.apiKey,
    clearApiKey: update.clearApiKey,
    model: update.model,
    baseUrl: update.baseUrl,
  });
}
