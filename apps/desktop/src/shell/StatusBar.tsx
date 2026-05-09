import { useVaultStore } from "../state/vaultStore";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const active = useVaultStore((s) => s.active);
  return (
    <div className={styles.bar} role="contentinfo" data-testid="status-bar">
      <span className={styles.vault}>{active?.name ?? "—"}</span>
      <span className={styles.spacer} />
      <span className={styles.placeholder}>Sync: —</span>
      <span className={styles.placeholder}>Words: 0</span>
    </div>
  );
}
