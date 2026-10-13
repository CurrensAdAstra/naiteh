import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  notesCreate,
  notesCreateDir,
  notesDelete,
  notesDeleteDir,
  notesList,
  notesListDirs,
  notesRename,
  notesRenameDir,
} from "../../lib/api/notes";
import { openDocument, type OpenOptions } from "../../lib/openDocument";
import { formatAppError } from "../../lib/types";
import type { NoteMeta } from "../../lib/types";
import { useAuthStore } from "../../state/authStore";
import {
  discardPendingSave,
  flushPendingSave,
  suspendAutosave,
} from "../../state/autosave";
import {
  keyFor,
  useEditorStore,
  type OpenSource,
} from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import {
  notifyVaultContentChanged,
  useVaultContentStore,
} from "../../state/vaultContentStore";
import {
  buildTree,
  flattenTree,
  type FolderNode,
  type TreeRow,
} from "./buildTree";
import styles from "./NotesListPanel.module.css";

const INDENT_PX = 12;
/** Every tree row has this fixed height, which is what makes windowing cheap. */
export const ROW_HEIGHT_PX = 26;
/** Extra rows rendered above and below the viewport. */
const OVERSCAN_ROWS = 8;
/** Used until the scroll container has been measured (and in jsdom). */
const FALLBACK_VIEWPORT_PX = 600;

/** True when `source` is a note stored somewhere under `folderPath`. */
function noteInside(
  source: OpenSource,
  folderPath: string,
): source is Extract<OpenSource, { kind: "note" }> {
  return source.kind === "note" && source.relPath.startsWith(`${folderPath}/`);
}

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

  // Refetch on mount and whenever vault files change elsewhere (sync,
  // other panels). Our own mutations refresh directly and record the
  // version they announced so they don't trigger a second fetch here.
  const contentVersion = useVaultContentStore((s) => s.version);
  const seenVersionRef = useRef<number | null>(null);
  useEffect(() => {
    if (seenVersionRef.current === contentVersion) return;
    seenVersionRef.current = contentVersion;
    void refresh();
  }, [contentVersion, refresh]);

  const announceChange = useCallback(() => {
    seenVersionRef.current = notifyVaultContentChanged();
  }, []);

  const handleOpen = useCallback(async (note: NoteMeta, opts?: OpenOptions) => {
    try {
      await openDocument({ kind: "note", relPath: note.relPath }, opts);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  const handleNewNote = useCallback(async () => {
    const title = window.prompt("New note title:");
    if (title === null) return;
    setCreating(true);
    try {
      const meta = await notesCreate("notes", title);
      void logAction("note_create", meta.relPath).catch(() => {});
      announceChange();
      await refresh();
      // A brand-new note opens in the editor, ready to type.
      await handleOpen(meta, { edit: true });
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setCreating(false);
    }
  }, [announceChange, handleOpen, logAction, refresh]);

  /**
   * Run a file-moving operation without racing autosave: flush pending
   * edits to the *current* path, then hold timer-driven writes until the
   * operation settles so nothing writes to a path that is going away.
   */
  const withAutosaveHeld = useCallback(
    async <T,>(op: () => Promise<T>): Promise<T> => {
      await flushPendingSave();
      const resume = suspendAutosave();
      try {
        return await op();
      } finally {
        resume();
      }
    },
    [],
  );

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
      const oldKey = keyFor({ kind: "note", relPath: note.relPath });
      try {
        await withAutosaveHeld(async () => {
          const updated = await notesRename(note.relPath, targetRelPath);
          // Anything typed during the rename is still in memory; don't let
          // it be written to the old path. Keep the editor's content and
          // point it at the new path — if it's dirty, autosave writes it
          // there.
          discardPendingSave(oldKey);
          useEditorStore
            .getState()
            .retargetOpen(oldKey, { kind: "note", relPath: updated.relPath });
          void logAction(
            "note_rename",
            `${note.relPath} -> ${updated.relPath}`,
          ).catch(() => {});
        });
        announceChange();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [announceChange, logAction, refresh, withAutosaveHeld],
  );

  const handleDelete = useCallback(
    async (note: NoteMeta) => {
      const ok = window.confirm(
        `Delete "${note.title}"?\n\nFile: ${note.relPath}\nThis cannot be undone from naiteh.`,
      );
      if (!ok) return;
      const key = keyFor({ kind: "note", relPath: note.relPath });
      try {
        await withAutosaveHeld(async () => {
          await notesDelete(note.relPath);
          // The file is gone: drop any held save so it can't resurrect it.
          discardPendingSave(key);
          if (useEditorStore.getState().open?.key === key) {
            useEditorStore.getState().closeNote();
          }
          void logAction("note_delete", note.relPath).catch(() => {});
        });
        announceChange();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [announceChange, logAction, refresh, withAutosaveHeld],
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
        await withAutosaveHeld(async () => {
          await notesRenameDir(folder.path, target);
          // The open note may have moved with the folder: keep its
          // in-memory content and follow it to the new path.
          const open = useEditorStore.getState().open;
          if (open !== null && noteInside(open.source, folder.path)) {
            discardPendingSave(open.key);
            const moved = `${target}${open.source.relPath.slice(folder.path.length)}`;
            useEditorStore
              .getState()
              .retargetOpen(open.key, { kind: "note", relPath: moved });
          }
          void logAction(
            "notes_rename_dir",
            `${folder.path} -> ${target}`,
          ).catch(() => {});
        });
        announceChange();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [announceChange, logAction, refresh, withAutosaveHeld],
  );

  const handleDeleteFolder = useCallback(
    async (folder: FolderNode) => {
      const ok = window.confirm(
        `Delete folder "${folder.name}" and everything inside it?\n\n${folder.path}\nThis cannot be undone from naiteh.`,
      );
      if (!ok) return;
      try {
        await withAutosaveHeld(async () => {
          await notesDeleteDir(folder.path);
          const open = useEditorStore.getState().open;
          if (open !== null && noteInside(open.source, folder.path)) {
            discardPendingSave(open.key);
            useEditorStore.getState().closeNote();
          }
          void logAction("notes_delete_dir", folder.path).catch(() => {});
        });
        announceChange();
        await refresh();
      } catch (e) {
        setError(formatAppError(e));
      }
    },
    [announceChange, logAction, refresh, withAutosaveHeld],
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

  const tree = useMemo(() => buildTree(notes, "notes", dirs), [notes, dirs]);
  const isEmpty = tree.children.length === 0 && tree.files.length === 0;

  const onOpenNote = useCallback(
    (n: NoteMeta) => void handleOpen(n),
    [handleOpen],
  );
  const actions = useMemo<ContextActions>(
    () => ({
      rename: (n) => void handleRename(n),
      remove: (n) => void handleDelete(n),
    }),
    [handleRename, handleDelete],
  );
  const folderActions = useMemo<FolderActions>(
    () => ({
      newSubfolder: (f) => void handleNewFolder(f.path),
      rename: (f) => void handleRenameFolder(f),
      remove: (f) => void handleDeleteFolder(f),
    }),
    [handleNewFolder, handleRenameFolder, handleDeleteFolder],
  );

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
          <NotesTree
            tree={tree}
            activePath={openRelPath}
            onOpen={onOpenNote}
            actions={actions}
            folderActions={folderActions}
          />
        )}
      </div>
    </div>
  );
}

interface NotesTreeProps {
  tree: FolderNode;
  activePath: string | null;
  onOpen: (note: NoteMeta) => void;
  actions: ContextActions;
  folderActions: FolderActions;
}

/** Folder paths that contain `relPath`, outermost first (excluding the root). */
function ancestorFolders(relPath: string): string[] {
  const segments = relPath.split("/");
  const out: string[] = [];
  for (let i = 2; i < segments.length; i++) {
    out.push(segments.slice(0, i).join("/"));
  }
  return out;
}

/**
 * The note tree, flattened to the rows of expanded folders and windowed:
 * only the rows inside the scroll viewport (plus overscan) are mounted.
 * Expansion state lives here, so it survives list refreshes.
 */
function NotesTree({
  tree,
  activePath,
  onOpen,
  actions,
  folderActions,
}: NotesTreeProps) {
  // Explicit user choices; anything absent falls back to the default
  // (top-level folders expanded, nested folders collapsed).
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );
  const isExpanded = useCallback(
    (path: string, depth: number) => overrides.get(path) ?? depth === 1,
    [overrides],
  );
  const rows = useMemo(() => flattenTree(tree, isExpanded), [tree, isExpanded]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT_PX);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const measure = () => {
      if (el.clientHeight > 0) setViewport(el.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (el === null) return;
      const top = index * ROW_HEIGHT_PX;
      const current = el.scrollTop;
      let next = current;
      if (top < current) next = top;
      else if (top + ROW_HEIGHT_PX > current + viewport) {
        next = top + ROW_HEIGHT_PX - viewport;
      }
      if (next !== current) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    },
    [viewport],
  );

  const setExpanded = useCallback((path: string, value: boolean) => {
    setOverrides((prev) => {
      if (prev.get(path) === value) return prev;
      const next = new Map(prev);
      next.set(path, value);
      return next;
    });
  }, []);

  const onToggle = useCallback(
    (node: FolderNode, depth: number) => {
      setExpanded(node.path, !isExpanded(node.path, depth));
    },
    [isExpanded, setExpanded],
  );

  // Roving focus for keyboard navigation.
  const [focusIndex, setFocusIndex] = useState(0);
  const clampedFocus = Math.min(focusIndex, Math.max(rows.length - 1, 0));
  const wantFocusRef = useRef(false);
  useEffect(() => {
    if (!wantFocusRef.current) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${clampedFocus}"]`,
    );
    if (el) {
      wantFocusRef.current = false;
      el.focus();
    }
  });
  const moveFocus = useCallback(
    (index: number) => {
      wantFocusRef.current = true;
      setFocusIndex(index);
      scrollToIndex(index);
    },
    [scrollToIndex],
  );
  const onFocusRow = useCallback((index: number) => setFocusIndex(index), []);

  // Selected note: reveal it (expand its folders) and scroll it into view.
  const pendingRevealRef = useRef<string | null>(null);
  useEffect(() => {
    pendingRevealRef.current = activePath;
    if (activePath === null) return;
    setOverrides((prev) => {
      const missing = ancestorFolders(activePath).filter(
        (p) => prev.get(p) !== true,
      );
      if (missing.length === 0) return prev;
      const next = new Map(prev);
      for (const p of missing) next.set(p, true);
      return next;
    });
  }, [activePath]);
  useEffect(() => {
    const target = pendingRevealRef.current;
    if (target === null) return;
    const index = rows.findIndex(
      (r) => r.kind === "file" && r.note.relPath === target,
    );
    if (index < 0) return;
    pendingRevealRef.current = null;
    setFocusIndex(index);
    scrollToIndex(index);
  }, [rows, scrollToIndex, activePath]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only navigate from the rows themselves, not their action buttons.
    if (
      !(e.target instanceof HTMLElement) ||
      e.target.dataset.rowIndex === undefined
    ) {
      return;
    }
    const row = rows[clampedFocus];
    if (row === undefined) return;
    switch (e.key) {
      case "ArrowDown":
        moveFocus(Math.min(clampedFocus + 1, rows.length - 1));
        break;
      case "ArrowUp":
        moveFocus(Math.max(clampedFocus - 1, 0));
        break;
      case "Home":
        moveFocus(0);
        break;
      case "End":
        moveFocus(rows.length - 1);
        break;
      case "ArrowRight":
        if (row.kind !== "folder") return;
        if (!row.expanded) setExpanded(row.node.path, true);
        else if (rows[clampedFocus + 1]?.depth === row.depth + 1) {
          moveFocus(clampedFocus + 1);
        }
        break;
      case "ArrowLeft":
        if (row.kind === "folder" && row.expanded) {
          setExpanded(row.node.path, false);
        } else {
          for (let i = clampedFocus - 1; i >= 0; i--) {
            const r = rows[i];
            if (r?.kind === "folder" && r.depth === row.depth - 1) {
              moveFocus(i);
              break;
            }
          }
        }
        break;
      case "Enter":
      case " ":
        if (row.kind === "folder") setExpanded(row.node.path, !row.expanded);
        else onOpen(row.note);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const first = Math.max(
    0,
    Math.floor(scrollTop / ROW_HEIGHT_PX) - OVERSCAN_ROWS,
  );
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewport) / ROW_HEIGHT_PX) + OVERSCAN_ROWS,
  );
  const visible: JSX.Element[] = [];
  for (let i = first; i < last; i++) {
    const row = rows[i] as TreeRow;
    const top = i * ROW_HEIGHT_PX;
    visible.push(
      row.kind === "folder" ? (
        <FolderRow
          key={`d:${row.node.path}`}
          node={row.node}
          depth={row.depth}
          expanded={row.expanded}
          index={i}
          top={top}
          focused={i === clampedFocus}
          onToggle={onToggle}
          onFocusRow={onFocusRow}
          folderActions={folderActions}
        />
      ) : (
        <FileRow
          key={`f:${row.note.relPath}`}
          file={row.note}
          depth={row.depth}
          index={i}
          top={top}
          active={row.note.relPath === activePath}
          focused={i === clampedFocus}
          onOpen={onOpen}
          onFocusRow={onFocusRow}
          actions={actions}
        />
      ),
    );
  }

  return (
    <div
      ref={scrollRef}
      className={styles.tree}
      role="tree"
      aria-label="Notes"
      data-testid="notes-tree"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div
        className={styles.treeSpacer}
        style={{ height: rows.length * ROW_HEIGHT_PX }}
      >
        {visible}
      </div>
    </div>
  );
}

interface FileRowProps {
  file: NoteMeta;
  depth: number;
  index: number;
  top: number;
  active: boolean;
  focused: boolean;
  onOpen: (note: NoteMeta) => void;
  onFocusRow: (index: number) => void;
  actions: ContextActions;
}

const FileRow = memo(function FileRow({
  file,
  depth,
  index,
  top,
  active,
  focused,
  onOpen,
  onFocusRow,
  actions,
}: FileRowProps) {
  return (
    <div
      className={styles.fileRowWrap}
      style={{ top, height: ROW_HEIGHT_PX }}
      role="none"
    >
      <button
        type="button"
        role="treeitem"
        aria-level={depth}
        aria-selected={active}
        tabIndex={focused ? 0 : -1}
        data-row-index={index}
        className={`${styles.row} ${styles.fileRow} ${
          active ? styles.rowActive : ""
        }`}
        style={{ paddingLeft: depth * INDENT_PX }}
        onClick={() => onOpen(file)}
        onFocus={() => onFocusRow(index)}
        data-testid={`notes-file-${file.relPath}`}
      >
        <span className={styles.caret} aria-hidden="true" />
        <FileText size={14} className={styles.icon} aria-hidden="true" />
        <span className={styles.label}>{file.title}</span>
        {file.pinned && (
          <span className={styles.pinned} aria-label="pinned" title="pinned">
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
          tabIndex={-1}
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
          tabIndex={-1}
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
});

interface FolderRowProps {
  node: FolderNode;
  depth: number;
  expanded: boolean;
  index: number;
  top: number;
  focused: boolean;
  onToggle: (node: FolderNode, depth: number) => void;
  onFocusRow: (index: number) => void;
  folderActions: FolderActions;
}

const FolderRow = memo(function FolderRow({
  node,
  depth,
  expanded,
  index,
  top,
  focused,
  onToggle,
  onFocusRow,
  folderActions,
}: FolderRowProps) {
  return (
    <div
      className={styles.fileRowWrap}
      style={{ top, height: ROW_HEIGHT_PX }}
      role="none"
    >
      <button
        type="button"
        role="treeitem"
        aria-level={depth}
        aria-expanded={expanded}
        tabIndex={focused ? 0 : -1}
        data-row-index={index}
        className={`${styles.row} ${styles.folderRow}`}
        style={{ paddingLeft: depth * INDENT_PX }}
        onClick={() => onToggle(node, depth)}
        onFocus={() => onFocusRow(index)}
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
          tabIndex={-1}
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
          tabIndex={-1}
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
          tabIndex={-1}
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
  );
});
