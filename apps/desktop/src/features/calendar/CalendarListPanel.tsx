import styles from "./CalendarListPanel.module.css";

export function CalendarListPanel() {
  return (
    <div className={styles.panel} data-testid="list-panel-calendar">
      <header className={styles.header}>
        <h2 className={styles.title}>Calendar</h2>
      </header>
      <div className={styles.body}>
        TODO: Agenda-style timeline of dated items
      </div>
    </div>
  );
}
