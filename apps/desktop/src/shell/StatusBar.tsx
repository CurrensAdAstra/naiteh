import { useMemo } from "react";

import { countWords } from "../lib/wordCount";
import { useEditorStore } from "../state/editorStore";
import { useVaultStore } from "../state/vaultStore";
import styles from "./StatusBar.module.css";

export function StatusBar() {
  const active = useVaultStore((s) => s.active);
  const openContent = useEditorStore((s) => s.open?.content ?? null);
  const words = useMemo(
    () => (openContent === null ? null : countWords(openContent)),
    [openContent],
  );
  return (
    <div className={styles.bar} role="contentinfo" data-testid="status-bar">
      <span className={styles.vault}>{active?.name ?? "—"}</span>
      <span className={styles.spacer} />
      <span className={styles.placeholder}>Sync: —</span>
      <span className={styles.placeholder} data-testid="status-words">
        {words === null ? "Words: —" : `Words: ${words.toLocaleString()}`}
      </span>
    </div>
  );
}
