import { LogOut } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../lib/api/auth";
import {
  formatAppError,
  type AuditLogEntry,
  type AuthUser,
} from "../../lib/types";
import { useAuthStore } from "../../state/authStore";
import styles from "./AdminDashboard.module.css";

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function AdminDashboard() {
  const session = useAuthStore((s) => s.session);
  const token = useAuthStore((s) => s.token);
  const clearSession = useAuthStore((s) => s.clearSession);
  const logAction = useAuthStore((s) => s.logAction);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (session === null || token === null) return;
    try {
      const [nextUsers, nextLogs] = await Promise.all([
        authListUsers(token),
        authListAuditLogs(token, 100),
      ]);
      setUsers(nextUsers);
      setLogs(nextLogs);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [session, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleToggle(user: AuthUser) {
    if (session === null || token === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await authSetUserActive(
        token,
        user.username,
        !user.active,
      );
      setUsers(next);
      setLogs(await authListAuditLogs(token, 100));
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await logAction("logout").catch(() => {});
    await clearSession();
  }

  return (
    <main className={styles.screen} data-testid="admin-dashboard">
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>naiteh Admin</h1>
          <p className={styles.subtitle}>{session?.username}</p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void handleLogout()}
          aria-label="Log out"
          title="Log out"
        >
          <LogOut size={16} aria-hidden="true" />
        </button>
      </header>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Accounts</h2>
        <div className={styles.rows}>
          {users.map((user) => (
            <div key={user.username} className={styles.accountRow}>
              <div className={styles.accountMeta}>
                <span className={styles.accountName}>{user.username}</span>
                <span className={styles.badge}>{user.role}</span>
                <span className={user.active ? styles.active : styles.disabled}>
                  {user.active ? "Active" : "Disabled"}
                </span>
              </div>
              <button
                type="button"
                className={styles.button}
                onClick={() => void handleToggle(user)}
                disabled={busy || user.username === "admin"}
                data-testid={`admin-account-toggle-${user.username}`}
              >
                {user.active ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Audit Log</h2>
        <div className={styles.rows}>
          {logs.length === 0 ? (
            <p className={styles.empty}>No log entries yet.</p>
          ) : (
            logs.map((entry, index) => (
              <div
                key={`${entry.timestamp}-${entry.action}-${index}`}
                className={styles.logRow}
              >
                <span className={styles.logTime}>{formatTime(entry.timestamp)}</span>
                <span className={styles.logAction}>{entry.action}</span>
                <span className={styles.logUser}>{entry.username}</span>
                {entry.detail !== null && (
                  <span className={styles.logDetail}>{entry.detail}</span>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
