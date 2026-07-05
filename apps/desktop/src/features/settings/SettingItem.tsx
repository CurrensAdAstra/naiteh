import type { ReactNode } from "react";

import styles from "./SettingsModal.module.css";

export interface SettingItemProps {
  /** Bold left-column label. */
  name: ReactNode;
  /** Muted sub-label under the name. */
  description?: ReactNode;
  /** The control(s) rendered flush-right. */
  children?: ReactNode;
  /** Optional stacked layout for wide controls (lists, tables). */
  stacked?: boolean;
  testId?: string;
}

/**
 * One Obsidian-style settings row: name + optional description on the
 * left, control(s) on the right, divided from the next row by a hairline.
 * `stacked` drops the control to its own full-width line below the label
 * — for wide content (vault list, audit log) that can't sit in a column.
 */
export function SettingItem({
  name,
  description,
  children,
  stacked = false,
  testId,
}: SettingItemProps) {
  return (
    <div
      className={`${styles.item} ${stacked ? styles.itemStacked : ""}`}
      data-testid={testId}
    >
      <div className={styles.itemInfo}>
        <div className={styles.itemName}>{name}</div>
        {description !== undefined && (
          <div className={styles.itemDescription}>{description}</div>
        )}
      </div>
      {children !== undefined && (
        <div className={styles.itemControl}>{children}</div>
      )}
    </div>
  );
}
