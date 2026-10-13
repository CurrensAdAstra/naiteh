import { useEffect, useMemo } from "react";

import { stopChat } from "../lib/chatMd/chatFlow";
import { describeSyncStatus } from "../lib/syncStatusLabel";
import { countWords } from "../lib/wordCount";
import { useAuthStore } from "../state/authStore";
import { subscribeBackupEvents, useBackupStore } from "../state/backupStore";
import { useEditorStore } from "../state/editorStore";
import { useSyncStore } from "../state/syncStore";
import { useUIStore } from "../state/uiStore";
import { useVaultStore } from "../state/vaultStore";
import styles from "./StatusBar.module.css";

const NOTICE_MS = 6_000;

export function StatusBar() {
  const active = useVaultStore((s) => s.active);
  const openContent = useEditorStore((s) => s.open?.content ?? null);
  const saveError = useEditorStore((s) => s.saveError);
  const syncStatus = useSyncStore((s) => s.status);
  const syncNotInitialized = useSyncStore((s) => s.notInitialized);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const liveUpdatesUnavailable = useUIStore((s) => s.liveUpdatesUnavailable);
  const notice = useUIStore((s) => s.notice);
  const chatRequest = useUIStore((s) => s.chatRequest);
  const setNotice = useUIStore((s) => s.setNotice);
  const session = useAuthStore((s) => s.session);
  const backupRunning = useBackupStore((s) => s.running);
  const backupProgress = useBackupStore((s) => s.progress);
  const backupError = useBackupStore((s) => s.lastRunError);
  const requestBackupSettings = useUIStore((s) => s.requestBackupSettings);

  // Automatic backups run in the backend; follow their progress events.
  useEffect(() => subscribeBackupEvents(), []);
  const backupLabel = useMemo(() => {
    const entries = Object.values(backupProgress);
    if (entries.length === 0) return backupRunning ? "Backing up…" : null;
    const done = entries.reduce((n, p) => n + p.done, 0);
    const total = entries.reduce((n, p) => n + p.total, 0);
    return `Backing up… ${done}/${total}`;
  }, [backupProgress, backupRunning]);

  // Transient notices ("Unsaved edits kept as …") fade after a moment.
  useEffect(() => {
    if (notice === null) return;
    const handle = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(handle);
  }, [notice, setNotice]);
  const clearSession = useAuthStore((s) => s.clearSession);
  const logAction = useAuthStore((s) => s.logAction);

  const words = useMemo(
    () => (openContent === null ? null : countWords(openContent)),
    [openContent],
  );
  const mergePending = syncStatus?.mergePending === true;
  const syncLabel = useMemo(
    () =>
      mergePending
        ? "Sync: resolve conflicts"
        : describeSyncStatus(syncStatus, syncNotInitialized),
    [mergePending, syncStatus, syncNotInitialized],
  );

  async function handleLogout() {
    await logAction("logout").catch(() => {});
    // clearSession flushes unsaved edits and closes the open note before
    // forgetting the session.
    await clearSession();
  }

  return (
    <div className={styles.bar} role="contentinfo" data-testid="status-bar">
      <span className={styles.vault}>{active?.name ?? "—"}</span>
      {session !== null && (
        <button
          type="button"
          className={styles.linkLike}
          onClick={() => setSettingsOpen(true)}
          aria-label="Open account settings"
          title="Open account settings"
          data-testid="status-user"
        >
          {session.username}
        </button>
      )}
      <span className={styles.spacer} />
      {notice !== null && (
        <span
          className={styles.placeholder}
          role="status"
          data-testid="status-notice"
        >
          {notice}
        </span>
      )}
      {chatRequest !== null && (
        <span
          className={styles.placeholder}
          role="status"
          data-testid="status-chat"
        >
          Chat: streaming… ({chatRequest.model}){" "}
          <button
            type="button"
            className={styles.linkLike}
            onClick={stopChat}
            data-testid="status-chat-stop"
          >
            Stop
          </button>
        </span>
      )}
      {liveUpdatesUnavailable !== null && (
        <span
          className={styles.placeholder}
          title={`Changes made outside naiteh are not detected: ${liveUpdatesUnavailable}`}
          data-testid="status-live-updates"
        >
          Live updates off
        </span>
      )}
      {saveError !== null && (
        <span
          className={styles.placeholder}
          role="status"
          title={saveError.message}
          data-testid="status-save-error"
        >
          {saveError.retrying ? "Save failed — retrying" : "Save failed"}
        </span>
      )}
      {backupLabel !== null ? (
        <span
          className={styles.placeholder}
          role="status"
          data-testid="status-backup"
        >
          {backupLabel}
        </span>
      ) : (
        backupError !== null && (
          <button
            type="button"
            className={styles.linkLike}
            onClick={requestBackupSettings}
            title={backupError}
            aria-label={`Backup failed: ${backupError} — open Backup settings`}
            data-testid="status-backup-error"
          >
            Backup failed
          </button>
        )
      )}
      <button
        type="button"
        className={styles.linkLike}
        onClick={() => setViewMode("sync")}
        aria-label={
          mergePending
            ? "Resolve conflicts to finish sync — open Sync panel"
            : "Open Sync panel"
        }
        title={mergePending ? "Resolve conflicts to finish sync" : "Open Sync"}
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
