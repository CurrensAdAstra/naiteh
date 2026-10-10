import { ChangePasswordForm } from "../../auth/ChangePasswordForm";
import { useAuthStore } from "../../../state/authStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

/** The signed-in user's own account (any role). */
export function AccountSection() {
  const session = useAuthStore((s) => s.session);
  const changePassword = useAuthStore((s) => s.changePassword);

  return (
    <div data-testid="settings-account">
      <h2 className={styles.sectionHeading}>Account</h2>
      <p className={styles.sectionIntro}>
        Signed in as <strong>{session?.username ?? "—"}</strong>
        {session !== null && ` (${session.role})`}.
      </p>
      <SettingItem
        name="Change password"
        description="You stay signed in on this device after changing it."
        stacked
      >
        <ChangePasswordForm
          username={session?.username ?? ""}
          onSubmit={changePassword}
          successMessage="Password changed."
          idPrefix="settings-change-password"
        />
      </SettingItem>
    </div>
  );
}
