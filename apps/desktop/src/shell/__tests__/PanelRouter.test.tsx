import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ViewMode } from "../../state/uiStore";
import { PanelRouter } from "../PanelRouter";

// PanelRouter's contract is "for each mode, render the right component".
// Stub each panel so this test stays isolated from data-fetching effects.
vi.mock("../../features/journal/JournalListPanel", () => ({
  JournalListPanel: () => <div data-testid="list-panel-journal" />,
}));
vi.mock("../../features/notes/NotesListPanel", () => ({
  NotesListPanel: () => <div data-testid="list-panel-notes" />,
}));
vi.mock("../../features/calendar/CalendarListPanel", () => ({
  CalendarListPanel: () => <div data-testid="list-panel-calendar" />,
}));
vi.mock("../../features/search/SearchListPanel", () => ({
  SearchListPanel: () => <div data-testid="list-panel-search" />,
}));
vi.mock("../../features/tags/TagsListPanel", () => ({
  TagsListPanel: () => <div data-testid="list-panel-tags" />,
}));
vi.mock("../../features/sync/SyncListPanel", () => ({
  SyncListPanel: () => <div data-testid="list-panel-sync" />,
}));
vi.mock("../../features/settings/SettingsListPanel", () => ({
  SettingsListPanel: () => <div data-testid="list-panel-settings" />,
}));

const CASES: Array<{ mode: ViewMode; testId: string }> = [
  { mode: "journal", testId: "list-panel-journal" },
  { mode: "notes", testId: "list-panel-notes" },
  { mode: "calendar", testId: "list-panel-calendar" },
  { mode: "search", testId: "list-panel-search" },
  { mode: "tags", testId: "list-panel-tags" },
  { mode: "sync", testId: "list-panel-sync" },
  { mode: "settings", testId: "list-panel-settings" },
];

describe("PanelRouter", () => {
  it.each(CASES)("renders the $testId for mode=$mode", ({ mode, testId }) => {
    render(<PanelRouter mode={mode} />);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });
});
