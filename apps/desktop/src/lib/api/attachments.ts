import { invoke } from "@tauri-apps/api/core";

import type { AttachmentImport } from "../types";

export function attachmentsImport(): Promise<AttachmentImport> {
  return invoke<AttachmentImport>("attachments_import");
}
