import { AuditLogList } from "../../auth/AuditLogList";
import type { AdminData } from "../../auth/useAdminData";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

export interface AuditSectionProps {
  admin: AdminData;
}

/** Admin: recent audit-log entries. */
export function AuditSection({ admin }: AuditSectionProps) {
  return (
    <div data-testid="settings-audit">
      <h2 className={styles.sectionHeading}>Audit Log</h2>
      {admin.error !== null && (
        <p className={styles.error} role="alert">
          {admin.error}
        </p>
      )}
      <SettingItem name="Recent activity" stacked>
        <AuditLogList entries={admin.logs} />
      </SettingItem>
    </div>
  );
}
