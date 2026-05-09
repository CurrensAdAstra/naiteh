import styles from "./SettingsListPanel.module.css";

export function SettingsListPanel() {
  return (
    <div className={styles.panel} data-testid="list-panel-settings">
      <header className={styles.header}>
        <h2 className={styles.title}>Settings</h2>
      </header>
      <div className={styles.body}>TODO: app + vault setting categories</div>
    </div>
  );
}
