import styles from "./SearchListPanel.module.css";

export function SearchListPanel() {
  return (
    <div className={styles.panel} data-testid="list-panel-search">
      <header className={styles.header}>
        <h2 className={styles.title}>Search</h2>
      </header>
      <input
        type="search"
        placeholder="Search vault…"
        className={styles.searchInput}
        disabled
        aria-label="Search vault"
      />
      <div className={styles.body}>TODO: full-text search results</div>
    </div>
  );
}
