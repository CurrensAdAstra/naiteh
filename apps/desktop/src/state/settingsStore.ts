import { create } from "zustand";

import { appConfigGet } from "../lib/api/settings";
import {
  EDITOR_FONT_DEFAULT,
  type AppConfig,
  type EditorConfig,
} from "../lib/types";

const DEFAULT_EDITOR: EditorConfig = {
  fontSize: EDITOR_FONT_DEFAULT,
  lineWrapping: true,
};

interface SettingsState {
  config: AppConfig | null;
  /** True until the first successful fetch from the backend. */
  loading: boolean;
  setConfig: (config: AppConfig) => void;
  /** Pull current config from the backend; safe to call repeatedly. */
  refresh: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  config: null,
  loading: true,
  setConfig: (config) => set({ config, loading: false }),
  refresh: async () => {
    try {
      const config = await appConfigGet();
      set({ config, loading: false });
    } catch {
      // Leave the previous config in place; UI surfaces errors per-action.
      set({ loading: false });
    }
  },
}));

/**
 * Resolve the editor preferences out of the store, falling back to the
 * documented defaults while the config is still loading or unavailable.
 */
export function selectEditorConfig(state: SettingsState): EditorConfig {
  return state.config?.editor ?? DEFAULT_EDITOR;
}
