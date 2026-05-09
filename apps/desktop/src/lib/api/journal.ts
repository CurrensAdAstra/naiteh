import { invoke } from "@tauri-apps/api/core";

import type { NoteMeta, TimelineItem } from "../types";

export function quickCreate(): Promise<NoteMeta> {
  return invoke<NoteMeta>("quick_create");
}

export function quickList(limit: number): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("quick_list", { limit });
}

export function activityRecent(limit: number): Promise<TimelineItem[]> {
  return invoke<TimelineItem[]>("activity_recent", { limit });
}
