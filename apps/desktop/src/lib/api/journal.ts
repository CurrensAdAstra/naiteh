import { invoke } from "./invoke";

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

/**
 * Save an entry. `expectedVersion` follows the `notes_write` rule
 * (`StaleWrite` when the on-disk version differs); pass `null` for an
 * entry that doesn't exist yet or to overwrite unconditionally.
 */
export function journalSave(
  date: string,
  content: string,
  expectedVersion: string | null,
): Promise<JournalSaveResult> {
  return invoke<JournalSaveResult>("journal_save", {
    date,
    content,
    expectedVersion,
  });
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
