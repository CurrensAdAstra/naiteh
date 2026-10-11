import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useUIStore } from "../../state/uiStore";
import { CommandPalette } from "../CommandPalette";

describe("CommandPalette", () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: "journal",
      aiPanelOpen: false,
      commandPaletteOpen: true,
      editorMode: "edit",
      settingsOpen: false,
    });
  });

  it("filters commands and runs the selected result", () => {
    render(<CommandPalette />);

    const input = screen.getByTestId("command-palette-input");
    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.keyDown(input, { key: "Enter", bubbles: true });

    expect(useUIStore.getState().settingsOpen).toBe(true);
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

  it("wires the combobox / listbox / option ARIA pattern", () => {
    render(<CommandPalette />);

    const input = screen.getByRole("combobox", { name: /command/i });
    expect(input).toBe(screen.getByTestId("command-palette-input"));
    expect(input).toHaveAttribute("aria-expanded", "true");

    const listbox = screen.getByRole("listbox", { name: /commands/i });
    expect(input).toHaveAttribute("aria-controls", listbox.id);

    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    // No nested interactive controls inside the options.
    expect(within(listbox).queryAllByRole("button")).toHaveLength(0);

    // aria-activedescendant targets the selected option element itself.
    const first = options[0]!;
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(document.getElementById(first.id)).toBe(first);
  });

  it("moves aria-activedescendant / aria-selected with the arrow keys", () => {
    render(<CommandPalette />);

    const input = screen.getByRole("combobox");
    const options = screen.getAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", options[2]!.id);
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");

    // Clamps at the ends.
    for (let i = 0; i < options.length + 3; i++) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      options[options.length - 1]!.id,
    );
    for (let i = 0; i < options.length + 3; i++) {
      fireEvent.keyDown(input, { key: "ArrowUp" });
    }
    expect(input).toHaveAttribute("aria-activedescendant", options[0]!.id);
  });

  it("handles an empty result set without a dangling active descendant", () => {
    render(<CommandPalette />);

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "zzz-no-such-command" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(/no matching commands/i);
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");

    // Arrow keys / Enter are harmless with nothing to pick.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);

    // Clearing the query restores the first option as active.
    fireEvent.change(input, { target: { value: "" } });
    const first = screen.getAllByRole("option")[0]!;
    expect(input).toHaveAttribute("aria-activedescendant", first.id);
  });

  it("hovering an option makes it the active descendant", () => {
    render(<CommandPalette />);

    const input = screen.getByRole("combobox");
    const option = screen.getByTestId("command-open-settings");
    fireEvent.mouseEnter(option);
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUIStore.getState().settingsOpen).toBe(true);
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
