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

export function AppShell() {
  const viewMode = useUIStore((s) => s.viewMode);
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);
  const aiPanelOpen = useUIStore((s) => s.aiPanelOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  // Per-vault sync refresh + last-opened restore/persist coordination.
  useWorkspaceLifecycle();

  const shellStyle: CSSProperties = {
    ["--list-panel-width" as string]: `${listPanelWidth}px`,
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
        <ListPanelResizer />
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
