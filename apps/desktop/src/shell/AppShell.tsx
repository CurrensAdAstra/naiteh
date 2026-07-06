import { type CSSProperties } from "react";

import { AiPanel } from "../features/ai/AiPanel";
import { SettingsModal } from "../features/settings/SettingsModal";
import { useUIStore } from "../state/uiStore";
import { ActivityBar } from "./ActivityBar";
import { CommandPalette } from "./CommandPalette";
import { EditorPanel } from "./EditorPanel";
import { ListPanelResizer } from "./ListPanelResizer";
import { PanelRouter } from "./PanelRouter";
import { StatusBar } from "./StatusBar";
import { useWorkspaceLifecycle } from "./useWorkspaceLifecycle";
import styles from "./AppShell.module.css";

const AI_PANEL_WIDTH_PX = 360;

// Calendar mode gives the month grid a fixed share of the list+editor
// region (the monthly calendar reads better wide) instead of the px
// width the resizer controls in every other view.
const CALENDAR_LIST_RATIO = 0.7;

export function AppShell() {
  const viewMode = useUIStore((s) => s.viewMode);
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);
  const aiPanelOpen = useUIStore((s) => s.aiPanelOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  // Per-vault sync refresh + last-opened restore/persist coordination.
  useWorkspaceLifecycle();

  const isCalendar = viewMode === "calendar";
  // In calendar mode the list panel takes CALENDAR_LIST_RATIO of the space
  // it shares with the editor (the fixed activity / resizer / ai columns
  // are subtracted first); elsewhere it uses the resizer-controlled width.
  const listPanelTrack = isCalendar
    ? `calc((100% - var(--activity-width) - var(--resizer-width)` +
      ` - var(--ai-panel-width)) * ${CALENDAR_LIST_RATIO})`
    : `${listPanelWidth}px`;

  const shellStyle: CSSProperties = {
    ["--list-panel-width" as string]: listPanelTrack,
    ["--ai-panel-width" as string]: aiPanelOpen ? `${AI_PANEL_WIDTH_PX}px` : "0px",
  };

  return (
    <div className={styles.shell} style={shellStyle} data-testid="app-shell">
      <div className={styles.activity}>
        <ActivityBar />
      </div>
      <div className={styles.list} data-testid="list-panel">
        <PanelRouter mode={viewMode} />
      </div>
      <div className={styles.resizer}>
        {/* The width is proportional (not drag-sized) in calendar mode. */}
        {!isCalendar && <ListPanelResizer />}
      </div>
      <div className={styles.editor}>
        <EditorPanel />
      </div>
      {aiPanelOpen && (
        <div className={styles.ai}>
          <AiPanel />
        </div>
      )}
      <CommandPalette />
      {settingsOpen && <SettingsModal />}
      <div className={styles.status}>
        <StatusBar />
      </div>
    </div>
  );
}
