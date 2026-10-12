import { create } from "zustand";

import { todayLocal } from "../features/calendar/dateUtils";

/**
 * Calendar mode state shared by the list panel (month grid, My
 * calendars) and the day timeline pane next to the editor.
 */
interface CalendarState {
  /** The day shown in the timeline (YYYY-MM-DD, local). */
  selectedDate: string;
  /** Bumped whenever calendars are added/changed/refreshed. */
  calendarsVersion: number;
  setSelectedDate: (date: string) => void;
  bumpCalendars: () => void;
}

export const useCalendarStore = create<CalendarState>((set) => ({
  selectedDate: todayLocal(),
  calendarsVersion: 0,
  setSelectedDate: (date) => set({ selectedDate: date }),
  bumpCalendars: () => set((s) => ({ calendarsVersion: s.calendarsVersion + 1 })),
}));
