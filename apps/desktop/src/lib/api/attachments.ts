import { invoke } from "@tauri-apps/api/core";

import type { AttachmentImport } from "../types";

export function attachmentsImport(): Promise<AttachmentImport> {
  return invoke<AttachmentImport>("attachments_import");
}

/**
 * Import bytes from a browser-side `File` or `ClipboardItem` (clipboard
 * paste, drag-and-drop). Pass an empty `suggestedName` for clipboard
 * pastes — the backend synthesizes `paste-YYYY-MM-DD-HHMMSS.<ext>`
 * using the MIME hint.
 */
export function attachmentsImportBytes(
  bytes: Uint8Array,
  suggestedName: string,
  mime: string | null,
): Promise<AttachmentImport> {
  // Tauri's JSON-based IPC needs a plain array for Rust `Vec<u8>`.
  // For typical screenshot sizes (≲ 1MB) the overhead is acceptable;
  // we can swap to a binary channel if/when pastes get noticeably slow.
  return invoke<AttachmentImport>("attachments_import_bytes", {
    bytes: Array.from(bytes),
    suggestedName,
    mime,
  });
}
