import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  notesCreate,
  notesCreateDir,
  notesDelete,
  notesDeleteDir,
  notesList,
  notesListDirs,
  notesRead,
  notesRename,
  notesRenameDir,
} from "../../lib/api/notes";
import { formatAppError } from "../../lib/types";
import type { NoteMeta } from "../../lib/types";
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { buildTree, type FolderNode } from "./buildTree";
import styles from "./NotesListPanel.module.css";

const INDENT_PX = 12;

interface ContextActions {
  rename: (note: NoteMeta) => void;
  remove: (note: NoteMeta) => void;
}

interface FolderActions {
  newSubfolder: (folder: FolderNode) => void;
  rename: (folder: FolderNode) => void;
  remove: (folder: FolderNode) => void;
}

export function NotesListPanel() {
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const openNote = useEditorStore((s) => s.openNote);
  const closeNote = useEditorStore((s) => s.closeNote);
  const logAction = useAuthStore((s) => s.logAction);
  const openRelPath = useEditorStore((s) =>
    s.open !== null && s.open.source.kind === "note"
      ? s.open.source.relPath
      : null,
  );

  const refresh = useCallback(async () => {
    try {
      const [list, folders] = await Promise.all([
        notesList(null),
        notesListDirs(),
      ]);
      setNotes(list);
      setDirs(folders);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  // True when the editor's open note lives inside `folderPath`.
  const openNoteInside = useCallback(
    (folderPath: string) =>
      openRelPath !== null && openRelPath.startsWith(`${folderPath}/`),
    [openRelPath],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = useCallback(
    async (note: NoteMeta) => {
      try {
        const content = await notesRead(note.relPath);
        openNote(note.relPath, content);
        void logAction("note_open", note.relPath).catch(() => {});
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [logAction, openNote],
  );

  const handleNewNote = useCallback(async () => {
    const title = window.prompt("New note title:");
    if (title === null) return;
    setCreating(true);
    try {
      const meta = await notesCreate("notes", title);
      void logAction("note_create", meta.relPath).catch(() => {});
      await refresh();
      await handleOpen(meta);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setCreating(false);
    }
  }, [handleOpen, logAction, refresh]);

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
        void logAction(
          "note_rename",
          `${note.relPath} -> ${updated.relPath}`,
        ).catch(() => {});
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
    [logAction, openNote, openRelPath, refresh],
  );

  const handleDelete = useCallback(
    async (note: NoteMeta) => {
      const ok = window.confirm(
        `Delete "${note.title}"?\n\nFile: ${note.relPath}\nThis cannot be undone from naiteh.`,
      );
      if (!ok) return;
      try {
        await notesDelete(note.relPath);
        void logAction("note_delete", note.relPath).catch(() => {});
        if (openRelPath === note.relPath) closeNote();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [closeNote, logAction, openRelPath, refresh],
  );

  function folderNameFrom(prompt: string): string | null {
    const next = window.prompt(prompt);
    if (next === null) return null;
    const trimmed = next.trim();
    if (trimmed === "" || trimmed.includes("/")) return null;
    return trimmed;
  }

  const handleNewFolder = useCallback(
    async (parentPath: string) => {
      const name = folderNameFrom("New folder name:");
      if (name === null) return;
      try {
        await notesCreateDir(`${parentPath}/${name}`);
        void logAction("notes_create_dir", `${parentPath}/${name}`).catch(
          () => {},
        );
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [logAction, refresh],
  );

  const handleRenameFolder = useCallback(
    async (folder: FolderNode) => {
      const name = folderNameFrom(`Rename folder "${folder.name}" to:`);
      if (name === null || name === folder.name) return;
      const parent = folder.path.split("/").slice(0, -1).join("/");
      const target = `${parent}/${name}`;
      try {
        await notesRenameDir(folder.path, target);
        void logAction(
          "notes_rename_dir",
          `${folder.path} -> ${target}`,
        ).catch(() => {});
        // The open note's path may have moved with the folder.
        if (openNoteInside(folder.path)) closeNote();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [closeNote, logAction, openNoteInside, refresh],
  );

  const handleDeleteFolder = useCallback(
    async (folder: FolderNode) => {
      const ok = window.confirm(
        `Delete folder "${folder.name}" and everything inside it?\n\n${folder.path}\nThis cannot be undone from naiteh.`,
      );
      if (!ok) return;
      try {
        await notesDeleteDir(folder.path);
        void logAction("notes_delete_dir", folder.path).catch(() => {});
        if (openNoteInside(folder.path)) closeNote();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [closeNote, logAction, openNoteInside, refresh],
  );

  // The native File ▸ New Note / New Folder menu items route here.
  const pendingAction = useUIStore((s) => s.pendingAction);
  const clearPendingAction = useUIStore((s) => s.clearPendingAction);
  useEffect(() => {
    if (pendingAction === "newNote") {
      clearPendingAction();
      void handleNewNote();
    } else if (pendingAction === "newFolder") {
      clearPendingAction();
      void handleNewFolder("notes");
    }
  }, [pendingAction, clearPendingAction, handleNewNote, handleNewFolder]);

  const tree = buildTree(notes, "notes", dirs);
  const isEmpty = tree.children.length === 0 && tree.files.length === 0;
  const folderActions: FolderActions = {
    newSubfolder: (f) => void handleNewFolder(f.path),
    rename: (f) => void handleRenameFolder(f),
    remove: (f) => void handleDeleteFolder(f),
  };

  return (
    <div className={styles.panel} data-testid="list-panel-notes">
      <header className={styles.header}>
        <h2 className={styles.title}>Notes</h2>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => void handleNewFolder("notes")}
            data-testid="notes-new-folder"
          >
            + Folder
          </button>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => void handleNewNote()}
            disabled={creating}
          >
            + New note
          </button>
        </div>
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
            folderActions={folderActions}
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
  folderActions: FolderActions;
}

function FolderRows({
  node,
  depth,
  renderRoot,
  activePath,
  onOpen,
  actions,
  folderActions,
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
          folderActions={folderActions}
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
      <div className={styles.fileRowWrap}>
        <button
          type="button"
          className={`${styles.row} ${styles.folderRow}`}
          style={{ paddingLeft: depth * INDENT_PX }}
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          data-testid={`notes-folder-${node.path}`}
        >
          <span className={styles.caret} aria-hidden="true">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <Folder size={14} className={styles.icon} aria-hidden="true" />
          <span className={styles.label}>{node.name}</span>
        </button>
        <div className={styles.fileActions}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`New folder in ${node.name}`}
            title="New subfolder"
            onClick={(e) => {
              e.stopPropagation();
              folderActions.newSubfolder(node);
            }}
            data-testid={`notes-folder-new-${node.path}`}
          >
            <FolderPlus size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Rename folder ${node.name}`}
            title="Rename folder"
            onClick={(e) => {
              e.stopPropagation();
              folderActions.rename(node);
            }}
            data-testid={`notes-folder-rename-${node.path}`}
          >
            <Pencil size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`${styles.iconButton} ${styles.iconButtonDanger}`}
            aria-label={`Delete folder ${node.name}`}
            title="Delete folder"
            onClick={(e) => {
              e.stopPropagation();
              folderActions.remove(node);
            }}
            data-testid={`notes-folder-delete-${node.path}`}
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded && childContent}
    </>
  );
}
