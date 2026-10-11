import { lazy, Suspense, type CSSProperties } from "react";

import { ChatModelPickerHost } from "../features/chat/ChatModelPickerHost";
import { SettingsModal } from "../features/settings/SettingsModal";
import { useUIStore } from "../state/uiStore";
import { ActivityBar } from "./ActivityBar";
import { CommandPalette } from "./CommandPalette";
import { ListPanelResizer } from "./ListPanelResizer";
import { PanelRouter } from "./PanelRouter";
import { StatusBar } from "./StatusBar";
import { useWorkspaceLifecycle } from "./useWorkspaceLifecycle";
import styles from "./AppShell.module.css";

// CodeMirror (and its language registry) is by far the heaviest dependency.
// Loading the editor lazily keeps it out of the startup bundle, so the
// login / first-run screens never download or preload it.
const EditorPanel = lazy(() =>
  import("./EditorPanel").then((m) => ({ default: m.EditorPanel })),
);

function EditorPanelFallback() {
  return (
    <div
      className={styles.editorFallback}
      role="status"
      aria-label="Loading editor"
      data-testid="editor-panel-loading"
    />
  );
}

// Calendar mode gives the month grid a fixed share of the list+editor
// region (the monthly calendar reads better wide) instead of the px
// width the resizer controls in every other view.
const CALENDAR_LIST_RATIO = 0.7;

export function AppShell() {
  const viewMode = useUIStore((s) => s.viewMode);
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  // Per-vault sync refresh + last-opened restore/persist coordination.
  useWorkspaceLifecycle();

  const isCalendar = viewMode === "calendar";
  // In calendar mode the list panel takes CALENDAR_LIST_RATIO of the space
  // it shares with the editor (the fixed activity / resizer columns
  // are subtracted first); elsewhere it uses the resizer-controlled width.
  const listPanelTrack = isCalendar
    ? `calc((100% - var(--activity-width) - var(--resizer-width))` +
      ` * ${CALENDAR_LIST_RATIO})`
    : `${listPanelWidth}px`;

  const shellStyle: CSSProperties = {
    ["--list-panel-width" as string]: listPanelTrack,
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
        <Suspense fallback={<EditorPanelFallback />}>
          <EditorPanel />
        </Suspense>
      </div>
      <CommandPalette />
      <ChatModelPickerHost />
      {settingsOpen && <SettingsModal />}
      <div className={styles.status}>
        <StatusBar />
      </div>
    </div>
  );
}
