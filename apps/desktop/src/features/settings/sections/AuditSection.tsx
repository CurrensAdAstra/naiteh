import { useEffect, useState } from "react";

import { authListAuditLogs } from "../../../lib/api/auth";
import { formatAppError, type AuditLogEntry } from "../../../lib/types";
import { useAuthStore } from "../../../state/authStore";
import { AuditLogList } from "../../auth/AuditLogList";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

export function AuditSection() {
  const token = useAuthStore((s) => s.token);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (token === null) return;
    let cancelled = false;
    setError(null);
    void authListAuditLogs(token).then((entries) => {
      if (!cancelled) setLogs(entries);
    }).catch((err: unknown) => {
      if (!cancelled) setError(formatAppError(err));
    });
    return () => { cancelled = true; };
  }, [token, attempt]);
  return (
    <div data-testid="settings-audit">
      <h2 className={styles.sectionHeading}>Local Activity</h2>
      <p className={styles.sectionIntro}>Recent activity on this device, including historical events from before conversion.</p>
      {error !== null && <p className={styles.error} role="alert">{error}</p>}
      <button type="button" className={styles.button} onClick={() => setAttempt(attempt + 1)}>{error !== null ? "Retry activity" : "Refresh activity"}</button>
      <SettingItem name="Recent activity" stacked><AuditLogList entries={logs} /></SettingItem>
    </div>
  );
}
