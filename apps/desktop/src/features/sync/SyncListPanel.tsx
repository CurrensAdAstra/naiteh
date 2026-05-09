import styles from "./SyncListPanel.module.css";

export function SyncListPanel() {
  return (
    <div className={styles.panel} data-testid="list-panel-sync">
      <header className={styles.header}>
        <h2 className={styles.title}>Sync</h2>
      </header>
      <div className={styles.body}>
        TODO: last sync time, pending changes, “Sync now” button
      </div>
    </div>
  );
}
