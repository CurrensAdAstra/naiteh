import { useState } from "react";

import { formatAppError, USER_ROLES, type UserRole } from "../../lib/types";
import { PASSWORD_HINT, USERNAME_MAX_LENGTH, validateNewUser } from "./passwordRules";
import styles from "./AuthForms.module.css";

export interface CreateUserFormProps {
  /** Performs the creation; reject with an AppError to show it. */
  onCreate: (username: string, password: string, role: UserRole) => Promise<void>;
  /** Prefix for element ids and test ids; must be unique on the page. */
  idPrefix: string;
}

export function CreateUserForm({ onCreate, idPrefix }: CreateUserFormProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<UserRole>("User");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setCreated(null);
    const name = username.trim();
    const problem = validateNewUser({
      username: name,
      password,
      confirmPassword,
    });
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, password, role);
      setUsername("");
      setPassword("");
      setConfirmPassword("");
      setRole("User");
      setCreated(name);
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  const hintId = `${idPrefix}-hint`;

  return (
    <form
      className={styles.form}
      onSubmit={(e) => void handleSubmit(e)}
      noValidate
      data-testid={`${idPrefix}-form`}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-username`}>
          Username
        </label>
        <input
          id={`${idPrefix}-username`}
          className={styles.input}
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={USERNAME_MAX_LENGTH}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid={`${idPrefix}-username`}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-password`}>
          Password
        </label>
        <input
          id={`${idPrefix}-password`}
          className={styles.input}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={hintId}
          data-testid={`${idPrefix}-password`}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-confirm`}>
          Confirm password
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
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${idPrefix}-role`}>
          Role
        </label>
        <select
          id={`${idPrefix}-role`}
          className={styles.select}
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          data-testid={`${idPrefix}-role`}
        >
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <p className={styles.hint} id={hintId}>
        Usernames: 1–{USERNAME_MAX_LENGTH} letters, digits, “.”, “_” or “-”.
        Passwords: {PASSWORD_HINT.toLowerCase()}
      </p>
      {error !== null && (
        <p
          className={styles.error}
          role="alert"
          data-testid={`${idPrefix}-error`}
        >
          {error}
        </p>
      )}
      {created !== null && (
        <p
          className={styles.success}
          role="status"
          data-testid={`${idPrefix}-success`}
        >
          Created user “{created}”.
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="submit"
          className={`${styles.button} ${styles.primary}`}
          disabled={busy}
          data-testid={`${idPrefix}-submit`}
        >
          {busy ? "Creating…" : "Create user"}
        </button>
      </div>
    </form>
  );
}
