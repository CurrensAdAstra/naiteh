import { KeyRound, LockKeyhole } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { authLogin } from "../../lib/api/auth";
import { formatAppError, type AuthSession } from "../../lib/types";
import { useAuthStore } from "../../state/authStore";
import { ChangePasswordForm } from "./ChangePasswordForm";
import styles from "./LoginScreen.module.css";

interface LoginScreenProps {
  onLogin: (token: string, session: AuthSession) => void;
}

function initialUsername(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.replace(/\/+$/, "") === "/admin" ? "admin" : "";
}

/**
 * Sign-in, plus the forced "set a new password" step. A login (or a
 * resumed session) the backend flags with `mustChangePassword` is held
 * in `authStore.pendingPasswordChange` — the app keeps rendering this
 * screen until the change succeeds or the user signs out.
 */
export function LoginScreen({ onLogin }: LoginScreenProps) {
  const pending = useAuthStore((s) => s.pendingPasswordChange);
  const signedOutReason = useAuthStore((s) => s.signedOutReason);
  const setSession = useAuthStore((s) => s.setSession);
  const completePasswordChange = useAuthStore((s) => s.completePasswordChange);
  const clearSession = useAuthStore((s) => s.clearSession);

  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  // The password just used to sign in, offered as "current password" in
  // the change step so the user doesn't have to type it twice. A ref, not
  // state: it must be in place on the very render that shows the step
  // (the store update can render before batched state updates land).
  const changePrefill = useRef("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = useMemo(
    () => username.trim() !== "" && password !== "" && !busy,
    [busy, password, username],
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authLogin(username, password, remember);
      if (result.mustChangePassword) {
        changePrefill.current = password;
        setPassword("");
        setSession(result.token, result.session, true);
      } else {
        onLogin(result.token, result.session);
      }
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelChange() {
    changePrefill.current = "";
    await clearSession();
  }

  if (pending !== null) {
    return (
      <main className={styles.screen} data-testid="login-screen">
        <section
          className={styles.form}
          aria-labelledby="password-change-title"
          data-testid="password-change-step"
        >
          <div className={styles.mark} aria-hidden="true">
            <KeyRound size={20} />
          </div>
          <h1 className={styles.title} id="password-change-title">
            Set a new password
          </h1>
          <p className={styles.intro}>
            Signed in as <strong>{pending.session.username}</strong>. This
            account must choose a new password before continuing.
          </p>
          <ChangePasswordForm
            username={pending.session.username}
            initialCurrentPassword={changePrefill.current}
            onSubmit={completePasswordChange}
            submitLabel="Set password and continue"
            idPrefix="forced-password"
            autoFocus
          />
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void handleCancelChange()}
            data-testid="password-change-signout"
          >
            Sign out instead
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.screen} data-testid="login-screen">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.mark} aria-hidden="true">
          <LockKeyhole size={20} />
        </div>
        <h1 className={styles.title}>naiteh</h1>
        {signedOutReason !== null && error === null && (
          <p className={styles.notice} role="status" data-testid="login-notice">
            {signedOutReason}
          </p>
        )}
        <div className={styles.fields}>
          <label className={styles.field}>
            <span className={styles.label}>User</span>
            <input
              className={styles.input}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              data-testid="login-username"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Password</span>
            <input
              className={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              data-testid="login-password"
            />
          </label>
        </div>
        <label className={styles.remember}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            data-testid="login-remember"
          />
          <span>Keep me signed in on this device</span>
        </label>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className={styles.button}
          disabled={!canSubmit}
          data-testid="login-submit"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
