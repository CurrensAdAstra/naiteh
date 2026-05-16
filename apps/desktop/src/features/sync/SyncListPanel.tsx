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
import { formatRelative } from "../journal/formatRelative";
import { formatAppError, isAppError } from "../../lib/types";
import type { AppError, ConflictPair, SyncStatus } from "../../lib/types";
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

  const refreshConflicts = useCallback(async () => {
    try {
      const list = await syncListConflicts();
      setConflicts(list);
    } catch {
      // Non-fatal: conflict scan failing shouldn't blank the whole panel.
      setConflicts([]);
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
      await syncNow();
      await refresh();
    } catch (e) {
      setError(formatAppError(e));
      // Conflicts may have been written even though sync_now itself errored.
      await refreshConflicts();
    } finally {
      setBusy(null);
    }
  }

  async function handleKeepOurs(pair: ConflictPair) {
    setBusy("resolve");
    setError(null);
    try {
      await syncResolveKeepOurs(pair.conflictRelPath);
      await refreshConflicts();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleKeepTheirs(pair: ConflictPair) {
    setBusy("resolve");
    setError(null);
    try {
      await syncResolveKeepTheirs(pair.conflictRelPath, pair.relPath);
      await refreshConflicts();
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
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
                value={status.dirty ? "Pending changes" : "Up to date"}
                valueClass={
                  status.dirty
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
                disabled={busy !== null}
                data-testid="sync-now-button"
              >
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </button>
              <p className={styles.helpText}>
                Stages local changes and {status.remoteUrl !== null
                  ? "syncs them with the backup destination"
                  : "saves them locally"}
                .
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
