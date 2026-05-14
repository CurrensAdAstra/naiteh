import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";

import { activityRecent, quickCreate, quickList } from "../../lib/api/journal";
import { openByRelPath } from "../../lib/openByRelPath";
import { formatAppError } from "../../lib/types";
import type { NoteMeta, TimelineItem } from "../../lib/types";
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import {
  JOURNAL_SPLIT_MAX,
  JOURNAL_SPLIT_MIN,
  useUIStore,
} from "../../state/uiStore";
import { formatRelative } from "./formatRelative";
import styles from "./JournalListPanel.module.css";

interface DragStart {
  startY: number;
  startRatio: number;
  containerHeight: number;
}

const LIST_LIMIT = 50;

function timelineItemRelPath(item: TimelineItem): string {
  if (item.kind === "JournalEntry") {
    const date = item.date;
    return `journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
  }
  return item.relPath;
}

export function JournalListPanel() {
  const ratio = useUIStore((s) => s.journalSplitRatio);
  const setRatio = useUIStore((s) => s.setJournalSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragStart | null>(null);
  const [dragging, setDragging] = useState(false);

  const [quickNotes, setQuickNotes] = useState<NoteMeta[]>([]);
  const [activity, setActivity] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const openRelPath = useEditorStore((s) => s.open?.source.relPath ?? null);
  const logAction = useAuthStore((s) => s.logAction);

  const refresh = useCallback(async () => {
    try {
      const [q, a] = await Promise.all([
        quickList(LIST_LIMIT),
        activityRecent(LIST_LIMIT),
      ]);
      setQuickNotes(q);
      setActivity(a);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpenRelPath = useCallback(async (relPath: string) => {
    try {
      await openByRelPath(relPath);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  async function handleNewQuickNote() {
    setCreating(true);
    try {
      const meta = await quickCreate();
      void logAction("quick_note_create", meta.relPath).catch(() => {});
      await refresh();
      await handleOpenRelPath(meta.relPath);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setCreating(false);
    }
  }

  const topStyle: CSSProperties = { flexBasis: `${ratio * 100}%` };
  const bottomStyle: CSSProperties = { flexBasis: `${(1 - ratio) * 100}%` };

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (container === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startRatio: ratio,
      containerHeight: container.getBoundingClientRect().height,
    };
    setDragging(true);
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (start === null || start.containerHeight === 0) return;
    const dy = e.clientY - start.startY;
    setRatio(start.startRatio + dy / start.containerHeight);
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
  }

  return (
    <div
      ref={containerRef}
      className={styles.panel}
      data-testid="list-panel-journal"
    >
      <section className={styles.section} style={topStyle}>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Quick Capture</h2>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => void handleNewQuickNote()}
            disabled={creating}
          >
            + New quick note
          </button>
        </header>
        <div className={styles.body} data-testid="journal-quick-capture">
          {error !== null && <p className={styles.error}>{error}</p>}
          {error === null && quickNotes.length === 0 && (
            <p className={styles.empty}>No quick notes yet.</p>
          )}
          {quickNotes.length > 0 && (
            <ul className={styles.list}>
              {quickNotes.map((note) => {
                const isActive = note.relPath === openRelPath;
                return (
                  <li key={note.path}>
                    <button
                      type="button"
                      className={`${styles.item} ${isActive ? styles.itemActive : ""}`}
                      onClick={() => void handleOpenRelPath(note.relPath)}
                      data-testid={`quick-note-${note.relPath}`}
                    >
                      <span className={styles.itemHeader}>
                        <span className={styles.itemTitle}>{note.title}</span>
                        <span className={styles.itemMtime}>
                          {formatRelative(note.mtime)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      <div
        role="separator"
        aria-label="Journal split divider"
        aria-orientation="horizontal"
        aria-valuemin={JOURNAL_SPLIT_MIN * 100}
        aria-valuemax={JOURNAL_SPLIT_MAX * 100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        data-testid="journal-split-divider"
        className={`${styles.divider} ${dragging ? styles.dragging : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <section className={styles.section} style={bottomStyle}>
        <header className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Recent Activity</h2>
        </header>
        <div className={styles.body} data-testid="journal-recent-activity">
          {activity.length === 0 && error === null && (
            <p className={styles.empty}>No activity yet.</p>
          )}
          {activity.length > 0 && (
            <ul className={styles.list}>
              {activity.map((item) => {
                const relPath = timelineItemRelPath(item);
                const isActive = relPath === openRelPath;
                return (
                  <li key={timelineKey(item)}>
                    <button
                      type="button"
                      className={`${styles.item} ${isActive ? styles.itemActive : ""}`}
                      onClick={() => void handleOpenRelPath(relPath)}
                      data-testid={`activity-${timelineKey(item)}`}
                    >
                      <span className={styles.itemHeader}>
                        <span
                          className={styles.kindBadge}
                          title={item.kind === "JournalEntry" ? "Journal" : "Note"}
                        >
                          {item.kind === "JournalEntry" ? "J" : "N"}
                        </span>
                        <span className={styles.itemTitle}>{item.title}</span>
                        {item.kind === "Note" && item.pinned && (
                          <span
                            className={styles.pinned}
                            aria-label="pinned"
                            title="pinned"
                          >
                            ★
                          </span>
                        )}
                        <span className={styles.itemMtime}>
                          {formatRelative(item.mtime)}
                        </span>
                      </span>
                      {item.snippet !== "" && (
                        <span className={styles.itemSnippet}>
                          {item.snippet}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function timelineKey(item: TimelineItem): string {
  return item.kind === "JournalEntry"
    ? `journal:${item.date}`
    : `note:${item.relPath}`;
}
