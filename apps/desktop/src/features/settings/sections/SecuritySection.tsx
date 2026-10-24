import { useState } from "react";

import { authMigrateSecrets } from "../../../lib/api/auth";
import { formatAppError } from "../../../lib/types";
import { useAuthStore } from "../../../state/authStore";
import { PASSWORD_HINT, validateLockPassword } from "../../auth/passwordRules";
import formStyles from "../../auth/AuthForms.module.css";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

export function SecuritySection() {
  const { token, session, lockEnabled, busy, error, setLock, lock } = useAuthStore();
  const [enabled, setEnabled] = useState(lockEnabled === true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationSuccess, setMigrationSuccess] = useState<string | null>(null);
  const disabled = busy !== null || session === null || lockEnabled === null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    setSuccess(null);
    let problem: string | null = null;
    if (lockEnabled && currentPassword === "") problem = "Enter your current app-lock password.";
    const changing = enabled && (!lockEnabled || newPassword !== "" || confirmation !== "");
    if (problem === null && changing) {
      problem = validateLockPassword(newPassword, confirmation, lockEnabled ? currentPassword : null);
    }
    setValidation(problem);
    if (problem !== null) return;
    if (await setLock(enabled, lockEnabled ? currentPassword : null, changing ? newPassword : null)) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSuccess(enabled ? "App lock saved. This window remains unlocked." : "App lock disabled. This window remains unlocked; future launches open without a password.");
    }
  }

  async function migrateSecrets() {
    if (token === null || disabled || migrating) return;
    setMigrating(true);
    setMigrationError(null);
    setMigrationSuccess(null);
    try {
      await authMigrateSecrets(token);
      setMigrationSuccess("Secure storage migration completed. Legacy API and SFTP secrets have been migrated, or none remain to migrate.");
    } catch (err) {
      setMigrationError(`Secure storage migration failed: ${formatAppError(err)}. No plaintext fallback was used. Fix OS credential storage access, then retry.`);
    } finally {
      setMigrating(false);
    }
  }

  return (
    <div data-testid="settings-security">
      <h2 className={styles.sectionHeading}>Security</h2>
      <p className={styles.sectionIntro}>
        Single-user, local-first access. App lock is {lockEnabled === null ? "not yet known" : lockEnabled ? "enabled" : "disabled"}.
        An enabled lock is checked at startup or when you lock the app manually, not on a session timer.
      </p>
      <SettingItem name="App lock" description="The lock only gates this app's backend commands (IPC). It does not encrypt the vault." stacked>
        <form className={formStyles.form} onSubmit={(event) => void submit(event)}>
          <label className={formStyles.label}>
            <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setSuccess(null); setValidation(null); }} disabled={disabled} />{" "}
            Enable app lock
          </label>
          {lockEnabled && (
            <label className={formStyles.field}>
              <span className={formStyles.label}>Current app-lock password</span>
              <input className={formStyles.input} type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" disabled={disabled} />
            </label>
          )}
          {enabled && (
            <>
              <label className={formStyles.field}>
                <span className={formStyles.label}>New app-lock password</span>
                <input className={formStyles.input} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" aria-describedby="lock-password-hint" disabled={disabled} />
              </label>
              <label className={formStyles.field}>
                <span className={formStyles.label}>Confirm new password</span>
                <input className={formStyles.input} type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" disabled={disabled} />
              </label>
              <p className={formStyles.hint} id="lock-password-hint">
                {PASSWORD_HINT}{lockEnabled ? " Leave both new-password fields empty to keep the existing password." : " A password is required to enable the lock."}
              </p>
            </>
          )}
          {(validation ?? error) !== null && <p className={formStyles.error} role="alert">{validation ?? error}</p>}
          {success !== null && <p className={formStyles.success} role="status">{success}</p>}
          <div className={formStyles.actions}>
            <button type="submit" className={`${formStyles.button} ${formStyles.primary}`} disabled={disabled}>Save app lock</button>
            {lockEnabled && <button type="button" className={formStyles.button} onClick={() => { setValidation(null); setSuccess(null); void lock(); }} disabled={disabled}>Lock now</button>}
          </div>
        </form>
      </SettingItem>
      <SettingItem name="Files and copies" stacked>
        <p className={styles.sectionIntro}>
          Markdown notes and attachments remain unencrypted on disk. Use OS permissions and
          disk encryption to protect a powered-off device. Disk encryption does not protect
          remote copies or against malware while the device is unlocked. A private Git
          repository or SFTP connection is not content encryption: remote storage still
          contains readable files. Protect backups and synced copies separately.
        </p>
      </SettingItem>
      <SettingItem name="OS credential storage" stacked>
        <p className={styles.sectionIntro}>
          API keys and SFTP passwords belong in OS credential storage, not plaintext config.
          Legacy secrets are removed from plaintext only after secure storage succeeds.
          If credential storage is unavailable or migration fails, affected commands report
          an error instead of falling back to plaintext. This does not encrypt your notes,
          remote content, or credentials used by external tools.
        </p>
        <button type="button" className={formStyles.button} onClick={() => void migrateSecrets()} disabled={disabled || migrating}>
          {migrating ? "Migrating secrets..." : "Retry secure storage migration"}
        </button>
        {migrationError !== null && <p className={formStyles.error} role="alert">{migrationError}</p>}
        {migrationSuccess !== null && <p className={formStyles.success} role="status">{migrationSuccess}</p>}
      </SettingItem>
    </div>
  );
}
