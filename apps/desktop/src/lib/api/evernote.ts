import { invoke } from "@tauri-apps/api/core";

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
