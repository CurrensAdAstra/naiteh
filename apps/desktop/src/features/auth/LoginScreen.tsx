import { LockKeyhole } from "lucide-react";
import { useState } from "react";

import { useAuthStore } from "../../state/authStore";
import { PASSWORD_HINT, validateLockPassword } from "./passwordRules";
import styles from "./LoginScreen.module.css";

/** Startup access, password-only unlock, or explicit one-time legacy conversion. */
export function LoginScreen() {
  const { ready, busy, error, accessNotice, migrationRequired, bootstrap, unlock, migrate, draftRecovery, token, returnToDraftVault } = useAuthStore();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const working = busy !== null;
  const recovering = draftRecovery !== null && token !== null;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working || !ready) return;
    setValidation(null);
    if (migrationRequired) {
      const problem = validateLockPassword(newPassword, confirmation, password);
      if (problem !== null) {
        setValidation(problem);
        return;
      }
    }
    const succeeded = migrationRequired
      ? await migrate(username, password, newPassword)
      : await unlock(password);
    if (succeeded) {
      setUsername("");
      setPassword("");
      setNewPassword("");
      setConfirmation("");
    }
  }

  return (
    <main className={styles.screen} data-testid="login-screen">
      <form className={styles.form} onSubmit={(event) => void submit(event)} aria-labelledby="access-title">
        <div className={styles.mark} aria-hidden="true"><LockKeyhole size={20} /></div>
        <h1 className={styles.title} id="access-title">
          {recovering ? "Recover unsaved drafts" : !ready ? "naiteh" : migrationRequired ? "Convert to an app lock" : "Unlock naiteh"}
        </h1>
        {accessNotice !== null && <p className={styles.notice} role="status">{accessNotice}</p>}
        {recovering ? (
          <>
            <p className={styles.intro}>
              App access is unlocked, but draft recovery is paused. Your edits remain only
              in this window&apos;s memory, not confirmed saved. Keep this window open.
            </p>
            <p className={styles.intro}>Draft vault: {draftRecovery.vaultRoot ?? "unknown"}</p>
            <button type="button" className={styles.button} onClick={() => void bootstrap()} disabled={working}>
              {working ? "Checking draft recovery..." : "Retry draft recovery"}
            </button>
            <button type="button" className={styles.button} onClick={() => void returnToDraftVault()} disabled={working || draftRecovery.vaultRoot === null}>
              Return to draft vault
            </button>
          </>
        ) : !ready ? (
          <>
            <p className={styles.intro}>{working ? "Checking app access..." : "App access could not be checked. No access has been granted."}</p>
            {!working && <button type="button" className={styles.button} onClick={() => void bootstrap()}>Retry access</button>}
          </>
        ) : (
          <>
            {migrationRequired ? (
              <p className={styles.intro}>
                This installation has legacy accounts. Verify your active legacy account
                credentials and choose a new app-lock password to convert this device to
                single-user local access. Conversion enables the lock and removes legacy
                remembered sign-ins; it does not select another account or disable protection.
              </p>
            ) : <p className={styles.intro}>Enter your app-lock password to continue.</p>}
            <div className={styles.fields}>
              {migrationRequired && (
                <label className={styles.field}>
                  <span className={styles.label}>Legacy username</span>
                  <input className={styles.input} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required disabled={working} />
                </label>
              )}
              <label className={styles.field}>
                <span className={styles.label}>{migrationRequired ? "Legacy password" : "Password"}</span>
                <input className={styles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!migrationRequired} required disabled={working} />
              </label>
              {migrationRequired && (
                <>
                  <label className={styles.field}>
                    <span className={styles.label}>New app-lock password</span>
                    <input className={styles.input} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" aria-describedby="migration-password-hint" required disabled={working} />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>Confirm new password</span>
                    <input className={styles.input} type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required disabled={working} />
                  </label>
                  <p className={styles.intro} id="migration-password-hint">{PASSWORD_HINT}</p>
                </>
              )}
            </div>
            <p className={styles.intro}>
              Markdown files remain unencrypted plaintext. The lock only gates this app&apos;s
              backend commands (IPC), not direct access to your files or remote copies.
            </p>
            <button className={styles.button} type="submit" disabled={working || password === "" || (migrationRequired && username.trim() === "")}>
              {working ? "Please wait..." : migrationRequired ? "Convert and enable app lock" : "Unlock"}
            </button>
          </>
        )}
        {(validation ?? error) !== null && <p className={styles.error} role="alert">{validation ?? error}</p>}
      </form>
    </main>
  );
}
