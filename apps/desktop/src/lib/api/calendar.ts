import { hasTauriRuntime, invoke } from "./invoke";

import type {
  CalendarColor,
  CalendarEvent,
  CalendarKind,
  CalendarSource,
  NoteMeta,
} from "../types";

/**
 * Calendar subscriptions (read-only ICS feeds) and their events.
 * Outside Tauri (vite dev in a browser) every read returns empty data.
 */

export function calendarList(): Promise<CalendarSource[]> {
  if (!hasTauriRuntime()) return Promise.resolve([]);
  return invoke<CalendarSource[]>("calendar_list");
}

export interface CalendarAddInput {
  name: string;
  url: string;
  kind: CalendarKind;
  color: CalendarColor;
}

export function calendarAdd(input: CalendarAddInput): Promise<CalendarSource> {
  return invoke<CalendarSource>("calendar_add", { ...input });
}

export interface CalendarUpdateInput {
  id: string;
  name?: string;
  color?: CalendarColor;
  enabled?: boolean;
}

export function calendarUpdate(
  input: CalendarUpdateInput,
): Promise<CalendarSource> {
  return invoke<CalendarSource>("calendar_update", { ...input });
}

export function calendarRemove(id: string): Promise<void> {
  return invoke<void>("calendar_remove", { id });
}

/** Events in `[start, end)` (YYYY-MM-DD, at most 62 days). */
export function calendarEvents(
  start: string,
  end: string,
): Promise<CalendarEvent[]> {
  if (!hasTauriRuntime()) return Promise.resolve([]);
  return invoke<CalendarEvent[]>("calendar_events", { start, end });
}

/** Re-download every enabled feed (callers re-list afterwards). */
export async function calendarRefresh(): Promise<void> {
  if (!hasTauriRuntime()) return;
  await invoke<unknown>("calendar_refresh");
}

export interface CalendarEventNoteInput {
  calendarId: string;
  eventId: string;
  title: string;
  start: string;
  allDay: boolean;
}

/** Create (or return the existing) meeting note for an event. */
export function calendarEventNote(
  input: CalendarEventNoteInput,
): Promise<NoteMeta> {
  return invoke<NoteMeta>("calendar_event_note", { ...input });
}
