import { invoke } from "@tauri-apps/api/core";

import type { NoteMeta, TagCount } from "../types";

export function tagsList(): Promise<TagCount[]> {
  return invoke<TagCount[]>("tags_list");
}

export function tagsNotes(tag: string): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("tags_notes", { tag });
}
