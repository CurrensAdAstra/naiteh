import type { AuthUser } from "../../lib/types";
import styles from "./AuthForms.module.css";

/** The built-in admin account can't be disabled (it's the way back in). */
export const LOCKED_USERNAME = "admin";

export interface AccountListProps {
  users: readonly AuthUser[];
  busy: boolean;
  onToggle: (user: AuthUser) => void;
  /** Toggle buttons get `${testIdPrefix}-${username}`. */
  testIdPrefix: string;
  emptyText?: string;
}

export function AccountList({
  users,
  busy,
  onToggle,
  testIdPrefix,
  emptyText = "No users loaded.",
}: AccountListProps) {
  if (users.length === 0) {
    return <p className={styles.empty}>{emptyText}</p>;
  }
  return (
    <ul className={styles.list} aria-label="User accounts">
      {users.map((user) => (
        <li key={user.username} className={styles.accountRow}>
          <div className={styles.accountMeta}>
            <span className={styles.accountName}>{user.username}</span>
            <span className={styles.accountRole}>{user.role}</span>
            <span
              className={
                user.active ? styles.accountActive : styles.accountDisabled
              }
            >
              {user.active ? "Active" : "Disabled"}
            </span>
          </div>
          <button
            type="button"
            className={styles.button}
            disabled={busy || user.username === LOCKED_USERNAME}
            onClick={() => onToggle(user)}
            aria-label={`${user.active ? "Disable" : "Enable"} ${user.username}`}
            data-testid={`${testIdPrefix}-${user.username}`}
          >
            {user.active ? "Disable" : "Enable"}
          </button>
        </li>
      ))}
    </ul>
  );
}
