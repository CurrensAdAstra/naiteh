import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useUIStore, type ViewMode } from "../../state/uiStore";
import { useKeyboardShortcuts } from "../useKeyboardShortcuts";

function Harness() {
  useKeyboardShortcuts();
  return <div data-testid="harness" tabIndex={-1} />;
}

function dispatchModifier(key: string) {
  fireEvent.keyDown(window, {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
}

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    useUIStore.setState({ viewMode: "journal", aiPanelOpen: false });
  });

  it("Cmd+1..7 switches ViewMode", () => {
    render(<Harness />);
    const expected: ViewMode[] = [
      "journal",
      "notes",
      "calendar",
      "search",
      "tags",
      "sync",
      "settings",
    ];
    for (let i = 0; i < expected.length; i++) {
      dispatchModifier(String(i + 1));
      expect(useUIStore.getState().viewMode).toBe(expected[i]);
    }
  });

  it("ignores plain digit presses without the modifier", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "3", bubbles: true });
    expect(useUIStore.getState().viewMode).toBe("journal");
  });

  it("Cmd+8 (out of range) is a no-op", () => {
    render(<Harness />);
    dispatchModifier("8");
    expect(useUIStore.getState().viewMode).toBe("journal");
  });

  it("Cmd+E toggles the AI panel when not in an editable field", () => {
    render(<Harness />);
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
    dispatchModifier("e");
    expect(useUIStore.getState().aiPanelOpen).toBe(true);
    dispatchModifier("e");
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
  });

  it("Cmd+E does NOT toggle when an INPUT has focus", () => {
    const { container } = render(
      <>
        <Harness />
        <input data-testid="editable" />
      </>,
    );
    const input = container.querySelector(
      "input[data-testid='editable']",
    ) as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, {
      key: "e",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
  });

  it("Cmd+digit still fires when an input has focus (mode switching is global)", () => {
    const { container } = render(
      <>
        <Harness />
        <input data-testid="editable" />
      </>,
    );
    const input = container.querySelector(
      "input[data-testid='editable']",
    ) as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, {
      key: "5",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(useUIStore.getState().viewMode).toBe("tags");
  });

  it("Cmd+Shift+1 is ignored — modifier surface stays tight", () => {
    render(<Harness />);
    fireEvent.keyDown(window, {
      key: "1",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    // Cmd+1 from a previous test would have moved us; reset confirms no
    // change here:
    useUIStore.setState({ viewMode: "calendar" });
    fireEvent.keyDown(window, {
      key: "1",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
    });
    expect(useUIStore.getState().viewMode).toBe("calendar");
  });
});
