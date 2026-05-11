import { useMemo } from "react";

import { describeSyncStatus } from "../lib/syncStatusLabel";
import { countWords } from "../lib/wordCount";
import { useEditorStore } from "../state/editorStore";
import { useSyncStore } from "../state/syncStore";
import { useUIStore } from "../state/uiStore";
import { useVaultStore } from "../state/vaultStore";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const active = useVaultStore((s) => s.active);
  const openContent = useEditorStore((s) => s.open?.content ?? null);
  const syncStatus = useSyncStore((s) => s.status);
  const syncNotInitialized = useSyncStore((s) => s.notInitialized);
  const setViewMode = useUIStore((s) => s.setViewMode);

  const words = useMemo(
    () => (openContent === null ? null : countWords(openContent)),
    [openContent],
  );
  const syncLabel = useMemo(
    () => describeSyncStatus(syncStatus, syncNotInitialized),
    [syncStatus, syncNotInitialized],
  );

  return (
    <div className={styles.bar} role="contentinfo" data-testid="status-bar">
      <span className={styles.vault}>{active?.name ?? "—"}</span>
      <span className={styles.spacer} />
      <button
        type="button"
        className={styles.linkLike}
        onClick={() => setViewMode("sync")}
        aria-label="Open Sync panel"
        title="Open Sync"
        data-testid="status-sync"
      >
        {syncLabel}
      </button>
      <span className={styles.placeholder} data-testid="status-words">
        {words === null ? "Words: —" : `Words: ${words.toLocaleString()}`}
      </span>
    </div>
  );
}
