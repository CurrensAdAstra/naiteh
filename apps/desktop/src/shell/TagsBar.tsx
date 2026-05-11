import { X } from "lucide-react";
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";

import {
  addTagToContent,
  getTagsFromContent,
  removeTagFromContent,
} from "../lib/frontMatter";
import {
  replaceWholeDocument,
  useEditorStore,
} from "../state/editorStore";
import { useUIStore } from "../state/uiStore";
import styles from "./TagsBar.module.css";

/**
 * Editor sub-toolbar that shows the currently open note's tags as chips
 * with × buttons + an inline input for adding new ones. All edits are
 * applied client-side to the editor content (autosave persists them).
 */
export function TagsBar() {
  const content = useEditorStore((s) => s.open?.content ?? null);
  const readOnly = useUIStore((s) => s.editorReadOnly);
  const [draft, setDraft] = useState("");

  const tags = useMemo(
    () => (content === null ? [] : getTagsFromContent(content)),
    [content],
  );

  const applyContent = useCallback((next: string) => {
    // Mirror state if there's no live CM view (defensive — same as pin toggle).
    if (!replaceWholeDocument(next)) {
      useEditorStore.setState((state) =>
        state.open === null ? state : { open: { ...state.open, content: next } },
      );
    }
  }, []);

  if (content === null) return null;

  function handleAdd() {
    if (readOnly) return;
    const value = draft.trim();
    if (value === "") return;
    const current = useEditorStore.getState().open?.content;
    if (current === undefined) return;
    applyContent(addTagToContent(current, value));
    setDraft("");
  }

  function handleRemove(tag: string) {
    if (readOnly) return;
    const current = useEditorStore.getState().open?.content;
    if (current === undefined) return;
    applyContent(removeTagFromContent(current, tag));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAdd();
      return;
    }
    if (e.key === "," && draft.trim() !== "") {
      // Comma is a natural separator — treat it like Enter for chips.
      e.preventDefault();
      handleAdd();
      return;
    }
    if (e.key === "Backspace" && draft === "" && tags.length > 0) {
      const last = tags[tags.length - 1];
      if (last !== undefined) handleRemove(last);
    }
  }

  return (
    <div className={styles.bar} data-testid="tags-bar">
      <span className={styles.label}>Tags</span>
      {tags.length === 0 && (
        <span className={styles.empty} data-testid="tags-bar-empty">
          none
        </span>
      )}
      {tags.map((tag) => (
        <span key={tag} className={styles.chip} data-testid={`tag-chip-${tag}`}>
          <span className={styles.chipName}>{tag}</span>
          <button
            type="button"
            className={styles.chipRemove}
            aria-label={`Remove tag ${tag}`}
            title="Remove tag"
            disabled={readOnly}
            onClick={() => handleRemove(tag)}
            data-testid={`tag-remove-${tag}`}
          >
            <X size={10} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        type="text"
        className={styles.input}
        placeholder={readOnly ? "" : "+ add tag"}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={handleAdd}
        disabled={readOnly}
        aria-label="Add tag"
        data-testid="tags-bar-input"
      />
    </div>
  );
}
