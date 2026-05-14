import { useEffect, type CSSProperties } from "react";

import { AiPanel } from "../features/ai/AiPanel";
import {
  workspaceGet,
  workspaceSetLastOpened,
} from "../lib/api/workspace";
import { openByRelPath } from "../lib/openByRelPath";
import type { LastOpened } from "../lib/types";
import { useEditorStore } from "../state/editorStore";
import { useSyncStore } from "../state/syncStore";
import { useUIStore } from "../state/uiStore";
import { ActivityBar } from "./ActivityBar";
import { CommandPalette } from "./CommandPalette";
import { EditorPanel } from "./EditorPanel";
import { ListPanelResizer } from "./ListPanelResizer";
import { PanelRouter } from "./PanelRouter";
import { StatusBar } from "./StatusBar";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import styles from "./AppShell.module.css";

const AI_PANEL_WIDTH_PX = 360;
const SYNC_STATUS_REFRESH_MS = 30_000;

function journalRelPathFor(date: string): string {
  return `journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
}

export function AppShell() {
  const viewMode = useUIStore((s) => s.viewMode);
  const listPanelWidth = useUIStore((s) => s.listPanelWidth);
  const aiPanelOpen = useUIStore((s) => s.aiPanelOpen);
  useKeyboardShortcuts();

  // Sync status: pull on mount, then refresh on a slow interval so the
  // status bar's "Sync: 5m ago" stays accurate without polling git on
  // every keystroke. AppShell is keyed on vault root so the interval
  // tears down + restarts automatically when the user switches vaults.
  useEffect(() => {
    const refresh = useSyncStore.getState().refresh;
    useSyncStore.getState().reset();
    void refresh();
    const handle = setInterval(() => void refresh(), SYNC_STATUS_REFRESH_MS);
    return () => clearInterval(handle);
  }, []);

  // On mount (i.e. when the active vault first becomes available or
  // changes — AppShell is keyed on the vault root in App.tsx), restore
  // the last-opened file from the per-vault workspace.json. If that
  // file no longer exists, clear the marker so we don't keep trying.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await workspaceGet();
        const last = state.lastOpened;
        if (last === null || cancelled) return;
        // Don't clobber a note the user already opened during startup.
        if (useEditorStore.getState().open !== null) return;
        const relPath =
          last.kind === "Note"
            ? last.relPath
            : journalRelPathFor(last.date);
        try {
          await openByRelPath(relPath);
        } catch {
          // Stale entry — file probably deleted. Clear so it doesn't
          // resurface next session.
          await workspaceSetLastOpened(null).catch(() => {});
        }
      } catch {
        // workspace.json unreadable for some reason — non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist whenever a fresh file is opened. We only react to
  // open-transitions (key changes); closing a note or switching vaults
  // intentionally leaves the previous vault's workspace.json alone so
  // the user finds the same note when they come back.
  useEffect(() => {
    let lastKey = useEditorStore.getState().open?.key ?? null;
    const unsubscribe = useEditorStore.subscribe((state) => {
      const open = state.open;
      const key = open?.key ?? null;
      if (key === lastKey) return;
      lastKey = key;
      if (open === null) return;
      const payload: LastOpened =
        open.source.kind === "note"
          ? { kind: "Note", relPath: open.source.relPath }
          : { kind: "Journal", date: open.source.date };
      void workspaceSetLastOpened(payload).catch(() => {});
    });
    return () => unsubscribe();
  }, []);

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
      <div className={styles.status}>
        <StatusBar />
      </div>
    </div>
  );
}
