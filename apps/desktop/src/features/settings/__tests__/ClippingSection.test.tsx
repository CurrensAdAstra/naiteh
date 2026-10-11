import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CLIPPING,
  type AppConfig,
  type ClippingConfig,
} from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import { ClippingSection } from "../sections/ClippingSection";

vi.mock("../../../lib/api/settings", () => ({
  appConfigGet: vi.fn(),
  appConfigSetClipping: vi.fn(),
}));

import { appConfigGet, appConfigSetClipping } from "../../../lib/api/settings";

const mockedSet = vi.mocked(appConfigSetClipping);
const mockedGet = vi.mocked(appConfigGet);

function configWith(clipping: ClippingConfig): AppConfig {
  return { clipping } as unknown as AppConfig;
}

describe("ClippingSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({
      config: configWith({ ...DEFAULT_CLIPPING }),
      loading: false,
    });
    mockedSet.mockImplementation((c) => Promise.resolve(configWith(c)));
  });

  it("shows the current values and a Markdown preview", () => {
    render(<ClippingSection />);
    expect(screen.getByTestId("clipping-htmlPaste")).toHaveValue("markdown");
    expect(screen.getByTestId("clipping-bulletMarker")).toHaveValue("-");
    const preview = screen.getByTestId("clipping-preview").textContent ?? "";
    expect(preview).toContain("# Clipped article");
    expect(preview).toContain("**bold**");
    expect(preview).toContain("```js");
    expect(preview).toContain("| Name");
    expect(screen.getByTestId("clipping-reset")).toBeDisabled();
  });

  it("saves an option immediately and updates the preview", async () => {
    render(<ClippingSection />);
    fireEvent.change(screen.getByTestId("clipping-bulletMarker"), {
      target: { value: "*" },
    });
    expect(mockedSet).toHaveBeenCalledWith({ ...DEFAULT_CLIPPING, bulletMarker: "*" });
    await waitFor(() =>
      expect(screen.getByTestId("clipping-preview").textContent).toContain(
        "* First item",
      ),
    );
    expect(screen.getByTestId("clipping-reset")).not.toBeDisabled();
  });

  it("disables conversion options unless converting to Markdown", async () => {
    useSettingsStore.setState({
      config: configWith({ ...DEFAULT_CLIPPING, htmlPaste: "html" }),
    });
    render(<ClippingSection />);
    expect(screen.getByTestId("clipping-tables")).toBeDisabled();
    expect(screen.getByTestId("clipping-preview").textContent).toContain(
      "<h1>Clipped article</h1>",
    );
    fireEvent.change(screen.getByTestId("clipping-htmlPaste"), {
      target: { value: "markdown" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("clipping-tables")).not.toBeDisabled(),
    );
  });

  it("resets to defaults", async () => {
    useSettingsStore.setState({
      config: configWith({ ...DEFAULT_CLIPPING, headingStyle: "setext", images: "drop" }),
    });
    render(<ClippingSection />);
    expect(screen.getByTestId("clipping-preview").textContent).toContain(
      "Clipped article\n===",
    );
    fireEvent.click(screen.getByTestId("clipping-reset"));
    expect(mockedSet).toHaveBeenCalledWith(DEFAULT_CLIPPING);
    await waitFor(() => expect(screen.getByTestId("clipping-reset")).toBeDisabled());
  });

  it("shows an error and refreshes when saving fails", async () => {
    mockedSet.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    mockedGet.mockResolvedValueOnce(configWith({ ...DEFAULT_CLIPPING }));
    render(<ClippingSection />);
    fireEvent.change(screen.getByTestId("clipping-images"), {
      target: { value: "drop" },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(mockedGet).toHaveBeenCalled();
    expect(screen.getByTestId("clipping-images")).toHaveValue("keep");
  });
});
