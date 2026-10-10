import { LogOut } from "lucide-react";

import { useAuthStore } from "../../state/authStore";
import { AccountList } from "./AccountList";
import { AuditLogList } from "./AuditLogList";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { CreateUserForm } from "./CreateUserForm";
import { useAdminData } from "./useAdminData";
import styles from "./AdminDashboard.module.css";

export function AdminDashboard() {
  const session = useAuthStore((s) => s.session);
  const token = useAuthStore((s) => s.token);
  const clearSession = useAuthStore((s) => s.clearSession);
  const logAction = useAuthStore((s) => s.logAction);
  const changePassword = useAuthStore((s) => s.changePassword);
  const admin = useAdminData(session !== null ? token : null);

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

      {admin.error !== null && (
        <p className={styles.error} role="alert">
          {admin.error}
        </p>
      )}

      <section className={styles.section} aria-labelledby="admin-accounts">
        <h2 className={styles.sectionTitle} id="admin-accounts">
          Accounts
        </h2>
        <AccountList
          users={admin.users}
          busy={admin.busy}
          onToggle={(user) => void admin.toggleUser(user)}
          testIdPrefix="admin-account-toggle"
        />
      </section>

      <section className={styles.section} aria-labelledby="admin-create-user">
        <h2 className={styles.sectionTitle} id="admin-create-user">
          Create user
        </h2>
        <CreateUserForm onCreate={admin.createUser} idPrefix="admin-create-user" />
      </section>

      <section className={styles.section} aria-labelledby="admin-password">
        <h2 className={styles.sectionTitle} id="admin-password">
          Your password
        </h2>
        <ChangePasswordForm
          username={session?.username ?? ""}
          onSubmit={changePassword}
          successMessage="Password changed."
          idPrefix="admin-change-password"
        />
      </section>

      <section className={styles.section} aria-labelledby="admin-audit">
        <h2 className={styles.sectionTitle} id="admin-audit">
          Audit Log
        </h2>
        <AuditLogList entries={admin.logs} />
      </section>
    </main>
  );
}
