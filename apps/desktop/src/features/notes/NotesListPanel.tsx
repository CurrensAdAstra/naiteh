import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  notesCreate,
  notesDelete,
  notesList,
  notesRead,
  notesRename,
} from "../../lib/api/notes";
import { formatAppError } from "../../lib/types";
import type { NoteMeta } from "../../lib/types";
import { useEditorStore } from "../../state/editorStore";
import { buildTree, type FolderNode } from "./buildTree";
import styles from "./NotesListPanel.module.css";

const INDENT_PX = 12;

interface ContextActions {
  rename: (note: NoteMeta) => void;
  remove: (note: NoteMeta) => void;
}

export function NotesListPanel() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const openNote = useEditorStore((s) => s.openNote);
  const closeNote = useEditorStore((s) => s.closeNote);
  const openRelPath = useEditorStore((s) =>
    s.open !== null && s.open.source.kind === "note"
      ? s.open.source.relPath
      : null,
  );

  const refresh = useCallback(async () => {
    try {
      const list = await notesList(null);
      setNotes(list);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = useCallback(
    async (note: NoteMeta) => {
      try {
        const content = await notesRead(note.relPath);
        openNote(note.relPath, content);
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [openNote],
  );

  async function handleNewNote() {
    const title = window.prompt("New note title:");
    if (title === null) return;
    setCreating(true);
    try {
      const meta = await notesCreate("notes", title);
      await refresh();
      await handleOpen(meta);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setCreating(false);
    }
  }

  const handleRename = useCallback(
    async (note: NoteMeta) => {
      const currentName = note.relPath.split("/").pop() ?? "note.md";
      const next = window.prompt("Rename note (filename):", currentName);
      if (next === null) return;
      const trimmed = next.trim();
      if (trimmed === "" || trimmed === currentName) return;
      const ensured = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
      // Stay in the same folder.
      const segments = note.relPath.split("/");
      segments[segments.length - 1] = ensured;
      const targetRelPath = segments.join("/");
      try {
        const updated = await notesRename(note.relPath, targetRelPath);
        await refresh();
        if (openRelPath === note.relPath) {
          // The currently open note moved — re-open it from the new path.
          const content = await notesRead(updated.relPath);
          openNote(updated.relPath, content);
        }
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [openNote, openRelPath, refresh],
  );

  const handleDelete = useCallback(
    async (note: NoteMeta) => {
      const ok = window.confirm(
        `Delete "${note.title}"?\n\nFile: ${note.relPath}\nThis cannot be undone from naiteh.`,
      );
      if (!ok) return;
      try {
        await notesDelete(note.relPath);
        if (openRelPath === note.relPath) closeNote();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [closeNote, openRelPath, refresh],
  );

  const tree = buildTree(notes);
  const isEmpty = tree.children.length === 0 && tree.files.length === 0;

  return (
    <div className={styles.panel} data-testid="list-panel-notes">
      <header className={styles.header}>
        <h2 className={styles.title}>Notes</h2>
        <button
          type="button"
          className={styles.newButton}
          onClick={() => void handleNewNote()}
          disabled={creating}
        >
          + New note
        </button>
      </header>
      <div className={styles.body}>
        {error !== null && <p className={styles.error}>{error}</p>}
        {error === null && isEmpty && (
          <p className={styles.empty}>
            No notes yet. Click “+ New note” to create one.
          </p>
        )}
        {!isEmpty && (
          <FolderRows
            node={tree}
            depth={0}
            renderRoot={false}
            activePath={openRelPath}
            onOpen={(n) => void handleOpen(n)}
            actions={{
              rename: (n) => void handleRename(n),
              remove: (n) => void handleDelete(n),
            }}
          />
        )}
      </div>
    </div>
  );
}

interface FolderRowsProps {
  node: FolderNode;
  depth: number;
  renderRoot: boolean;
  activePath: string | null;
  onOpen: (note: NoteMeta) => void;
  actions: ContextActions;
}

function FolderRows({
  node,
  depth,
  renderRoot,
  activePath,
  onOpen,
  actions,
}: FolderRowsProps) {
  const [expanded, setExpanded] = useState(true);

  const childContent = (
    <>
      {node.children.map((child) => (
        <FolderRows
          key={child.path}
          node={child}
          depth={depth + 1}
          renderRoot
          activePath={activePath}
          onOpen={onOpen}
          actions={actions}
        />
      ))}
      {node.files.map((file) => {
        const isActive = file.relPath === activePath;
        return (
          <div key={file.path} className={styles.fileRowWrap}>
            <button
              type="button"
              className={`${styles.row} ${styles.fileRow} ${
                isActive ? styles.rowActive : ""
              }`}
              style={{ paddingLeft: (depth + 1) * INDENT_PX }}
              onClick={() => onOpen(file)}
              data-testid={`notes-file-${file.relPath}`}
            >
              <span className={styles.caret} aria-hidden="true" />
              <FileText size={14} className={styles.icon} aria-hidden="true" />
              <span className={styles.label}>{file.title}</span>
              {file.pinned && (
                <span
                  className={styles.pinned}
                  aria-label="pinned"
                  title="pinned"
                >
                  ★
                </span>
              )}
            </button>
            <div className={styles.fileActions}>
              <button
                type="button"
                className={styles.iconButton}
                aria-label={`Rename ${file.title}`}
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.rename(file);
                }}
                data-testid={`notes-rename-${file.relPath}`}
              >
                <Pencil size={12} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={`${styles.iconButton} ${styles.iconButtonDanger}`}
                aria-label={`Delete ${file.title}`}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.remove(file);
                }}
                data-testid={`notes-delete-${file.relPath}`}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
    </>
  );

  if (!renderRoot) {
    return childContent;
  }

  return (
    <>
      <button
        type="button"
        className={styles.row}
        style={{ paddingLeft: depth * INDENT_PX }}
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className={styles.caret} aria-hidden="true">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <Folder size={14} className={styles.icon} aria-hidden="true" />
        <span className={styles.label}>{node.name}</span>
      </button>
      {expanded && childContent}
    </>
  );
}
