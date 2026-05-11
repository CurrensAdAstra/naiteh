import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { tagsList, tagsNotes } from "../../lib/api/tags";
import { openByRelPath } from "../../lib/openByRelPath";
import { formatAppError } from "../../lib/types";
import type { NoteMeta, TagCount } from "../../lib/types";
import { useEditorStore } from "../../state/editorStore";
import styles from "./TagsListPanel.module.css";

type Mode = "all" | "any";

function combine(
  perTag: ReadonlyMap<string, NoteMeta[]>,
  mode: Mode,
): NoteMeta[] {
  if (perTag.size === 0) return [];

  // Index notes by relPath so we can dedupe + intersect by identity.
  const byPath = new Map<string, NoteMeta>();
  for (const list of perTag.values()) {
    for (const note of list) {
      if (!byPath.has(note.relPath)) byPath.set(note.relPath, note);
    }
  }

  let relPaths: string[];
  if (mode === "any") {
    relPaths = [...byPath.keys()];
  } else {
    const lists = [...perTag.values()].map(
      (list) => new Set(list.map((n) => n.relPath)),
    );
    relPaths = [...byPath.keys()].filter((p) => lists.every((set) => set.has(p)));
  }

  return relPaths
    .map((p) => byPath.get(p))
    .filter((n): n is NoteMeta => n !== undefined)
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export function TagsListPanel() {
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>("any");
  const [perTagNotes, setPerTagNotes] = useState<Map<string, NoteMeta[]>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const openRelPath = useEditorStore((s) => s.open?.source.relPath ?? null);
  // Tracks which tags we've already fetched (or are mid-fetch for). Lives
  // outside React state so we can update it synchronously in the effect
  // body without scheduling a re-render or chasing setState scheduling.
  const fetchedTagsRef = useRef<Set<string>>(new Set());

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

  // Fetch notes for any newly-selected tag; trim caches of de-selected
  // tags. We avoid depending on `perTagNotes` because every prune/insert
  // mints a fresh Map and would loop. Instead, fetch-tracking lives in a
  // ref we mutate synchronously — that way the toFetch list is known
  // immediately, independent of React's setState scheduling.
  useEffect(() => {
    // Drop cache entries (and fetch marks) for tags that left the selection.
    setPerTagNotes((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const k of prev.keys()) {
        if (!selectedTags.has(k)) {
          next.delete(k);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
    for (const t of [...fetchedTagsRef.current]) {
      if (!selectedTags.has(t)) fetchedTagsRef.current.delete(t);
    }

    const toFetch = [...selectedTags].filter(
      (t) => !fetchedTagsRef.current.has(t),
    );
    if (toFetch.length === 0) return;
    for (const t of toFetch) fetchedTagsRef.current.add(t);

    let cancelled = false;
    void Promise.all(
      toFetch.map((tag) =>
        tagsNotes(tag).then((notes) => [tag, notes] as const),
      ),
    )
      .then((entries) => {
        if (cancelled) return;
        setPerTagNotes((prev) => {
          const next = new Map(prev);
          for (const [tag, notes] of entries) next.set(tag, notes);
          return next;
        });
      })
      .catch((e: unknown) => {
        // Allow a retry on the next selection toggle.
        for (const t of toFetch) fetchedTagsRef.current.delete(t);
        if (!cancelled) setError(formatAppError(e));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedTags]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function clearSelection() {
    setSelectedTags(new Set());
  }

  const handleOpen = useCallback(async (note: NoteMeta) => {
    try {
      await openByRelPath(note.relPath);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  const notes = useMemo(() => combine(perTagNotes, mode), [perTagNotes, mode]);

  const selectionLabel = useMemo(() => {
    if (selectedTags.size === 0) return "Select tags to see matching notes";
    const joined = [...selectedTags].join(", ");
    if (selectedTags.size === 1) return `Notes tagged "${joined}"`;
    return mode === "all"
      ? `Notes with all of: ${joined}`
      : `Notes with any of: ${joined}`;
  }, [selectedTags, mode]);

  return (
    <div className={styles.panel} data-testid="list-panel-tags">
      <header className={styles.header}>
        <h2 className={styles.title}>Tags</h2>
      </header>
      <div className={styles.body}>
        {error !== null && <p className={styles.error}>{error}</p>}
        {error === null && tags.length === 0 && (
          <p className={styles.empty}>
            No tags yet. Add <code>tags: [foo]</code> in a note&rsquo;s front matter.
          </p>
        )}
        {tags.length > 0 && (
          <>
            <ul className={styles.tagsList} data-testid="tags-list">
              {tags.map((t) => {
                const isSelected = selectedTags.has(t.tag);
                return (
                  <li key={t.tag}>
                    <button
                      type="button"
                      className={`${styles.tagRow} ${isSelected ? styles.tagRowActive : ""}`}
                      onClick={() => toggleTag(t.tag)}
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
              <span>{selectionLabel}</span>
              {selectedTags.size > 1 && (
                <span
                  className={styles.modeToggle}
                  role="group"
                  aria-label="Combine mode"
                  data-testid="tags-mode-toggle"
                >
                  <button
                    type="button"
                    className={`${styles.modeOption} ${mode === "any" ? styles.modeOptionActive : ""}`}
                    aria-pressed={mode === "any"}
                    onClick={() => setMode("any")}
                    data-testid="tags-mode-any"
                  >
                    Any
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeOption} ${mode === "all" ? styles.modeOptionActive : ""}`}
                    aria-pressed={mode === "all"}
                    onClick={() => setMode("all")}
                    data-testid="tags-mode-all"
                  >
                    All
                  </button>
                </span>
              )}
              {selectedTags.size > 0 && (
                <button
                  type="button"
                  className={styles.clearButton}
                  onClick={clearSelection}
                  data-testid="tags-clear-selection"
                >
                  Clear
                </button>
              )}
            </div>
            {selectedTags.size > 0 && (
              <ul className={styles.notesList} data-testid="tags-notes-list">
                {notes.length === 0 ? (
                  <li className={styles.empty}>
                    {mode === "all"
                      ? "No notes match all selected tags."
                      : "No notes match the selected tags."}
                  </li>
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
