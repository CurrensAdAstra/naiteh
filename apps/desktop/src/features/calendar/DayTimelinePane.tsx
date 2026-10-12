import { PanelLeftOpen } from "lucide-react";
import { useEffect, useState, type RefObject } from "react";

import { DAY_TIMELINE_MIN, useUIStore } from "../../state/uiStore";
import { DayTimeline } from "./DayTimeline";
import { DayTimelineResizer } from "./DayTimelineResizer";
import { fitTimelineWidth } from "./timelineLayout";
import styles from "./DayTimelinePane.module.css";

interface DayTimelinePaneProps {
  /** The shell's editor cell this pane shares with the editor. */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * Calendar mode: the day timeline + its resizer, placed before the
 * editor inside the editor grid cell. The pane shrinks so the editor
 * keeps its minimum width, and collapses to a toggle button when even
 * the pane's minimum no longer fits (or the user hid it).
 */
export function DayTimelinePane({ containerRef }: DayTimelinePaneProps) {
  const preferred = useUIStore((s) => s.dayTimelineWidth);
  const hidden = useUIStore((s) => s.dayTimelineHidden);
  const setHidden = useUIStore((s) => s.setDayTimelineHidden);
  const [containerWidth, setContainerWidth] = useState(0);
  // Shown on request although it doesn't fit (the editor is squeezed).
  const [forced, setForced] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (el === null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      setContainerWidth(entries[0]?.contentRect.width ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);

  const fitted = fitTimelineWidth(containerWidth, preferred);
  useEffect(() => {
    if (fitted !== null) setForced(false);
  }, [fitted]);

  const width = fitted ?? (forced ? DAY_TIMELINE_MIN : null);

  if (hidden || width === null) {
    return (
      <div className={styles.collapsed} data-testid="day-timeline-collapsed">
        <button
          type="button"
          className={styles.toggle}
          aria-label="Show day timeline"
          title="Show day timeline"
          onClick={() => {
            setHidden(false);
            if (fitted === null) setForced(true);
          }}
          data-testid="day-timeline-show"
        >
          <PanelLeftOpen size={16} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        className={styles.pane}
        style={{ width }}
        data-testid="day-timeline-pane"
      >
        <DayTimeline
          onHide={() => {
            setForced(false);
            setHidden(true);
          }}
        />
      </div>
      <div className={styles.resizer}>
        <DayTimelineResizer shownWidth={width} />
      </div>
    </>
  );
}
