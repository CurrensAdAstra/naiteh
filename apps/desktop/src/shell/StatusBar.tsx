import { useMemo } from "react";

import { describeSyncStatus } from "../lib/syncStatusLabel";
import { countWords } from "../lib/wordCount";
import { useAuthStore } from "../state/authStore";
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
  const session = useAuthStore((s) => s.session);
  const clearSession = useAuthStore((s) => s.clearSession);
  const logAction = useAuthStore((s) => s.logAction);

  const words = useMemo(
    () => (openContent === null ? null : countWords(openContent)),
    [openContent],
  );
  const syncLabel = useMemo(
    () => describeSyncStatus(syncStatus, syncNotInitialized),
    [syncStatus, syncNotInitialized],
  );

  async function handleLogout() {
    await logAction("logout").catch(() => {});
    clearSession();
  }

  return (
    <div className={styles.bar} role="contentinfo" data-testid="status-bar">
      <span className={styles.vault}>{active?.name ?? "—"}</span>
      {session !== null && (
        <button
          type="button"
          className={styles.linkLike}
          onClick={() => setViewMode("settings")}
          aria-label="Open account settings"
          title="Open account settings"
          data-testid="status-user"
        >
          {session.username}
        </button>
      )}
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
      {session !== null && (
        <button
          type="button"
          className={styles.linkLike}
          onClick={() => void handleLogout()}
          data-testid="status-logout"
        >
          Log out
        </button>
      )}
    </div>
  );
}
