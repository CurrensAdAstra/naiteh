import { useCallback, useEffect, useState } from "react";

import {
  syncInit,
  syncListConflicts,
  syncNow,
  syncResolveKeepOurs,
  syncResolveKeepTheirs,
  syncSetRemote,
  syncStatus,
} from "../../lib/api/sync";
import { openByRelPath } from "../../lib/openByRelPath";
import { reloadOpenDocument } from "../../lib/openDocument";
import { formatRelative } from "../journal/formatRelative";
import { formatAppError, isAppError } from "../../lib/types";
import type { AppError, ConflictPair, SyncStatus } from "../../lib/types";
import { discardPendingSave, flushPendingSave } from "../../state/autosave";
import { useEditorStore } from "../../state/editorStore";
import { useSyncStore } from "../../state/syncStore";
import { notifyVaultContentChanged } from "../../state/vaultContentStore";
import styles from "./SyncListPanel.module.css";

interface ViewState {
  /** null = not initialised yet (sync_status returned NotFound). */
  status: SyncStatus | null;
  loaded: boolean;
}

const NOT_INIT_KIND = "NotFound";

function isNotInitialized(err: unknown): err is AppError {
  return (
    isAppError(err) &&
    err.kind === NOT_INIT_KIND &&
    err.message.toLowerCase().includes("repository")
  );
}

export function SyncListPanel() {
  const [view, setView] = useState<ViewState>({ status: null, loaded: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "init" | "remote" | "sync" | "resolve"
  >(null);
  const [remoteDraft, setRemoteDraft] = useState("");
  const [conflicts, setConflicts] = useState<ConflictPair[]>([]);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const refreshConflicts = useCallback(async () => {
    try {
      const list = await syncListConflicts();
      setConflicts(list);
      setConflictError(null);
    } catch (e) {
      // Non-fatal: a failed conflict scan shouldn't blank the whole panel,
      // but the user must know the list may be incomplete. Keep the last
      // known conflicts rather than pretending there are none.
      setConflictError(`Couldn't check for conflicts: ${formatAppError(e)}`);
    }
  }, []);

  /**
   * If the open note is the conflict sidecar that a resolution just
   * removed, close it without saving so autosave can't recreate it.
   */
  const closeIfSidecarOpen = useCallback((pair: ConflictPair) => {
    const open = useEditorStore.getState().open;
    if (
      open !== null &&
      open.source.kind === "note" &&
      open.source.relPath === pair.conflictRelPath
    ) {
      discardPendingSave(open.key);
      useEditorStore.getState().closeNote();
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await syncStatus();
      setView({ status: s, loaded: true });
      setError(null);
      setRemoteDraft(s.remoteUrl ?? "");
    } catch (e) {
      if (isNotInitialized(e)) {
        setView({ status: null, loaded: true });
        setError(null);
      } else {
        setError(formatAppError(e));
        setView((prev) => ({ status: prev.status, loaded: true }));
      }
    }
    await refreshConflicts();
  }, [refreshConflicts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * After anything that may have rewritten vault files (sync, conflict
   * resolution): push fresh disk text into the open editor, tell list
   * panels to refetch, and refresh the status bar right away instead of
   * waiting for its 30 s poll. Errors land in the panel's error banner.
   */
  async function afterVaultChanged() {
    notifyVaultContentChanged();
    await useSyncStore.getState().refresh();
    try {
      await reloadOpenDocument();
    } catch (e) {
      setError(`Couldn't reload the open note: ${formatAppError(e)}`);
    }
  }

  async function handleInit() {
    setBusy("init");
    setError(null);
    try {
      await syncInit();
      await refresh();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveRemote() {
    const url = remoteDraft.trim();
    if (url === "") return;
    setBusy("remote");
    setError(null);
    try {
      await syncSetRemote(url);
      await refresh();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleSyncNow() {
    setBusy("sync");
    setError(null);
    try {
      // Get unsaved editor edits onto disk first so they're part of the
      // sync instead of being overwritten by (or overwriting) pulled text.
      await flushPendingSave();
      await syncNow();
      await refresh();
      await afterVaultChanged();
    } catch (e) {
      setError(formatAppError(e));
      // Files (and conflict sidecars) may have changed even though
      // sync_now itself errored.
      await refreshConflicts();
      await afterVaultChanged();
    } finally {
      setBusy(null);
    }
  }

  async function resolve(
    pair: ConflictPair,
    action: (conflictRelPath: string) => Promise<void>,
  ) {
    setBusy("resolve");
    setError(null);
    try {
      await flushPendingSave();
      await action(pair.conflictRelPath);
      // Resolution removes the sidecar; never let autosave recreate it.
      closeIfSidecarOpen(pair);
      // Status too, not just the list: resolving the last sidecar clears
      // `mergePending` and re-enables syncing.
      await refresh();
      await afterVaultChanged();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  function handleKeepOurs(pair: ConflictPair) {
    return resolve(pair, syncResolveKeepOurs);
  }

  function handleKeepTheirs(pair: ConflictPair) {
    return resolve(pair, syncResolveKeepTheirs);
  }

  async function handleOpenSide(relPath: string) {
    try {
      await openByRelPath(relPath);
    } catch (e) {
      setError(formatAppError(e));
    }
  }

  const initialized = view.status !== null;
  const status = view.status;
  const mergePending = status?.mergePending === true;
  // The backend refuses to sync until every sidecar is resolved; only
  // block the button when there's something visible to resolve, so an
  // unexpected state still lets the backend explain itself.
  const syncBlocked = mergePending && conflicts.length > 0;

  return (
    <div className={styles.panel} data-testid="list-panel-sync">
      <header className={styles.header}>
        <h2 className={styles.title}>Sync</h2>
      </header>
      <div className={styles.body}>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {conflictError !== null && (
          <p
            className={styles.error}
            role="alert"
            data-testid="sync-conflict-error"
          >
            {conflictError}
          </p>
        )}

        {!view.loaded && <p className={styles.busy}>Loading…</p>}

        {view.loaded && !initialized && (
          <section className={styles.actionGroup}>
            <p className={styles.helpText}>
              Sync is off. Initialize sync to start tracking changes; you can
              optionally pair the vault with a backup destination later.
            </p>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              onClick={() => void handleInit()}
              disabled={busy !== null}
              data-testid="sync-init-button"
            >
              {busy === "init" ? "Initializing…" : "Initialize sync"}
            </button>
          </section>
        )}

        {status !== null && (
          <>
            <section
              className={styles.statusCard}
              data-testid="sync-status-card"
            >
              <StatusRow
                label="Status"
                value={
                  mergePending
                    ? "Merge pending"
                    : status.dirty
                      ? "Pending changes"
                      : "Up to date"
                }
                valueClass={
                  mergePending || status.dirty
                    ? (styles.valueDirty ?? "")
                    : (styles.valueClean ?? "")
                }
              />
              <StatusRow
                label="Last sync"
                value={
                  status.lastSync !== null
                    ? formatRelative(status.lastSync)
                    : "Never"
                }
              />
              <StatusRow
                label="Backup destination"
                value={status.remoteUrl ?? "—"}
                valueClass={
                  status.remoteUrl === null
                    ? (styles.notInitialized ?? "")
                    : ""
                }
              />
              <StatusRow
                label="Branch"
                value={status.branch}
              />
              {status.remoteUrl !== null && (
                <StatusRow
                  label="Ahead / Behind"
                  value={`${status.ahead} / ${status.behind}`}
                />
              )}
            </section>

            {mergePending && (
              <p
                className={styles.mergeNotice}
                role="status"
                data-testid="sync-merge-pending"
              >
                <strong>Resolve conflicts to finish sync.</strong>{" "}
                {conflicts.length > 0
                  ? "The last pull is waiting on the conflicts below — syncing resumes once every one is resolved."
                  : "The last pull left conflicts that still need resolving."}
              </p>
            )}

            {conflicts.length > 0 && (
              <section
                className={styles.conflictSection}
                data-testid="sync-conflicts"
              >
                <h3 className={styles.subheading}>
                  Conflicts ({conflicts.length})
                </h3>
                <p className={styles.helpText}>
                  The remote diverged on these files. Each has a sidecar
                  saved as <code>.conflict-…</code> — pick which version
                  to keep, or open both and merge by hand.
                </p>
                <ul className={styles.conflictList}>
                  {conflicts.map((c) => (
                    <li
                      key={c.conflictRelPath}
                      className={styles.conflictRow}
                      data-testid={`conflict-${c.relPath}`}
                    >
                      <div className={styles.conflictMeta}>
                        <span className={styles.conflictPath}>{c.relPath}</span>
                        <span className={styles.conflictTimestamp}>
                          {c.timestamp}
                        </span>
                      </div>
                      <div className={styles.actionGroupRow}>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => void handleOpenSide(c.relPath)}
                          disabled={busy !== null}
                          data-testid={`conflict-open-ours-${c.relPath}`}
                        >
                          Open mine
                        </button>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() =>
                            void handleOpenSide(c.conflictRelPath)
                          }
                          disabled={busy !== null}
                          data-testid={`conflict-open-theirs-${c.relPath}`}
                        >
                          Open theirs
                        </button>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => void handleKeepOurs(c)}
                          disabled={busy !== null}
                          data-testid={`conflict-keep-ours-${c.relPath}`}
                        >
                          Keep mine
                        </button>
                        <button
                          type="button"
                          className={`${styles.button} ${styles.primary}`}
                          onClick={() => void handleKeepTheirs(c)}
                          disabled={busy !== null}
                          data-testid={`conflict-keep-theirs-${c.relPath}`}
                        >
                          Keep theirs
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className={styles.actionGroup}>
              <button
                type="button"
                className={`${styles.button} ${styles.primary}`}
                onClick={() => void handleSyncNow()}
                disabled={busy !== null || syncBlocked}
                aria-describedby="sync-now-help"
                data-testid="sync-now-button"
              >
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </button>
              <p className={styles.helpText} id="sync-now-help">
                {syncBlocked ? (
                  "Unavailable until all conflicts are resolved."
                ) : (
                  <>
                    Stages local changes and{" "}
                    {status.remoteUrl !== null
                      ? "syncs them with the backup destination"
                      : "saves them locally"}
                    .
                  </>
                )}
              </p>
            </section>

            <section className={styles.remoteForm}>
              <label className={styles.label} htmlFor="remote-input">
                Backup destination URL
              </label>
              <input
                id="remote-input"
                type="text"
                className={styles.remoteInput}
                placeholder="https://github.com/you/vault.git"
                value={remoteDraft}
                onChange={(e) => setRemoteDraft(e.target.value)}
                data-testid="sync-remote-input"
              />
              <div className={styles.actionGroupRow}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void handleSaveRemote()}
                  disabled={busy !== null || remoteDraft.trim() === ""}
                  data-testid="sync-save-remote-button"
                >
                  {busy === "remote" ? "Saving…" : "Save destination"}
                </button>
              </div>
              <p className={styles.helpText}>
                Diverged remote edits are saved as <code>.conflict-…</code>
                sidecars and surface in the Conflicts section above —
                pick "Keep mine" or "Keep theirs" to resolve.
              </p>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

interface StatusRowProps {
  label: string;
  value: string;
  valueClass?: string;
}

function StatusRow({ label, value, valueClass = "" }: StatusRowProps) {
  return (
    <div className={styles.statusRow}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${valueClass}`}>{value}</span>
    </div>
  );
}
