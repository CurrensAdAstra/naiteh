import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  DAY_TIMELINE_MAX,
  DAY_TIMELINE_MIN,
  useUIStore,
} from "../../state/uiStore";
import styles from "../../shell/ListPanelResizer.module.css";

/** Keyboard resize step in px (Shift multiplies it for coarse moves). */
const KEY_STEP = 10;
const COARSE_MULTIPLIER = 5;

/**
 * Splitter between the Calendar mode day timeline and the editor; the
 * same pointer + WAI-ARIA window-splitter keyboard pattern as
 * shell/ListPanelResizer. The store clamps to 280–560px.
 */
export function DayTimelineResizer({ shownWidth }: { shownWidth: number }) {
  const setWidth = useUIStore((s) => s.setDayTimelineWidth);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: shownWidth };
    setDragging(true);
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (start === null) return;
    setWidth(start.startWidth + e.clientX - start.startX);
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = KEY_STEP * (e.shiftKey ? COARSE_MULTIPLIER : 1);
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = shownWidth - step;
        break;
      case "ArrowRight":
        next = shownWidth + step;
        break;
      case "Home":
        next = DAY_TIMELINE_MIN;
        break;
      case "End":
        next = DAY_TIMELINE_MAX;
        break;
      default:
        return;
    }
    e.preventDefault();
    setWidth(next);
  }

  return (
    <div
      role="separator"
      aria-label="Day timeline resizer"
      aria-orientation="vertical"
      aria-valuemin={DAY_TIMELINE_MIN}
      aria-valuemax={DAY_TIMELINE_MAX}
      aria-valuenow={shownWidth}
      aria-valuetext={`${shownWidth} pixels`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="day-timeline-resizer"
      className={`${styles.resizer} ${dragging ? styles.dragging : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
