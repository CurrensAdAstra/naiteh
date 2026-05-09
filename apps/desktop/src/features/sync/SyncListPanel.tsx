import { useCallback, useEffect, useState } from "react";

import {
  syncInit,
  syncNow,
  syncSetRemote,
  syncStatus,
} from "../../lib/api/sync";
import { formatRelative } from "../journal/formatRelative";
import { formatAppError, isAppError } from "../../lib/types";
import type { AppError, SyncStatus } from "../../lib/types";
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
  const [busy, setBusy] = useState<null | "init" | "remote" | "sync">(null);
  const [remoteDraft, setRemoteDraft] = useState("");

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
  }, []);

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
    } finally {
      setBusy(null);
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
                Conflicts that can&rsquo;t be fast-forwarded are surfaced as
                errors; in v1 you resolve them manually outside the app.
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
