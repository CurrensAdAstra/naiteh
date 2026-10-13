import { HardDrive, MoreHorizontal, Server } from "lucide-react";
import { useEffect, useState } from "react";

import {
  backupTargetRemove,
  backupTargetUpdate,
  backupTest,
  type BackupRunResult,
  type BackupTarget,
  type UpdateTargetArgs,
} from "../../../lib/api/backup";
import { formatAppError } from "../../../lib/types";
import { subscribeBackupEvents, useBackupStore } from "../../../state/backupStore";
import { useUIStore } from "../../../state/uiStore";
import {
  AddDriveDialog,
  AddSftpDialog,
  EditTargetDialog,
} from "../../backup/TargetDialogs";
import b from "../../backup/Backup.module.css";
import { formatBackupTime } from "../../backup/backupFormat";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";
import local from "./BackupSection.module.css";

/**
 * Backup targets: copies of the vault in a Google Drive for desktop
 * folder and/or on an SFTP server, each backed up on demand or on a
 * timer, plus "Compare copies" (local vs every target). The in-app Sync
 * (Git) stays optional. See vault/wiki/vault-and-data.md ("Backup").
 */

function targetLocation(t: BackupTarget): string {
  if (t.drive !== undefined) return t.drive.folder;
  if (t.sftp !== undefined) {
    const port = t.sftp.port === 22 ? "" : `:${t.sftp.port}`;
    return `${t.sftp.username}@${t.sftp.host}${port}:${t.sftp.remoteDir}`;
  }
  return "";
}

function resultSummary(r: BackupRunResult): string {
  if (r.error !== null) return `Failed: ${r.error}`;
  return `${r.uploaded} uploaded, ${r.trashed} moved to trash, ${r.unchanged} unchanged`;
}

type Dialog =
  | { kind: "drive" }
  | { kind: "sftp" }
  | { kind: "edit"; target: BackupTarget }
  | null;

function TargetRow({
  target,
  onEdit,
}: {
  target: BackupTarget;
  onEdit: () => void;
}) {
  const upsertTarget = useBackupStore((s) => s.upsertTarget);
  const dropTarget = useBackupStore((s) => s.dropTarget);
  const runBackup = useBackupStore((s) => s.runBackup);
  const running = useBackupStore((s) => s.running);
  const progress = useBackupStore((s) => s.progress[target.id] ?? null);
  const result = useBackupStore(
    (s) => s.lastResults?.find((r) => r.targetId === target.id) ?? null,
  );
  const [interval, setIntervalText] = useState(String(target.intervalMinutes));
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  useEffect(() => {
    setIntervalText(String(target.intervalMinutes));
  }, [target.intervalMinutes]);

  async function update(args: Omit<UpdateTargetArgs, "id">) {
    setMessage(null);
    try {
      upsertTarget(await backupTargetUpdate({ id: target.id, ...args }));
    } catch (e) {
      setMessage({ ok: false, text: formatAppError(e) });
    }
  }

  function commitInterval() {
    const n = Math.round(Number(interval));
    if (!Number.isFinite(n) || n < 1) {
      setIntervalText(String(target.intervalMinutes));
      return;
    }
    if (n !== target.intervalMinutes) void update({ intervalMinutes: n });
  }

  async function test() {
    setMessage({ ok: true, text: "Testing…" });
    try {
      await backupTest(target.id);
      setMessage({ ok: true, text: "Connection OK" });
    } catch (e) {
      setMessage({ ok: false, text: formatAppError(e) });
    }
  }

  async function remove() {
    try {
      await backupTargetRemove(target.id);
      dropTarget(target.id);
    } catch (e) {
      setConfirmRemove(false);
      setMessage({ ok: false, text: formatAppError(e) });
    }
  }

  const Icon = target.kind === "drive" ? HardDrive : Server;
  const pct =
    progress !== null && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;
  const awaitingTrust =
    target.kind === "sftp" && target.sftp?.hostKeyFingerprint === null;

  return (
    <li className={b.targetRow} data-testid={`backup-target-${target.id}`}>
      <div className={b.targetHead}>
        <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
        <span className={b.targetText}>
          <span className={b.targetName}>
            {target.name}
            <span className={b.kindLabel}>
              {target.kind === "drive" ? "Google Drive" : "SFTP"}
            </span>
          </span>
          <code className={b.targetLoc}>{targetLocation(target)}</code>
        </span>
        <label className={b.switchLabel}>
          <button
            type="button"
            role="switch"
            aria-checked={target.enabled}
            aria-label={`Back up to ${target.name}`}
            className={`${styles.toggle} ${target.enabled ? styles.toggleOn : ""}`}
            onClick={() => void update({ enabled: !target.enabled })}
            data-testid={`backup-enabled-${target.id}`}
          />
          Enabled
        </label>
      </div>

      <div className={b.targetControls}>
        <label className={b.switchLabel}>
          <button
            type="button"
            role="switch"
            aria-checked={target.autoBackup}
            aria-label={`Back up ${target.name} automatically`}
            className={`${styles.toggle} ${target.autoBackup ? styles.toggleOn : ""}`}
            onClick={() => void update({ autoBackup: !target.autoBackup })}
            disabled={!target.enabled}
            data-testid={`backup-auto-${target.id}`}
          />
          Automatically every
        </label>
        <input
          className={styles.numberInput}
          value={interval}
          inputMode="numeric"
          aria-label={`Minutes between automatic backups to ${target.name}`}
          onChange={(e) => setIntervalText(e.currentTarget.value)}
          onBlur={commitInterval}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitInterval();
          }}
          disabled={!target.autoBackup || !target.enabled}
          data-testid={`backup-interval-${target.id}`}
        />
        <span>min</span>
        <span className={b.spacer} />
        <button
          type="button"
          className={styles.button}
          onClick={() => void runBackup(target.id)}
          disabled={running || !target.enabled || awaitingTrust}
          data-testid={`backup-run-${target.id}`}
        >
          Back up now
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => void test()}
          data-testid={`backup-test-${target.id}`}
        >
          Test
        </button>
        <span className={b.menuHost}>
          <button
            type="button"
            className={styles.button}
            aria-label={`More actions for ${target.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
            data-testid={`backup-more-${target.id}`}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
          {menuOpen && (
            <span className={b.menu} role="menu">
              <button
                type="button"
                role="menuitem"
                className={b.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  onEdit();
                }}
                data-testid={`backup-edit-${target.id}`}
              >
                Edit…
              </button>
              <button
                type="button"
                role="menuitem"
                className={b.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmRemove(true);
                }}
                data-testid={`backup-remove-${target.id}`}
              >
                Remove…
              </button>
            </span>
          )}
        </span>
      </div>

      {pct !== null && progress !== null && (
        <div className={b.progressWrap} data-testid={`backup-progress-${target.id}`}>
          <progress
            className={b.progress}
            max={progress.total}
            value={progress.done}
            aria-label={`Backing up to ${target.name}`}
          />
          <span className={b.meta}>
            {progress.done}/{progress.total} · {progress.relPath}
          </span>
        </div>
      )}

      <div className={b.meta} data-testid={`backup-status-${target.id}`}>
        {awaitingTrust && <span className={b.warnText}>Server key not trusted yet. </span>}
        {target.lastBackupAt !== null
          ? `Last backup: ${formatBackupTime(target.lastBackupAt)}`
          : "Never backed up"}
        {target.lastError !== null && (
          <span className={b.errorText}> · Last error: {target.lastError}</span>
        )}
      </div>
      {result !== null && (
        <div
          className={result.error === null ? b.meta : b.errorText}
          data-testid={`backup-result-${target.id}`}
        >
          {resultSummary(result)}
        </div>
      )}
      {message !== null && (
        <div
          className={message.ok ? b.meta : b.errorText}
          role="status"
          data-testid={`backup-message-${target.id}`}
        >
          {message.text}
        </div>
      )}
      {confirmRemove && (
        <div className={b.confirm} role="alertdialog" aria-label="Remove target">
          <span>
            Remove &ldquo;{target.name}&rdquo; from naiteh? Files already
            backed up there are <strong>not deleted</strong>.
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => void remove()}
            data-testid={`backup-remove-confirm-${target.id}`}
          >
            Remove
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => setConfirmRemove(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

export function BackupSection() {
  const targets = useBackupStore((s) => s.targets);
  const loaded = useBackupStore((s) => s.loaded);
  const loadError = useBackupStore((s) => s.loadError);
  const loadTargets = useBackupStore((s) => s.loadTargets);
  const upsertTarget = useBackupStore((s) => s.upsertTarget);
  const runBackup = useBackupStore((s) => s.runBackup);
  const running = useBackupStore((s) => s.running);
  const lastResults = useBackupStore((s) => s.lastResults);
  const lastRunError = useBackupStore((s) => s.lastRunError);
  const setCompareOpen = useBackupStore((s) => s.setCompareOpen);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    void loadTargets();
    return subscribeBackupEvents();
  }, [loadTargets]);

  function openSyncPanel() {
    setViewMode("sync");
    setSettingsOpen(false);
  }

  function openCompare() {
    setSettingsOpen(false);
    setCompareOpen(true);
  }

  function added(t: BackupTarget) {
    upsertTarget(t);
    setDialog(null);
  }

  const totals = lastResults?.reduce(
    (acc, r) => ({
      uploaded: acc.uploaded + r.uploaded,
      trashed: acc.trashed + r.trashed,
      unchanged: acc.unchanged + r.unchanged,
    }),
    { uploaded: 0, trashed: 0, unchanged: 0 },
  );
  const anyEnabled = targets.some((t) => t.enabled);

  return (
    <div data-testid="settings-backup">
      <h2 className={styles.sectionHeading}>Backup</h2>
      <p className={styles.sectionIntro}>
        Keep copies of your vault in a <strong>Google Drive</strong> folder
        and on your own <strong>SFTP server</strong>. Each backup uploads
        only what changed; files you deleted are moved to a trash folder on
        the backup, not erased. Use <strong>Compare copies</strong> to check
        that all copies match.
      </p>

      <SettingItem
        name="Backup targets"
        stacked
        testId="settings-backup-targets"
        description="Where naiteh copies the vault. Turn on automatic backup to run it on a timer while naiteh is open."
      >
        {loadError !== null && (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        )}
        {loaded && targets.length === 0 && (
          <p className={styles.emptyNote} data-testid="backup-targets-empty">
            No backup targets yet. Add a Google Drive folder or an SFTP
            server below.
          </p>
        )}
        <ul className={b.targetList}>
          {targets.map((t) => (
            <TargetRow
              key={t.id}
              target={t}
              onEdit={() => setDialog({ kind: "edit", target: t })}
            />
          ))}
        </ul>
        {dialog === null && (
          <div className={styles.actionRow}>
            <button
              type="button"
              className={styles.button}
              onClick={() => setDialog({ kind: "drive" })}
              data-testid="backup-add-drive-open"
            >
              + Add Google Drive folder
            </button>
            <button
              type="button"
              className={styles.button}
              onClick={() => setDialog({ kind: "sftp" })}
              data-testid="backup-add-sftp-open"
            >
              + Add SFTP server
            </button>
          </div>
        )}
        {dialog?.kind === "drive" && (
          <AddDriveDialog onClose={() => setDialog(null)} onAdded={added} />
        )}
        {dialog?.kind === "sftp" && (
          <AddSftpDialog onClose={() => setDialog(null)} onAdded={added} />
        )}
        {dialog?.kind === "edit" && (
          <EditTargetDialog
            target={dialog.target}
            onClose={() => setDialog(null)}
            onSaved={added}
          />
        )}
      </SettingItem>

      <SettingItem
        name="Back up and compare"
        stacked
        testId="settings-backup-actions"
        description="Back up every enabled target now, or compare the local vault with each backup file by file."
      >
        <div className={styles.actionRow}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => void runBackup(null)}
            disabled={running || !anyEnabled}
            data-testid="backup-run-all"
          >
            {running ? "Backing up…" : "Back up all now"}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={openCompare}
            disabled={targets.length === 0}
            data-testid="backup-compare-open"
          >
            Compare copies…
          </button>
        </div>
        {totals !== undefined && !running && (
          <p className={b.meta} role="status" data-testid="backup-summary">
            Last run: {totals.uploaded} uploaded, {totals.trashed} moved to
            trash, {totals.unchanged} unchanged.
          </p>
        )}
        {lastRunError !== null && !running && (
          <p className={styles.error} role="alert" data-testid="backup-run-error">
            {lastRunError}
          </p>
        )}
      </SettingItem>

      <SettingItem
        name="What the backup includes"
        description={
          <>
            Everything inside the vault folder: notes, journal, attachments
            and Evernote imports. naiteh&rsquo;s own settings, accounts and AI
            key are stored on this computer outside the vault and are{" "}
            <strong>not</strong> part of it. SFTP passwords and passphrases
            are kept in naiteh&rsquo;s settings, never in the vault.
          </>
        }
      />

      <SettingItem
        name="Good to know"
        stacked
        description="Backups are one-way copies:"
      >
        <ul className={local.caveats}>
          <li>
            A backup never changes your local notes. To bring a file back,
            open <strong>Compare copies</strong> and restore it — as a copy
            by default.
          </li>
          <li>
            Removing a target only makes naiteh forget it; the files already
            on Drive or the server stay there.
          </li>
          <li>
            Google Drive targets need <strong>Google Drive for
            desktop</strong> signed in; Drive does the uploading.
          </li>
        </ul>
      </SettingItem>

      <SettingItem
        name="Optional: in-app Sync"
        stacked
        testId="settings-backup-sync"
        description="The Sync panel can also keep a version history with a Git service such as GitHub. It is optional and has limits:"
      >
        <ul className={local.caveats}>
          <li>
            Use a <strong>private</strong> repository — notes are uploaded
            unencrypted.
          </li>
          <li>
            GitHub rejects files over <strong>100 MB</strong>. One large
            attachment (common in Evernote imports) stops every later sync.
          </li>
          <li>
            Attachments stay in the history even after you delete them, so
            the repository only grows.
          </li>
        </ul>
        <button
          type="button"
          className={styles.button}
          onClick={openSyncPanel}
          data-testid="settings-backup-open-sync"
        >
          Open Sync panel
        </button>
      </SettingItem>
    </div>
  );
}
