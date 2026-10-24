import { journalOpen } from "./api/journal";
import { notesVersion, notesWrite } from "./api/notes";
import { localCopyRelPath } from "./localCopy";
import {
  closeDocument,
  openDocument,
  readTarget,
  reloadOpenDocument,
  sourceAsTarget,
} from "./openDocument";
import { formatAppError, isAppError, isStaleWrite } from "./types";
import {
  hasSaveInFlight,
  holdSave,
  releaseSave,
  saveNow,
} from "../state/autosave";
import {
  isDirty,
  readCurrentDoc,
  useEditorStore,
  type ExternalChange,
  type OpenFile,
  type OpenSource,
} from "../state/editorStore";
import { useUIStore } from "../state/uiStore";
import { notifyVaultContentChanged } from "../state/vaultContentStore";
import { useVaultStore } from "../state/vaultStore";

/**
 * Files change underneath a running naiteh: the vault folder is backed up
 * (and possibly shared with another PC) by Google Drive for desktop, and
 * other editors may touch it too. This module owns what happens to the
 * *open* document when that is detected — by the vault watcher
 * (lib/vaultWatch), by a window-focus freshness check, or by an autosave
 * refused with `StaleWrite` — and the three ways the user can resolve the
 * resulting conflict (shell/EditorPanel banner).
 *
 * Rules (architecture.md "External file changes"):
 * - clean document, file changed  → reload silently
 * - clean document, file removed  → close, status-bar notice
 * - dirty document, file changed  → conflict: edits stay in the editor,
 *   autosave held (`state/autosave`), banner offers Load disk version /
 *   Keep mine / Save mine as copy
 * - dirty document, file removed  → same conflict with `diskVersion ""`
 */

/** Current version token of `source` on disk; `""` when it doesn't exist. */
export async function fetchDiskVersion(source: OpenSource): Promise<string> {
  if (source.kind === "journal") {
    const result = await journalOpen(source.date);
    return result.exists ? result.version : "";
  }
  try {
    return await notesVersion(source.relPath);
  } catch (e) {
    if (isAppError(e) && e.kind === "NotFound") return "";
    throw e;
  }
}

function describe(open: OpenFile): string {
  return open.source.kind === "journal"
    ? `Journal ${open.source.date}`
    : open.source.relPath;
}

function stillOpen(key: string, vaultRoot: string | null): boolean {
  return useEditorStore.getState().open?.key === key &&
    (useVaultStore.getState().active?.root ?? null) === vaultRoot;
}

/**
 * Compare the open document with the file on disk and react as per the
 * rules above. Safe to call often (cheap version read, no-op when nothing
 * is open or the versions agree). Skipped while a save for the document
 * is in flight: that write reports a real conflict itself (`StaleWrite`),
 * whereas a version read racing it could report a false one.
 */
export async function checkOpenDocument(): Promise<void> {
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const open = useEditorStore.getState().open;
  if (open === null || hasSaveInFlight(open.key)) return;
  let diskVersion: string;
  try {
    diskVersion = await fetchDiskVersion(open.source);
  } catch (e) {
    console.warn("external change check failed:", formatAppError(e));
    return;
  }
  const state = useEditorStore.getState();
  const current = state.open;
  if (current === null || !stillOpen(open.key, vaultRoot)) return;
  if (hasSaveInFlight(current.key)) return;
  if (diskVersion === current.savedVersion) return;
  if (!isDirty(current)) {
    if (diskVersion === "") {
      await closeDocument({ discard: true });
      useUIStore
        .getState()
        .setNotice(`${describe(current)} was deleted outside naiteh`);
      return;
    }
    try {
      await reloadOpenDocument();
    } catch (e) {
      console.warn("couldn't reload the open note:", formatAppError(e));
    }
    return;
  }
  holdSave(current.key);
  state.setExternalChange({ key: current.key, diskVersion });
}

function currentConflict(): { open: OpenFile; change: ExternalChange } | null {
  const { open, externalChange } = useEditorStore.getState();
  if (open === null || externalChange === null) return null;
  if (externalChange.key !== open.key) return null;
  return { open, change: externalChange };
}

/** The editor's text right now (the live view is authoritative). */
function localContent(open: OpenFile): string {
  return readCurrentDoc() ?? open.content;
}

/**
 * Resolve by discarding the local edits: re-read the file and show it.
 * A file that vanished meanwhile closes the document instead.
 */
export async function loadDiskVersion(): Promise<void> {
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const conflict = currentConflict();
  if (conflict === null) return;
  const { open } = conflict;
  let doc;
  try {
    doc = await readTarget(sourceAsTarget(open.source));
  } catch (e) {
    if (isAppError(e) && e.kind === "NotFound" && stillOpen(open.key, vaultRoot)) {
      await closeDocument({ discard: true });
      useUIStore
        .getState()
        .setNotice(`${describe(open)} was deleted outside naiteh`);
      return;
    }
    throw e;
  }
  if (!stillOpen(open.key, vaultRoot)) return;
  const editor = useEditorStore.getState();
  releaseSave(open.key);
  editor.reloadOpen(open.key, doc.content, doc.version);
  editor.setExternalChange(null);
}

/**
 * Resolve by overwriting the disk version with the editor's text. The
 * write is conditional on the version the conflict was raised for, so a
 * file that changed *again* meanwhile is still not clobbered: the
 * document stays in conflict with the newer version.
 */
export async function keepMine(): Promise<void> {
  const conflict = currentConflict();
  if (conflict === null) return;
  const { open, change } = conflict;
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const content = localContent(open);
  const expected = change.diskVersion === "" ? null : change.diskVersion;
  try {
    await saveNow(open.source, content, expected, vaultRoot);
  } catch (e) {
    if (!stillOpen(open.key, vaultRoot)) return;
    const editor = useEditorStore.getState();
    if (isStaleWrite(e)) {
      editor.setExternalChange({ key: open.key, diskVersion: e.message });
      return;
    }
    editor.setSaveError(open.key, formatAppError(e));
    return;
  }
  if (!stillOpen(open.key, vaultRoot)) return;
  releaseSave(open.key);
  useEditorStore.getState().setExternalChange(null);
}

/**
 * Resolve by writing the editor's text to a `.local-<timestamp>.md`
 * sibling (an ordinary note, also for journal entries) and showing the
 * disk version. If the original is gone the copy opens instead. Resolves
 * with the copy's relPath; rejects if the copy couldn't be written (the
 * conflict then stays).
 */
export async function saveMineAsCopy(): Promise<string | null> {
  const conflict = currentConflict();
  if (conflict === null) return null;
  const { open, change } = conflict;
  const vaultRoot = useVaultStore.getState().active?.root ?? null;
  const content = localContent(open);
  const copyRelPath = localCopyRelPath(open.source.relPath);
  await notesWrite(copyRelPath, content, null, vaultRoot);
  if ((useVaultStore.getState().active?.root ?? null) !== vaultRoot) return copyRelPath;
  notifyVaultContentChanged();
  useUIStore.getState().setNotice(`Your edits were saved as ${copyRelPath}`);
  if (!stillOpen(open.key, vaultRoot)) return copyRelPath;
  releaseSave(open.key);
  useEditorStore.getState().setExternalChange(null);
  if (change.diskVersion === "") {
    // Nothing left to show at the original path — continue in the copy.
    await closeDocument({ discard: true });
    if ((useVaultStore.getState().active?.root ?? null) !== vaultRoot) return copyRelPath;
    await openDocument({ kind: "note", relPath: copyRelPath });
    return copyRelPath;
  }
  let doc;
  try {
    doc = await readTarget(sourceAsTarget(open.source));
  } catch (e) {
    if (isAppError(e) && e.kind === "NotFound" && stillOpen(open.key, vaultRoot)) {
      await closeDocument({ discard: true });
      if ((useVaultStore.getState().active?.root ?? null) !== vaultRoot) return copyRelPath;
      await openDocument({ kind: "note", relPath: copyRelPath });
      return copyRelPath;
    }
    throw e;
  }
  if (stillOpen(open.key, vaultRoot)) {
    useEditorStore.getState().reloadOpen(open.key, doc.content, doc.version);
  }
  return copyRelPath;
}
