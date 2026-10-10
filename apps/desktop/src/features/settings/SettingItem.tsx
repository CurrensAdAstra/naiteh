import { useId, type ReactNode } from "react";

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
  /**
   * `id` of the single control this row describes. The name becomes its
   * `<label htmlFor>`, and the description gets the id
   * `${controlId}-description` for the control's `aria-describedby`.
   * Without it, multi-control rows are exposed as a labelled group.
   */
  controlId?: string;
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
  controlId,
}: SettingItemProps) {
  const autoId = useId();
  const nameId = `${controlId ?? autoId}-name`;
  const descriptionId = `${controlId ?? autoId}-description`;
  return (
    <div
      className={`${styles.item} ${stacked ? styles.itemStacked : ""}`}
      data-testid={testId}
    >
      <div className={styles.itemInfo}>
        {controlId !== undefined ? (
          <label className={styles.itemName} htmlFor={controlId} id={nameId}>
            {name}
          </label>
        ) : (
          <div className={styles.itemName} id={nameId}>
            {name}
          </div>
        )}
        {description !== undefined && (
          <div className={styles.itemDescription} id={descriptionId}>
            {description}
          </div>
        )}
      </div>
      {children !== undefined &&
        (controlId !== undefined ? (
          <div className={styles.itemControl}>{children}</div>
        ) : (
          <div
            className={styles.itemControl}
            role="group"
            aria-labelledby={nameId}
            aria-describedby={description !== undefined ? descriptionId : undefined}
          >
            {children}
          </div>
        ))}
    </div>
  );
}
