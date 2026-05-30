import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { EvernoteImportReport } from "../types";

/**
 * Opens a native multi-file picker filtered to `.enex`, then imports
 * every selected file into the active vault. Resolves with a merged
 * report (per-file errors live on `report.errors`; per-note warnings
 * live on each entry of `report.notes`).
 *
 * Throws `AppError.Cancelled` if the user dismisses the dialog without
 * picking anything.
 */
export function evernoteImport(): Promise<EvernoteImportReport> {
  return invoke<EvernoteImportReport>("evernote_import");
}

/** Per-note progress pushed by the backend during an import. */
export interface EvernoteImportProgress {
  fileIndex: number;
  totalFiles: number;
  fileName: string;
  noteDone: number;
  noteTotal: number;
}

/**
 * Subscribe to import progress. The backend throttles to ~100 events
 * per file. Returns the unlisten function — call it once the import
 * settles.
 */
export function listenEvernoteImportProgress(
  handler: (progress: EvernoteImportProgress) => void,
): Promise<UnlistenFn> {
  return listen<EvernoteImportProgress>("evernote-import-progress", (event) =>
    handler(event.payload),
  );
}
