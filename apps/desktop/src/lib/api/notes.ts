import { invoke } from "./invoke";

import type { NoteDocument, NoteMeta, NoteWriteResult } from "../types";

export function notesList(relDir: string | null = null): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("notes_list", { relDir });
}

/** Text plus the version token of the bytes read (wiki: ipc-commands). */
export function notesRead(relPath: string): Promise<NoteDocument> {
  return invoke<NoteDocument>("notes_read", { relPath });
}

/**
 * Write `content`. With `expectedVersion` set, the backend refuses the
 * write (`AppError` kind `StaleWrite`, message = current on-disk version)
 * when the file's version differs or the file is gone; `null` writes
 * unconditionally (new files, explicit "keep mine" / copies).
 */
export function notesWrite(
  relPath: string,
  content: string,
  expectedVersion: string | null,
): Promise<NoteWriteResult> {
  return invoke<NoteWriteResult>("notes_write", {
    relPath,
    content,
    expectedVersion,
  });
}

/** Current version token of a note without reading it (NotFound if gone). */
export function notesVersion(relPath: string): Promise<string> {
  return invoke<string>("notes_version", { relPath });
}

export function notesCreate(relDir: string, title: string): Promise<NoteMeta> {
  return invoke<NoteMeta>("notes_create", { relDir, title });
}

export function notesDelete(relPath: string): Promise<void> {
  return invoke<void>("notes_delete", { relPath });
}

export function notesRename(from: string, to: string): Promise<NoteMeta> {
  return invoke<NoteMeta>("notes_rename", { from, to });
}

// ── folders ────────────────────────────────────────────────────────────

/** Every folder under `notes/`, including empty ones. */
export function notesListDirs(): Promise<string[]> {
  return invoke<string[]>("notes_list_dirs");
}

export function notesCreateDir(relDir: string): Promise<void> {
  return invoke<void>("notes_create_dir", { relDir });
}

/** Recursively deletes the folder and everything in it. */
export function notesDeleteDir(relDir: string): Promise<void> {
  return invoke<void>("notes_delete_dir", { relDir });
}

export function notesRenameDir(from: string, to: string): Promise<void> {
  return invoke<void>("notes_rename_dir", { from, to });
}
