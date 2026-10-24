import { useId, useRef, useState, type FormEvent } from "react";

import { formatAppError } from "../../lib/types";
import { useDialogFocus } from "../settings/useDialogFocus";
import styles from "./CreateItemDialog.module.css";

export interface CreateItemTarget {
  kind: "note" | "folder";
  parentPath: string;
}

interface CreateItemDialogProps {
  target: CreateItemTarget;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}

export function CreateItemDialog({
  target,
  onCreate,
  onClose,
}: CreateItemDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isNote = target.kind === "note";

  function close() {
    if (!submitting.current) onClose();
  }

  useDialogFocus(dialogRef, close);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(isNote ? "Enter a title for the note." : "Enter a folder name.");
      return;
    }
    if (!isNote && /[\\/]/.test(trimmed)) {
      setError("Folder names cannot contain / or \\.");
      return;
    }
    if (!isNote && (trimmed === "." || trimmed === "..")) {
      setError('Choose a folder name other than "." or "..".');
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <form
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-location`}
        aria-busy={busy}
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <h2 id={`${id}-title`} className={styles.title}>
          {isNote ? "New note" : "New folder"}
        </h2>
        <p id={`${id}-location`} className={styles.location}>
          In <strong>{target.parentPath}/</strong>
        </p>
        <label className={styles.field}>
          <span>{isNote ? "Note title" : "Folder name"}</span>
          <input
            className={styles.input}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder={isNote ? "Untitled note" : "Folder name"}
            autoComplete="off"
            disabled={busy}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : `${id}-error`}
          />
        </label>
        {error !== null && (
          <p id={`${id}-error`} className={styles.error} role="alert">
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={close}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`${styles.button} ${styles.primary}`}
            disabled={busy || name.trim() === ""}
          >
            {busy ? "Creating…" : isNote ? "Create note" : "Create folder"}
          </button>
        </div>
      </form>
    </div>
  );
}
