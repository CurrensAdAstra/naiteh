import {
  defaultAiConfig,
  DEFAULT_APPEARANCE,
  DEFAULT_CLIPPING,
  type AiProviderId,
  type AiSettings,
  type AppConfig,
  type AppearanceConfig,
  type ClippingConfig,
} from "../types";
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
    ai: defaultAiConfig(),
    appearance: { ...DEFAULT_APPEARANCE },
    clipping: { ...DEFAULT_CLIPPING },
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

/** Replace the chat settings (`AppConfig.ai` minus the providers). */
export function appConfigSetAi(settings: AiSettings): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    const defaults = defaultWebConfig();
    return Promise.resolve({
      ...defaults,
      ai: { ...defaults.ai, ...settings },
    });
  }
  return invoke<AppConfig>("app_config_set_ai", { settings });
}

/**
 * Update one provider. The API key is write-only: the backend only
 * reports `hasApiKey`.
 *
 * - `apiKey` non-empty → replace the stored key
 * - `apiKey: null`, `clearApiKey: false` → keep the stored key
 * - `clearApiKey: true` → remove the stored key
 * - `baseUrl: null` → keep the stored endpoint
 */
export interface AiProviderUpdate {
  provider: AiProviderId;
  baseUrl: string | null;
  apiKey: string | null;
  clearApiKey: boolean;
}

export function appConfigSetAiProvider(
  update: AiProviderUpdate,
): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    const defaults = defaultWebConfig();
    const current = defaults.ai.providers[update.provider];
    return Promise.resolve({
      ...defaults,
      ai: {
        ...defaults.ai,
        providers: {
          ...defaults.ai.providers,
          [update.provider]: {
            hasApiKey: !update.clearApiKey && update.apiKey !== null,
            baseUrl: update.baseUrl ?? current.baseUrl,
          },
        },
      },
    });
  }
  return invoke<AppConfig>("app_config_set_ai_provider", {
    provider: update.provider,
    baseUrl: update.baseUrl,
    apiKey: update.apiKey,
    clearApiKey: update.clearApiKey,
  });
}

/** Update palette + font families (empty font = built-in default). */
export function appConfigSetAppearance(
  appearance: AppearanceConfig,
): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    return Promise.resolve({ ...defaultWebConfig(), appearance });
  }
  return invoke<AppConfig>("app_config_set_appearance", {
    palette: appearance.palette,
    uiFont: appearance.uiFont,
    editorFont: appearance.editorFont,
  });
}

/** Replace the HTML → Markdown clipping options. */
export function appConfigSetClipping(
  clipping: ClippingConfig,
): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    return Promise.resolve({ ...defaultWebConfig(), clipping });
  }
  return invoke<AppConfig>("app_config_set_clipping", { clipping });
}
