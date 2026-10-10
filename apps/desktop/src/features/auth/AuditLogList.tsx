import type { AuditLogEntry } from "../../lib/types";
import styles from "./AuthForms.module.css";

function formatAuditTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export interface AuditLogListProps {
  entries: readonly AuditLogEntry[];
}

export function AuditLogList({ entries }: AuditLogListProps) {
  if (entries.length === 0) {
    return <p className={styles.empty}>No log entries yet.</p>;
  }
  return (
    <ul className={`${styles.list} ${styles.auditList}`} aria-label="Audit log">
      {entries.map((entry, index) => (
        <li
          key={`${entry.timestamp}-${entry.action}-${index}`}
          className={styles.auditRow}
        >
          <time className={styles.auditTime} dateTime={entry.timestamp}>
            {formatAuditTimestamp(entry.timestamp)}
          </time>
          <span className={styles.auditAction}>{entry.action}</span>
          <span className={styles.auditUser}>{entry.username}</span>
          {entry.detail !== null && (
            <span className={styles.auditDetail}>{entry.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
