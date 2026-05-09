import { useRef, useState, type PointerEvent } from "react";

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

  return (
    <div
      role="separator"
      aria-label="List panel resizer"
      aria-orientation="vertical"
      aria-valuemin={LIST_PANEL_MIN}
      aria-valuemax={LIST_PANEL_MAX}
      aria-valuenow={listPanelWidth}
      tabIndex={0}
      data-testid="list-panel-resizer"
      className={`${styles.resizer} ${dragging ? styles.dragging : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    />
  );
}
