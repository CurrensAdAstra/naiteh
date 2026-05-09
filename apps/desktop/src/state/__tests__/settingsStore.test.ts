import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api/settings", () => ({
  appConfigGet: vi.fn(),
}));

import { appConfigGet } from "../../lib/api/settings";
import {
  EDITOR_FONT_DEFAULT,
  type AppConfig,
} from "../../lib/types";
import { selectEditorConfig, useSettingsStore } from "../settingsStore";

const mockedGet = vi.mocked(appConfigGet);

function config(): AppConfig {
  return {
    activeVault: "/v",
    knownVaults: ["/v"],
    theme: "light",
    editor: { fontSize: 18, lineWrapping: false },
    calendar: { subView: "timeline" },
    journal: { splitRatio: 0.5 },
    ai: {
      apiKey: null,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
  };
}

describe("settingsStore", () => {
  beforeEach(() => {
    mockedGet.mockReset();
    useSettingsStore.setState({ config: null, loading: true });
  });

  it("starts in a loading state with no config", () => {
    expect(useSettingsStore.getState().config).toBeNull();
    expect(useSettingsStore.getState().loading).toBe(true);
  });

  it("selectEditorConfig falls back to defaults while loading", () => {
    expect(selectEditorConfig(useSettingsStore.getState())).toEqual({
      fontSize: EDITOR_FONT_DEFAULT,
      lineWrapping: true,
    });
  });

  it("refresh populates config from the backend", async () => {
    mockedGet.mockResolvedValue(config());
    await useSettingsStore.getState().refresh();
    expect(useSettingsStore.getState().config?.editor.fontSize).toBe(18);
    expect(useSettingsStore.getState().loading).toBe(false);
  });

  it("refresh failure leaves config unchanged but exits loading", async () => {
    useSettingsStore.setState({ config: config(), loading: false });
    mockedGet.mockRejectedValue({ kind: "Io", message: "boom" });
    await useSettingsStore.getState().refresh();
    expect(useSettingsStore.getState().config?.editor.fontSize).toBe(18);
    expect(useSettingsStore.getState().loading).toBe(false);
  });

  it("setConfig updates the config and clears loading", () => {
    useSettingsStore.getState().setConfig(config());
    expect(useSettingsStore.getState().loading).toBe(false);
    expect(useSettingsStore.getState().config?.editor.lineWrapping).toBe(false);
  });
});
