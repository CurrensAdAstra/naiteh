import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SearchHit } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { SearchListPanel } from "../SearchListPanel";

vi.mock("../../../lib/api/search", () => ({
  searchText: vi.fn(),
}));
vi.mock("../../../lib/api/notes", () => ({
  notesRead: vi.fn(),
}));
vi.mock("../../../lib/api/journal", () => ({
  journalOpen: vi.fn(),
}));

import { journalOpen } from "../../../lib/api/journal";
import { notesRead } from "../../../lib/api/notes";
import { searchText } from "../../../lib/api/search";

const mockedSearch = vi.mocked(searchText);
const mockedNotesRead = vi.mocked(notesRead);
const mockedJournalOpen = vi.mocked(journalOpen);

function hit(
  relPath: string,
  title: string,
  line: number,
  excerpt: string,
): SearchHit {
  return { relPath, title, line, excerpt };
}

describe("SearchListPanel", () => {
  beforeEach(() => {
    mockedSearch.mockReset();
    mockedNotesRead.mockReset();
    mockedJournalOpen.mockReset();
    useEditorStore.setState({ open: null });
  });

  it("shows the prompt when the query is empty", () => {
    render(<SearchListPanel />);
    expect(screen.getByText(/type to search/i)).toBeInTheDocument();
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it(
    "debounces typing and dispatches a single trimmed query",
    async () => {
      mockedSearch.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<SearchListPanel />);
      await user.type(screen.getByTestId("search-input"), "  hello  ");
      await waitFor(
        () => {
          expect(mockedSearch).toHaveBeenCalled();
        },
        { timeout: 1500 },
      );
      // Last call should use the trimmed query.
      expect(mockedSearch).toHaveBeenLastCalledWith("hello", 100);
    },
    2000,
  );

  it(
    "renders no-matches status when search returns empty",
    async () => {
      mockedSearch.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<SearchListPanel />);
      await user.type(screen.getByTestId("search-input"), "missing");
      await waitFor(
        () => {
          expect(screen.getByTestId("search-status")).toHaveTextContent(
            /no matches/i,
          );
        },
        { timeout: 1500 },
      );
    },
    2000,
  );

  it(
    "renders match rows with title, line number, and excerpt",
    async () => {
      mockedSearch.mockResolvedValue([
        hit("notes/work/standup.md", "Standup", 7, "agenda for today"),
      ]);
      const user = userEvent.setup();
      render(<SearchListPanel />);
      await user.type(screen.getByTestId("search-input"), "agenda");
      await waitFor(
        () => {
          expect(screen.getByTestId("search-results")).toBeInTheDocument();
        },
        { timeout: 1500 },
      );
      const results = screen.getByTestId("search-results");
      // Title doesn't contain the query → renders as a single text node.
      expect(within(results).getByText("Standup")).toBeInTheDocument();
      expect(within(results).getByText("L7")).toBeInTheDocument();
      // The excerpt "agenda for today" gets split because "agenda" is
      // wrapped in a <mark>; verify total textContent + that the highlight
      // ran.
      const hitRow = within(results).getByTestId(
        "search-hit-notes/work/standup.md-7",
      );
      expect(hitRow.textContent).toContain("agenda for today");
      expect(hitRow.querySelector("mark")?.textContent).toBe("agenda");
      expect(within(results).getByText("notes/work/standup.md")).toBeInTheDocument();
    },
    2000,
  );

  it(
    "clicking a hit dispatches notesRead for note paths",
    async () => {
      mockedSearch.mockResolvedValue([
        hit("notes/work/standup.md", "Standup", 1, "agenda"),
      ]);
      mockedNotesRead.mockResolvedValue("body");
      const user = userEvent.setup();
      render(<SearchListPanel />);
      await user.type(screen.getByTestId("search-input"), "agenda");
      const row = await screen.findByTestId(
        "search-hit-notes/work/standup.md-1",
        {},
        { timeout: 1500 },
      );
      await user.click(row);
      await waitFor(() => {
        expect(mockedNotesRead).toHaveBeenCalledWith("notes/work/standup.md");
        expect(useEditorStore.getState().open?.source).toEqual({
          kind: "note",
          relPath: "notes/work/standup.md",
        });
      });
      expect(mockedJournalOpen).not.toHaveBeenCalled();
    },
    2000,
  );

  it(
    "clicking a journal-shaped hit dispatches journalOpen",
    async () => {
      mockedSearch.mockResolvedValue([
        hit("journal/2026/05/2026-05-09.md", "Day", 3, "needle"),
      ]);
      mockedJournalOpen.mockResolvedValue({
        path: "ignored",
        content: "day body",
        exists: true,
      });
      const user = userEvent.setup();
      render(<SearchListPanel />);
      await user.type(screen.getByTestId("search-input"), "needle");
      const row = await screen.findByTestId(
        "search-hit-journal/2026/05/2026-05-09.md-3",
        {},
        { timeout: 1500 },
      );
      await user.click(row);
      await waitFor(() => {
        expect(mockedJournalOpen).toHaveBeenCalledWith("2026-05-09");
        expect(useEditorStore.getState().open?.source).toEqual({
          kind: "journal",
          date: "2026-05-09",
          relPath: "journal/2026/05/2026-05-09.md",
        });
      });
      expect(mockedNotesRead).not.toHaveBeenCalled();
    },
    2000,
  );

  it(
    "surfaces backend errors",
    async () => {
      mockedSearch.mockRejectedValue({
        kind: "Io",
        message: "boom",
      });
      const user = userEvent.setup();
      render(<SearchListPanel />);
      await user.type(screen.getByTestId("search-input"), "hi");
      await waitFor(
        () => {
          expect(
            within(screen.getByTestId("search-body")).getByText(/boom/i),
          ).toBeInTheDocument();
        },
        { timeout: 1500 },
      );
    },
    2000,
  );
});
