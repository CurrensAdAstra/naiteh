import { invoke } from "@tauri-apps/api/core";

import type { AppConfig } from "../types";

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return true;
  const maybeWindow = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

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
      apiKey: null,
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

export function appConfigSetAi(
  apiKey: string | null,
  model: string,
  baseUrl: string | null,
): Promise<AppConfig> {
  if (!hasTauriRuntime()) {
    return Promise.resolve({
      ...defaultWebConfig(),
      ai: {
        apiKey,
        model,
        baseUrl: baseUrl ?? "https://api.openai.com/v1",
      },
    });
  }
  return invoke<AppConfig>("app_config_set_ai", {
    apiKey,
    model,
    baseUrl,
  });
}
