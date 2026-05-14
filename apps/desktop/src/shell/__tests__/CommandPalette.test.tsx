import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useUIStore } from "../../state/uiStore";
import { CommandPalette } from "../CommandPalette";

describe("CommandPalette", () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: "journal",
      aiPanelOpen: false,
      commandPaletteOpen: true,
      editorReadOnly: false,
    });
  });

  it("filters commands and runs the selected result", () => {
    render(<CommandPalette />);

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.keyDown(input, { key: "Enter", bubbles: true });

    expect(useUIStore.getState().viewMode).toBe("settings");
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });

  it("supports arrow navigation before Enter", () => {
    render(<CommandPalette />);

    const input = screen.getByTestId("command-palette-input");
    fireEvent.keyDown(input, { key: "ArrowDown", bubbles: true });
    fireEvent.keyDown(input, { key: "Enter", bubbles: true });

    expect(useUIStore.getState().viewMode).toBe("notes");
  });

  it("can toggle AI Assist from a command", () => {
    render(<CommandPalette />);

    fireEvent.click(screen.getByTestId("command-toggle-ai"));

    expect(useUIStore.getState().aiPanelOpen).toBe(true);
    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });

  it("closes on Escape", () => {
    render(<CommandPalette />);

    fireEvent.keyDown(screen.getByTestId("command-palette-input"), {
      key: "Escape",
      bubbles: true,
    });

    expect(useUIStore.getState().commandPaletteOpen).toBe(false);
  });
});
