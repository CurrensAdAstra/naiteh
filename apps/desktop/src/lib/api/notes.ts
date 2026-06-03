import { invoke } from "@tauri-apps/api/core";

import type { NoteMeta } from "../types";

export function notesList(relDir: string | null = null): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("notes_list", { relDir });
}

export function notesRead(relPath: string): Promise<string> {
  return invoke<string>("notes_read", { relPath });
}

export function notesWrite(relPath: string, content: string): Promise<NoteMeta> {
  return invoke<NoteMeta>("notes_write", { relPath, content });
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

export function notesSetPinned(relPath: string, pinned: boolean): Promise<NoteMeta> {
  return invoke<NoteMeta>("notes_set_pinned", { relPath, pinned });
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
