import { invoke } from "@tauri-apps/api/core";

import type { AppConfig } from "../types";

export function appConfigGet(): Promise<AppConfig> {
  return invoke<AppConfig>("app_config_get");
}

export function appConfigSetEditor(
  fontSize: number,
  lineWrapping: boolean,
): Promise<AppConfig> {
  return invoke<AppConfig>("app_config_set_editor", {
    fontSize,
    lineWrapping,
  });
}
