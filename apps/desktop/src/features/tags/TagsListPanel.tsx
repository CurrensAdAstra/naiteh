import styles from "./TagsListPanel.module.css";

export function TagsListPanel() {
  return (
    <div className={styles.panel} data-testid="list-panel-tags">
      <header className={styles.header}>
        <h2 className={styles.title}>Tags</h2>
      </header>
      <div className={styles.body}>TODO: flat tag list with counts</div>
    </div>
  );
}
