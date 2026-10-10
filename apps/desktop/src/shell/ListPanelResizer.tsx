import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import {
  LIST_PANEL_MAX,
  LIST_PANEL_MIN,
  useUIStore,
} from "../state/uiStore";
import styles from "./ListPanelResizer.module.css";

interface DragStart {
  startX: number;
  startWidth: number;
}

/** Keyboard resize step in px (Shift multiplies it for coarse moves). */
const LIST_PANEL_KEY_STEP = 10;
const COARSE_MULTIPLIER = 5;

export function ListPanelResizer() {
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);
  const setListPanelWidth = useUIStore((s) => s.setListPanelWidth);
  const dragRef = useRef<DragStart | null>(null);
  const [dragging, setDragging] = useState(false);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: listPanelWidth };
    setDragging(true);
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (start === null) return;
    const dx = e.clientX - start.startX;
    setListPanelWidth(start.startWidth + dx);
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
  }

  // WAI-ARIA window-splitter pattern: arrows nudge the (vertical)
  // splitter, Home/End jump to the min/max width. The store clamps.
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = LIST_PANEL_KEY_STEP * (e.shiftKey ? COARSE_MULTIPLIER : 1);
    let next: number;
    switch (e.key) {
      case "ArrowLeft":
        next = listPanelWidth - step;
        break;
      case "ArrowRight":
        next = listPanelWidth + step;
        break;
      case "Home":
        next = LIST_PANEL_MIN;
        break;
      case "End":
        next = LIST_PANEL_MAX;
        break;
      default:
        return;
    }
    e.preventDefault();
    setListPanelWidth(next);
  }

  return (
    <div
      role="separator"
      aria-label="List panel resizer"
      aria-orientation="vertical"
      aria-valuemin={LIST_PANEL_MIN}
      aria-valuemax={LIST_PANEL_MAX}
      aria-valuenow={listPanelWidth}
      aria-valuetext={`${listPanelWidth} pixels`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="list-panel-resizer"
      className={`${styles.resizer} ${dragging ? styles.dragging : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
