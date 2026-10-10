import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  JOURNAL_SPLIT_DEFAULT,
  LIST_PANEL_DEFAULT,
  LIST_PANEL_MAX,
  LIST_PANEL_MIN,
  useUIStore,
} from "../../state/uiStore";
import { ListPanelResizer } from "../ListPanelResizer";

// jsdom doesn't implement pointer capture; stub the methods.
beforeEach(() => {
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
  Element.prototype.hasPointerCapture = function () {
    return false;
  };
});

describe("ListPanelResizer", () => {
  beforeEach(() => {
    useUIStore.setState({
      viewMode: "journal",
      listPanelWidth: LIST_PANEL_DEFAULT,
      journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
    });
  });

  it("is a vertical separator with proper aria attributes", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator", { name: /list panel resizer/i });
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuemin", String(LIST_PANEL_MIN));
    expect(sep).toHaveAttribute("aria-valuemax", String(LIST_PANEL_MAX));
    expect(sep).toHaveAttribute("aria-valuenow", String(LIST_PANEL_DEFAULT));
  });

  it("clamps drag below the minimum", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 0, pointerId: 1 });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MIN);
  });

  it("clamps drag above the maximum", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    fireEvent.pointerDown(sep, { clientX: 0, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 1000, pointerId: 1 });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MAX);
  });

  it("applies in-range drag deltas verbatim", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 140, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 140, pointerId: 1 });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_DEFAULT + 40);
  });

  it("is focusable and resizes with ArrowLeft / ArrowRight", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_DEFAULT + 10);
    expect(sep).toHaveAttribute("aria-valuenow", String(LIST_PANEL_DEFAULT + 10));

    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_DEFAULT - 10);

    fireEvent.keyDown(sep, { key: "ArrowRight", shiftKey: true });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_DEFAULT + 40);
  });

  it("Home / End jump to the min / max width", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "End" });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MAX);
    expect(sep).toHaveAttribute("aria-valuenow", String(LIST_PANEL_MAX));
    // Arrows clamp at the bounds.
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MAX);
    fireEvent.keyDown(sep, { key: "Home" });
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_MIN);
  });

  it("ignores unrelated keys and does not swallow them", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    const notPrevented = fireEvent.keyDown(sep, { key: "Tab" });
    expect(notPrevented).toBe(true);
    expect(useUIStore.getState().listPanelWidth).toBe(LIST_PANEL_DEFAULT);
    expect(fireEvent.keyDown(sep, { key: "ArrowRight" })).toBe(false);
  });

  it("clears document body user-select on pointer up", () => {
    render(<ListPanelResizer />);
    const sep = screen.getByRole("separator");
    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1 });
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.pointerUp(sep, { clientX: 100, pointerId: 1 });
    expect(document.body.style.userSelect).toBe("");
  });
});
