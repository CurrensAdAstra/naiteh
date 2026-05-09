import type { CSSProperties } from "react";

import { useUIStore } from "../state/uiStore";
import { ActivityBar } from "./ActivityBar";
import { EditorPanel } from "./EditorPanel";
import { ListPanelResizer } from "./ListPanelResizer";
import { PanelRouter } from "./PanelRouter";
import { StatusBar } from "./StatusBar";
import styles from "./AppShell.module.css";

export function AppShell() {
  const viewMode = useUIStore((s) => s.viewMode);
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);

  const widthVar: CSSProperties = {
    ["--list-panel-width" as string]: `${listPanelWidth}px`,
  };

  return (
    <div className={styles.shell} style={widthVar} data-testid="app-shell">
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
      <div className={styles.status}>
        <StatusBar />
      </div>
    </div>
  );
}
