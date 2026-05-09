import { invoke } from "@tauri-apps/api/core";

import type {
  DayMeta,
  JournalOpenResult,
  JournalSaveResult,
  NoteMeta,
  TimelineDay,
  TimelineItem,
} from "../types";

export function quickCreate(): Promise<NoteMeta> {
  return invoke<NoteMeta>("quick_create");
}

export function quickList(limit: number): Promise<NoteMeta[]> {
  return invoke<NoteMeta[]>("quick_list", { limit });
}

export function activityRecent(limit: number): Promise<TimelineItem[]> {
  return invoke<TimelineItem[]>("activity_recent", { limit });
}

export function journalOpen(date: string): Promise<JournalOpenResult> {
  return invoke<JournalOpenResult>("journal_open", { date });
}

export function journalSave(
  date: string,
  content: string,
): Promise<JournalSaveResult> {
  return invoke<JournalSaveResult>("journal_save", { date, content });
}

export function journalMonthMeta(
  year: number,
  month: number,
): Promise<DayMeta[]> {
  return invoke<DayMeta[]>("journal_month_meta", { year, month });
}

export function timelineRange(
  from: string,
  to: string,
): Promise<TimelineDay[]> {
  return invoke<TimelineDay[]>("timeline_range", { from, to });
}

export function timelinePinned(): Promise<TimelineItem[]> {
  return invoke<TimelineItem[]>("timeline_pinned");
}
