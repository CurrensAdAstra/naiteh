import { LockKeyhole } from "lucide-react";
import { useMemo, useState } from "react";

import { authLogin } from "../../lib/api/auth";
import { formatAppError, type AuthSession } from "../../lib/types";
import styles from "./LoginScreen.module.css";

interface LoginScreenProps {
  onLogin: (token: string, session: AuthSession) => void;
}

function initialUsername(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.replace(/\/+$/, "") === "/admin" ? "admin" : "";
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
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
      const result = await authLogin(username, password);
      onLogin(result.token, result.session);
    } catch (err) {
      setError(formatAppError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen} data-testid="login-screen">
      <form className={styles.form} onSubmit={handleSubmit}>
        <div className={styles.mark} aria-hidden="true">
          <LockKeyhole size={20} />
        </div>
        <h1 className={styles.title}>naiteh</h1>
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
