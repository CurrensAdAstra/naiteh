import { useState } from "react";

import { formatAppError } from "../../lib/types";
import { PASSWORD_HINT, validatePasswordChange } from "./passwordRules";
import styles from "./AuthForms.module.css";

export interface ChangePasswordFormProps {
  /** Account being changed — the new password may not equal it. */
  username: string;
  /** Prefill for the current password (forced change right after login). */
  initialCurrentPassword?: string;
  /** Performs the change; reject with an AppError to show it. */
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
  submitLabel?: string;
  /** Shown after a successful change (omit when the form goes away). */
  successMessage?: string;
  /** Prefix for element ids and test ids; must be unique on the page. */
  idPrefix: string;
  autoFocus?: boolean;
}

export function ChangePasswordForm({
  username,
  initialCurrentPassword = "",
  onSubmit,
  submitLabel = "Change password",
  successMessage,
  idPrefix,
  autoFocus = false,
}: ChangePasswordFormProps) {
  const [currentPassword, setCurrentPassword] = useState(initialCurrentPassword);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setDone(false);
    const problem = validatePasswordChange({
      username,
      currentPassword,
      newPassword,
      confirmPassword,
    });
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setDone(true);
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const hintId = `${idPrefix}-hint`;
  const errorId = `${idPrefix}-error`;
  const describedBy = error !== null ? `${hintId} ${errorId}` : hintId;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      data-testid={`${idPrefix}-form`}
    >
      {/* Lets password managers attach the new password to the account. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={username}
        readOnly
        hidden
      />
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-current`}>
          Current password
        </label>
        <input
          id={`${idPrefix}-current`}
          className={styles.input}
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoFocus={autoFocus && initialCurrentPassword === ""}
          data-testid={`${idPrefix}-current`}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-new`}>
          New password
        </label>
        <input
          id={`${idPrefix}-new`}
          className={styles.input}
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          aria-describedby={describedBy}
          aria-invalid={error !== null}
          autoFocus={autoFocus && initialCurrentPassword !== ""}
          data-testid={`${idPrefix}-new`}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-confirm`}>
          Confirm new password
        </label>
        <input
          id={`${idPrefix}-confirm`}
          className={styles.input}
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          data-testid={`${idPrefix}-confirm`}
        />
      </div>
      <p className={styles.hint} id={hintId}>
        {PASSWORD_HINT} Must differ from the current password.
      </p>
      {error !== null && (
        <p
          className={styles.error}
          role="alert"
          id={errorId}
          data-testid={`${idPrefix}-error`}
        >
          {error}
        </p>
      )}
      {done && successMessage !== undefined && (
        <p
          className={styles.success}
          role="status"
          data-testid={`${idPrefix}-success`}
        >
          {successMessage}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={busy}
          data-testid={`${idPrefix}-submit`}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
