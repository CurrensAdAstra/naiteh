import { CalendarListPanel } from "../features/calendar/CalendarListPanel";
import { JournalListPanel } from "../features/journal/JournalListPanel";
import { NotesListPanel } from "../features/notes/NotesListPanel";
import { SearchListPanel } from "../features/search/SearchListPanel";
import { SyncListPanel } from "../features/sync/SyncListPanel";
import { TagsListPanel } from "../features/tags/TagsListPanel";
import type { ViewMode } from "../state/uiStore";

export interface PanelRouterProps {
  mode: ViewMode;
}

export function PanelRouter({ mode }: PanelRouterProps) {
  switch (mode) {
    case "journal":
      return <JournalListPanel />;
    case "notes":
      return <NotesListPanel />;
    case "calendar":
      return <CalendarListPanel />;
    case "search":
      return <SearchListPanel />;
    case "tags":
      return <TagsListPanel />;
    case "sync":
      return <SyncListPanel />;
  }
}
