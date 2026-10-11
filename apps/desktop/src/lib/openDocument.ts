import { journalOpen } from "./api/journal";
import { notesRead } from "./api/notes";
import { journalDateFromRelPath, journalRelPathFor } from "./journalPath";
import { isAppError } from "./types";
import { useAuthStore } from "../state/authStore";
import { useUIStore } from "../state/uiStore";
import { discardPendingSave, flushPendingSave } from "../state/autosave";
import {
  beginOpen,
  isDirty,
  isLatestOpen,
  useEditorStore,
  type OpenSource,
} from "../state/editorStore";

/** What to open: a free-form note by path, or a journal entry by date. */
export type OpenTarget =
  | { kind: "note"; relPath: string }
  | { kind: "journal"; date: string };

/** Classify a vault-relative path (canonical journal path → journal). */
export function targetForRelPath(relPath: string): OpenTarget {
  const date = journalDateFromRelPath(relPath);
  return date !== null
    ? { kind: "journal", date }
    : { kind: "note", relPath };
}

async function readTarget(target: OpenTarget): Promise<string> {
  if (target.kind === "journal") {
    const result = await journalOpen(target.date);
    return result.content;
  }
  return notesRead(target.relPath);
}

/**
 * The one way to open a document in the editor.
 *
 * 1. Flushes any pending autosave so the document being left is written
 *    to *its own* path (and a re-open of the same path reads fresh text).
 * 2. Reads the target from disk.
 * 3. Applies the result only if no newer open request started meanwhile,
 *    so out-of-order IPC replies can't open a stale selection.
 *
 * Resolves `true` when the document was opened, `false` when a newer
 * request superseded it. Read failures reject.
 *
 * The editor mode resets to `view` when a different document opens
 * (pass `{ edit: true }` for a just-created document).
 *
 * Audit detail is uniform: `note_open` → relPath, `journal_open` → date
 * (matching `note_save` / `journal_save`).
 */
export interface OpenOptions {
  /**
   * Open straight into the source editor. Used for documents the user
   * just created; everything else opens in the rendered view.
   */
  edit?: boolean;
}

export async function openDocument(
  target: OpenTarget,
  opts: OpenOptions = {},
): Promise<boolean> {
  const ticket = beginOpen();
  await flushPendingSave();
  if (!isLatestOpen(ticket)) return false;
  const content = await readTarget(target);
  if (!isLatestOpen(ticket)) return false;
  const editor = useEditorStore.getState();
  const previousKey = editor.open?.key ?? null;
  const logAction = useAuthStore.getState().logAction;
  if (target.kind === "journal") {
    editor.openJournal(target.date, journalRelPathFor(target.date), content);
    void logAction("journal_open", target.date).catch(() => {});
  } else {
    editor.openNote(target.relPath, content);
    void logAction("note_open", target.relPath).catch(() => {});
  }
  // A different document starts in the rendered view; re-opening the
  // same one keeps whatever mode the user was in.
  const ui = useUIStore.getState();
  if (opts.edit === true) ui.setEditorMode("edit");
  else if (useEditorStore.getState().open?.key !== previousKey) {
    ui.setEditorMode("view");
  }
  return true;
}

/**
 * Close the open document. By default pending edits are flushed first;
 * pass `{ discard: true }` when the file itself is gone (deleted) so a
 * late autosave can't resurrect it.
 */
export async function closeDocument(
  opts: { discard?: boolean } = {},
): Promise<void> {
  const open = useEditorStore.getState().open;
  if (opts.discard === true) {
    if (open !== null) discardPendingSave(open.key);
  } else {
    await flushPendingSave();
  }
  useEditorStore.getState().closeNote();
}

function sourceAsTarget(source: OpenSource): OpenTarget {
  return source.kind === "journal"
    ? { kind: "journal", date: source.date }
    : { kind: "note", relPath: source.relPath };
}

/**
 * Re-read the open document from disk after something outside the editor
 * changed files (sync pull, conflict resolution) and push the new text
 * into the editor without marking it dirty.
 *
 * Callers should `flushPendingSave()` *before* the external operation so
 * local edits reach disk first. If the user typed again while the
 * operation ran, the document is dirty and left alone — those newer
 * local edits win and autosave writes them.
 *
 * A note that no longer exists on disk is closed.
 */
export async function reloadOpenDocument(): Promise<void> {
  const open = useEditorStore.getState().open;
  if (open === null || isDirty(open)) return;
  // No open ticket here: a reload must never cancel a user-initiated open.
  // The key check below discards the result if the user moved on.
  let content: string;
  try {
    content = await readTarget(sourceAsTarget(open.source));
  } catch (e) {
    const current = useEditorStore.getState().open;
    if (
      isAppError(e) &&
      e.kind === "NotFound" &&
      current !== null &&
      current.key === open.key &&
      !isDirty(current)
    ) {
      discardPendingSave(open.key);
      useEditorStore.getState().closeNote();
      return;
    }
    throw e;
  }
  const current = useEditorStore.getState().open;
  if (current === null || current.key !== open.key || isDirty(current)) return;
  if (current.content === content) return;
  useEditorStore.getState().reloadOpen(open.key, content);
}
