import { useCallback, useEffect, useState } from "react";

import {
  evernoteImport,
  listenEvernoteImportProgress,
  type EvernoteImportProgress,
} from "../../../lib/api/evernote";
import {
  formatAppError,
  isAppError,
  type EvernoteImportReport,
} from "../../../lib/types";
import { useAuthStore } from "../../../state/authStore";
import { useUIStore } from "../../../state/uiStore";
import { useVaultStore } from "../../../state/vaultStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

export function ImportSection() {
  const activeVault = useVaultStore((s) => s.active);
  const logAction = useAuthStore((s) => s.logAction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<EvernoteImportReport | null>(null);
  const [progress, setProgress] = useState<EvernoteImportProgress | null>(null);

  const runImport = useCallback(async () => {
    setBusy(true);
    setError(null);
    setProgress(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listenEvernoteImportProgress(setProgress);
      const next = await evernoteImport();
      setReport(next);
      void logAction(
        "evernote_import",
        `imported=${next.importedCount} failed=${next.failedCount}`,
      ).catch(() => {});
    } catch (e) {
      if (isAppError(e) && e.kind === "Cancelled") return;
      setError(formatAppError(e));
    } finally {
      if (unlisten !== null) unlisten();
      setProgress(null);
      setBusy(false);
    }
  }, [logAction]);

  // The native File ▸ Import menu routes here via uiStore (the modal
  // also switches to this section): fire the picker once.
  const pendingAction = useUIStore((s) => s.pendingAction);
  const clearPendingAction = useUIStore((s) => s.clearPendingAction);
  useEffect(() => {
    if (pendingAction === "evernoteImport") {
      clearPendingAction();
      void runImport();
    }
  }, [pendingAction, clearPendingAction, runImport]);

  const withWarnings =
    report?.notes.filter((n) => n.warnings.length > 0).length ?? 0;

  return (
    <div data-testid="settings-evernote-import">
      <h2 className={styles.sectionHeading}>Import from Evernote</h2>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <SettingItem
        name="Choose .enex files"
        description={
          <>
            naiteh converts each note to Markdown under{" "}
            <code>notes/&lt;notebook&gt;/&lt;slug&gt;/</code> with its
            attachments alongside. Your Evernote items stay untouched.
          </>
        }
      >
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={() => void runImport()}
          disabled={busy || activeVault === null}
          data-testid="evernote-import-button"
        >
          {busy ? "Importing…" : "Choose .enex files…"}
        </button>
      </SettingItem>
      {busy && progress !== null && (
        <p
          className={styles.progressReport}
          role="status"
          data-testid="evernote-import-progress"
        >
          Importing {progress.fileName} — {progress.noteDone}/
          {progress.noteTotal} notes
          {progress.totalFiles > 1 &&
            ` · file ${progress.fileIndex + 1}/${progress.totalFiles}`}
        </p>
      )}
      {report !== null && (
        <div className={styles.progressReport} data-testid="evernote-import-summary">
          <div>
            Imported {report.importedCount} note
            {report.importedCount === 1 ? "" : "s"}
            {report.failedCount > 0 && `, ${report.failedCount} failed`}.
          </div>
          {report.errors.length > 0 && (
            <ul>
              {report.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
          {withWarnings > 0 && (
            <div>
              {withWarnings} note{withWarnings === 1 ? "" : "s"} have import
              warnings — see <code>import_warnings:</code> in the note&rsquo;s
              YAML front matter.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
