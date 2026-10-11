import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultAiConfig } from "../../../lib/types";

import {
  DEFAULT_APPEARANCE,
  DEFAULT_CLIPPING,
  type AppConfig,
  type AppearanceConfig,
} from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import { FONT_PRESETS, validateFontFamily } from "../../../styles/fontPresets";
import { AppearanceSection } from "../sections/AppearanceSection";

vi.mock("../../../lib/api/settings", () => ({
  appConfigGet: vi.fn(),
  appConfigSetAppearance: vi.fn(),
}));

import { appConfigGet, appConfigSetAppearance } from "../../../lib/api/settings";

const mockedSet = vi.mocked(appConfigSetAppearance);
const mockedGet = vi.mocked(appConfigGet);

function makeConfig(appearance: AppearanceConfig = DEFAULT_APPEARANCE): AppConfig {
  return {
    activeVault: null,
    knownVaults: [],
    theme: "light",
    editor: { fontSize: 14, lineWrapping: true },
    calendar: { subView: "timeline" },
    journal: { splitRatio: 0.5 },
    ai: defaultAiConfig(),
    appearance: { ...appearance },
    clipping: { ...DEFAULT_CLIPPING },
  } as AppConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSet.mockImplementation(async (a) => makeConfig(a));
  useSettingsStore.setState({ config: makeConfig(), loading: false });
});

describe("AppearanceSection", () => {
  it("renders a radio card per palette with the stored one checked", () => {
    useSettingsStore.setState({
      config: makeConfig({ ...DEFAULT_APPEARANCE, palette: "forest" }),
    });
    render(<AppearanceSection />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(8);
    expect(screen.getByRole("radio", { name: "Forest" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Default" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("saves a palette immediately on click and updates the store", async () => {
    render(<AppearanceSection />);
    await userEvent.click(screen.getByRole("radio", { name: "Nord" }));
    expect(mockedSet).toHaveBeenCalledWith({ ...DEFAULT_APPEARANCE, palette: "nord" });
    await waitFor(() =>
      expect(useSettingsStore.getState().config?.appearance.palette).toBe("nord"),
    );
    expect(screen.getByRole("radio", { name: "Nord" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("moves selection with arrow keys", async () => {
    render(<AppearanceSection />);
    const first = screen.getByRole("radio", { name: "Default" });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(mockedSet).toHaveBeenCalledWith({ ...DEFAULT_APPEARANCE, palette: "ocean" });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Ocean" })).toHaveFocus(),
    );
  });

  it("shows an error and refreshes when saving fails", async () => {
    mockedSet.mockRejectedValueOnce(new Error("boom"));
    mockedGet.mockResolvedValue(makeConfig());
    render(<AppearanceSection />);
    await userEvent.click(screen.getByRole("radio", { name: "Rose" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(mockedGet).toHaveBeenCalled();
  });

  it("saves a font preset's full stack", async () => {
    render(<AppearanceSection />);
    const inter = FONT_PRESETS.find((p) => p.id === "inter")!;
    await userEvent.selectOptions(screen.getByLabelText("Interface font"), "inter");
    expect(mockedSet).toHaveBeenCalledWith({ ...DEFAULT_APPEARANCE, uiFont: inter.stack });
    await waitFor(() =>
      expect(screen.getByTestId("uiFont-preview").style.fontFamily).toContain("Inter"),
    );
  });

  it("shows the matching preset for a stored stack", () => {
    const d2 = FONT_PRESETS.find((p) => p.id === "d2coding")!;
    useSettingsStore.setState({
      config: makeConfig({ ...DEFAULT_APPEARANCE, editorFont: d2.stack }),
    });
    render(<AppearanceSection />);
    expect(screen.getByLabelText("Editor font")).toHaveValue("d2coding");
    expect(screen.queryByTestId("editorFont-custom")).toBeNull();
  });

  it("commits a custom font on Enter", async () => {
    render(<AppearanceSection />);
    await userEvent.selectOptions(screen.getByLabelText("Editor font"), "custom");
    expect(mockedSet).not.toHaveBeenCalled();
    const input = screen.getByTestId("editorFont-custom");
    await userEvent.type(input, '"My Font", serif{Enter}');
    expect(mockedSet).toHaveBeenCalledWith({
      ...DEFAULT_APPEARANCE,
      editorFont: '"My Font", serif',
    });
  });

  it("rejects forbidden characters inline without saving", async () => {
    render(<AppearanceSection />);
    await userEvent.selectOptions(screen.getByLabelText("Interface font"), "custom");
    const input = screen.getByTestId("uiFont-custom");
    await userEvent.type(input, "Arial; color: red");
    fireEvent.blur(input);
    expect(await screen.findByRole("alert")).toHaveTextContent('";"');
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(mockedSet).not.toHaveBeenCalled();
  });

  it("opens custom mode for a stored non-preset stack", () => {
    useSettingsStore.setState({
      config: makeConfig({ ...DEFAULT_APPEARANCE, uiFont: "Comic Sans MS" }),
    });
    render(<AppearanceSection />);
    expect(screen.getByLabelText("Interface font")).toHaveValue("custom");
    expect(screen.getByTestId("uiFont-custom")).toHaveValue("Comic Sans MS");
  });
});

describe("validateFontFamily", () => {
  it("accepts every preset stack", () => {
    for (const p of FONT_PRESETS) expect(validateFontFamily(p.stack)).toBeNull();
  });

  it("rejects forbidden characters, control chars and overlong values", () => {
    for (const bad of ["a;b", "a{", "a}", "<x>", "a\\b", "a\nb", "x".repeat(201)]) {
      expect(validateFontFamily(bad)).not.toBeNull();
    }
  });
});
