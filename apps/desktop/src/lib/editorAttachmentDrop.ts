//! CodeMirror 6 extension: handle clipboard image pastes and file
//! drag-and-drop inside the editor.
//!
//! On paste, if the clipboard contains any `image/*` items we extract
//! them, upload via `attachments_import_bytes`, and insert the resulting
//! markdown at the cursor. Plain-text pastes pass through to the
//! default CodeMirror handler.
//!
//! On drop, every dropped `File` is uploaded the same way (the original
//! filename is preserved; the backend slugifies and dedupes). Multiple
//! files are joined with double newlines so each lands as its own block
//! in the source. We also handle `dragover` because the browser default
//! is "no drop target" — without preventDefault there, the `drop` event
//! never fires.

import { EditorView } from "@codemirror/view";

import { attachmentsImportBytes } from "./api/attachments";
import { insertAtCursor } from "../state/editorStore";
import { formatAppError } from "./types";

/**
 * Client-side ceiling, mirrors `MAX_ATTACHMENT_BYTES` in the Rust
 * `attachments` service (50 MiB). Enforced here too so an oversized
 * paste is rejected *before* we marshal it into a JSON int-array across
 * the IPC boundary — the backend would reject it anyway, but only after
 * the expensive serialization.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export interface EditorAttachmentOptions {
  /** Surfaces upload failures (read-only state, IO errors, etc.). */
  onError: (message: string | null) => void;
}

export function editorAttachmentDrop(
  opts: EditorAttachmentOptions,
): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    paste(event) {
      const files = filesFromClipboard(event.clipboardData);
      if (files.length === 0) return false;
      event.preventDefault();
      void uploadAndInsert(files, opts.onError);
      return true;
    },
    dragover(event) {
      // Must preventDefault here so the subsequent `drop` event fires.
      // CodeMirror's own dragover handles internal selection drags; we
      // only want to claim it when external files are present.
      if (eventHasFiles(event.dataTransfer)) {
        event.preventDefault();
        return true;
      }
      return false;
    },
    drop(event) {
      const list = event.dataTransfer?.files;
      if (!list || list.length === 0) return false;
      event.preventDefault();
      void uploadAndInsert(Array.from(list), opts.onError);
      return true;
    },
  });
}

// Exported for unit tests — internal helpers but useful primitives.
export function filesFromClipboard(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const out: File[] = [];
  for (const item of data.items) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f !== null) out.push(f);
    }
  }
  return out;
}

export function eventHasFiles(data: DataTransfer | null): boolean {
  if (data === null) return false;
  for (const t of data.types) {
    if (t === "Files") return true;
  }
  return false;
}

export async function uploadAndInsert(
  files: File[],
  onError: (message: string | null) => void,
): Promise<void> {
  onError(null);
  const snippets: string[] = [];
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      onError(
        `"${file.name}" is too large (max ${Math.floor(
          MAX_ATTACHMENT_BYTES / (1024 * 1024),
        )} MB).`,
      );
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      const result = await attachmentsImportBytes(
        new Uint8Array(buf),
        file.name,
        file.type === "" ? null : file.type,
      );
      snippets.push(result.markdown);
    } catch (e) {
      onError(formatAppError(e));
      return;
    }
  }
  if (snippets.length === 0) return;
  const inserted = insertAtCursor(snippets.join("\n\n"));
  if (!inserted) {
    onError("Open a note before inserting attachments.");
  }
}
