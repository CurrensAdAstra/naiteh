import { AccountList } from "../../auth/AccountList";
import { CreateUserForm } from "../../auth/CreateUserForm";
import type { AdminData } from "../../auth/useAdminData";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

export interface AccountsSectionProps {
  admin: AdminData;
}

/** Admin: manage user accounts. */
export function AccountsSection({ admin }: AccountsSectionProps) {
  return (
    <div data-testid="settings-accounts">
      <h2 className={styles.sectionHeading}>Accounts</h2>
      {admin.error !== null && (
        <p className={styles.error} role="alert">
          {admin.error}
        </p>
      )}
      <SettingItem name="Users" stacked>
        <AccountList
          users={admin.users}
          busy={admin.busy}
          onToggle={(user) => void admin.toggleUser(user)}
          testIdPrefix="account-toggle"
        />
      </SettingItem>
      <SettingItem
        name="Create user"
        description="New accounts can sign in immediately with the password you set."
        stacked
      >
        <CreateUserForm onCreate={admin.createUser} idPrefix="settings-create-user" />
      </SettingItem>
    </div>
  );
}
