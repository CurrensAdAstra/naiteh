import { useCallback, useEffect, useState } from "react";

import { tagsList, tagsNotes } from "../../lib/api/tags";
import { openByRelPath } from "../../lib/openByRelPath";
import { formatAppError } from "../../lib/types";
import type { NoteMeta, TagCount } from "../../lib/types";
import { useEditorStore } from "../../state/editorStore";
import styles from "./TagsListPanel.module.css";

export function TagsListPanel() {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const openRelPath = useEditorStore((s) => s.open?.source.relPath ?? null);

  const refreshTags = useCallback(async () => {
    try {
      const list = await tagsList();
      setTags(list);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  useEffect(() => {
    void refreshTags();
  }, [refreshTags]);

  useEffect(() => {
    if (selectedTag === null) {
      setNotes([]);
      return;
    }
    let mounted = true;
    tagsNotes(selectedTag)
      .then((list) => {
        if (mounted) setNotes(list);
      })
      .catch((e: unknown) => {
        if (mounted) setError(formatAppError(e));
      });
    return () => {
      mounted = false;
    };
  }, [selectedTag]);

  const handleOpen = useCallback(async (note: NoteMeta) => {
    try {
      await openByRelPath(note.relPath);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  return (
    <div className={styles.panel} data-testid="list-panel-tags">
      <header className={styles.header}>
        <h2 className={styles.title}>Tags</h2>
      </header>
      <div className={styles.body}>
        {error !== null && <p className={styles.error}>{error}</p>}
        {error === null && tags.length === 0 && (
          <p className={styles.empty}>
            No tags yet. Add <code>tags: [foo]</code> in a note's front matter.
          </p>
        )}
        {tags.length > 0 && (
          <>
            <ul className={styles.tagsList} data-testid="tags-list">
              {tags.map((t) => {
                const isSelected = t.tag === selectedTag;
                return (
                  <li key={t.tag}>
                    <button
                      type="button"
                      className={`${styles.tagRow} ${isSelected ? styles.tagRowActive : ""}`}
                      onClick={() => setSelectedTag(t.tag)}
                      data-testid={`tag-${t.tag}`}
                      aria-pressed={isSelected}
                    >
                      <span className={styles.tagName}>{t.tag}</span>
                      <span className={styles.tagCount}>{t.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div
              className={styles.sectionHeader}
              data-testid="tags-notes-header"
            >
              {selectedTag === null
                ? "Select a tag to see its notes"
                : `Notes tagged "${selectedTag}"`}
            </div>
            {selectedTag !== null && (
              <ul className={styles.notesList} data-testid="tags-notes-list">
                {notes.length === 0 ? (
                  <li className={styles.empty}>No notes for this tag.</li>
                ) : (
                  notes.map((note) => {
                    const isActive = note.relPath === openRelPath;
                    return (
                      <li key={note.path}>
                        <button
                          type="button"
                          className={`${styles.noteRow} ${isActive ? styles.noteRowActive : ""}`}
                          onClick={() => void handleOpen(note)}
                          data-testid={`tag-note-${note.relPath}`}
                        >
                          <span className={styles.noteTitle}>{note.title}</span>
                          <span className={styles.noteRelPath}>
                            {note.relPath}
                          </span>
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
