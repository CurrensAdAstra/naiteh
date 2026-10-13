import { lazy, Suspense, useRef, type CSSProperties } from "react";

import { DayTimelinePane } from "../features/calendar/DayTimelinePane";
import { ChatModelPickerHost } from "../features/chat/ChatModelPickerHost";
import { CompareModal } from "../features/backup/CompareModal";
import { SettingsModal } from "../features/settings/SettingsModal";
import { useBackupStore } from "../state/backupStore";
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

export function AppShell() {
  const viewMode = useUIStore((s) => s.viewMode);
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const compareOpen = useBackupStore((s) => s.compareOpen);
  // Per-vault sync refresh + last-opened restore/persist coordination.
  useWorkspaceLifecycle();

  // Calendar mode reads "month | day timeline | note": the editor cell
  // becomes a row holding the day timeline pane, then the editor. The
  // editor host stays the same element in every mode, so switching
  // modes never remounts the editor.
  const isCalendar = viewMode === "calendar";
  const editorCellRef = useRef<HTMLDivElement>(null);

  const shellStyle: CSSProperties = {
    ["--list-panel-width" as string]: `${listPanelWidth}px`,
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
        <ListPanelResizer />
      </div>
      <div
        ref={editorCellRef}
        className={`${styles.editor} ${isCalendar ? styles.editorSplit : ""}`}
      >
        {isCalendar && <DayTimelinePane containerRef={editorCellRef} />}
        <div className={styles.editorHost}>
          <Suspense fallback={<EditorPanelFallback />}>
            <EditorPanel />
          </Suspense>
        </div>
      </div>
      <CommandPalette />
      <ChatModelPickerHost />
      {settingsOpen && <SettingsModal />}
      {compareOpen && <CompareModal />}
      <div className={styles.status}>
        <StatusBar />
      </div>
    </div>
  );
}
