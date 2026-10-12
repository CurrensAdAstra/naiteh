import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAY_TIMELINE_DEFAULT,
  DAY_TIMELINE_MAX,
  DAY_TIMELINE_MIN,
  useUIStore,
} from "../../../state/uiStore";
import { DayTimelinePane } from "../DayTimelinePane";

vi.mock("../DayTimeline", () => ({
  DayTimeline: () => <div data-testid="day-timeline" />,
}));

let report: ((width: number) => void) | null = null;
class FakeResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {
    report = (width) =>
      this.cb(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
  }
  disconnect() {
    report = null;
  }
  unobserve() {}
}

const container = { current: document.createElement("div") };

beforeEach(() => {
  Element.prototype.setPointerCapture = function () {};
  Element.prototype.releasePointerCapture = function () {};
  Element.prototype.hasPointerCapture = () => false;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  useUIStore.setState({
    dayTimelineWidth: DAY_TIMELINE_DEFAULT,
    dayTimelineHidden: false,
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("DayTimelinePane", () => {
  it("shows the pane at the preferred width with a separator", () => {
    render(<DayTimelinePane containerRef={container} />);
    expect(screen.getByTestId("day-timeline-pane")).toHaveStyle({
      width: `${DAY_TIMELINE_DEFAULT}px`,
    });
    const sep = screen.getByRole("separator", { name: /day timeline resizer/i });
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuemin", String(DAY_TIMELINE_MIN));
    expect(sep).toHaveAttribute("aria-valuemax", String(DAY_TIMELINE_MAX));
    expect(sep).toHaveAttribute("aria-valuenow", String(DAY_TIMELINE_DEFAULT));
    expect(sep).toHaveAttribute("tabindex", "0");
  });

  it("resizes with arrows, Home/End, and drags (clamped)", () => {
    render(<DayTimelinePane containerRef={container} />);
    const sep = screen.getByRole("separator");
    fireEvent.keyDown(sep, { key: "ArrowRight" });
    expect(useUIStore.getState().dayTimelineWidth).toBe(DAY_TIMELINE_DEFAULT + 10);
    fireEvent.keyDown(sep, { key: "ArrowLeft", shiftKey: true });
    expect(useUIStore.getState().dayTimelineWidth).toBe(DAY_TIMELINE_DEFAULT - 40);
    fireEvent.keyDown(sep, { key: "End" });
    expect(useUIStore.getState().dayTimelineWidth).toBe(DAY_TIMELINE_MAX);
    fireEvent.keyDown(sep, { key: "Home" });
    expect(useUIStore.getState().dayTimelineWidth).toBe(DAY_TIMELINE_MIN);
    expect(fireEvent.keyDown(sep, { key: "Tab" })).toBe(true);

    fireEvent.pointerDown(sep, { clientX: 100, pointerId: 1 });
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.pointerMove(sep, { clientX: 2000, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 2000, pointerId: 1 });
    expect(useUIStore.getState().dayTimelineWidth).toBe(DAY_TIMELINE_MAX);
    expect(document.body.style.userSelect).toBe("");
  });

  it("shrinks first, then collapses to a toggle when the window is narrow", () => {
    render(<DayTimelinePane containerRef={container} />);
    act(() => report?.(320 + 5 + 300));
    expect(screen.getByTestId("day-timeline-pane")).toHaveStyle({ width: "300px" });
    act(() => report?.(500));
    expect(screen.queryByTestId("day-timeline-pane")).toBeNull();
    // The toggle shows it anyway, at its minimum width.
    fireEvent.click(screen.getByRole("button", { name: "Show day timeline" }));
    expect(screen.getByTestId("day-timeline-pane")).toHaveStyle({
      width: `${DAY_TIMELINE_MIN}px`,
    });
    act(() => report?.(2000));
    expect(screen.getByTestId("day-timeline-pane")).toHaveStyle({
      width: `${DAY_TIMELINE_DEFAULT}px`,
    });
  });

  it("stays hidden when the user hid it until the toggle is used", () => {
    useUIStore.setState({ dayTimelineHidden: true });
    render(<DayTimelinePane containerRef={container} />);
    expect(screen.queryByTestId("day-timeline-pane")).toBeNull();
    fireEvent.click(screen.getByTestId("day-timeline-show"));
    expect(screen.getByTestId("day-timeline-pane")).toBeInTheDocument();
    expect(useUIStore.getState().dayTimelineHidden).toBe(false);
  });
});
