import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteMeta, TimelineItem } from "../../../lib/types";
import { JournalListPanel } from "../JournalListPanel";

vi.mock("../../../lib/api/journal", () => ({
  quickCreate: vi.fn(),
  quickList: vi.fn(),
  activityRecent: vi.fn(),
}));

import { activityRecent, quickCreate, quickList } from "../../../lib/api/journal";

const mockedQuickList = vi.mocked(quickList);
const mockedQuickCreate = vi.mocked(quickCreate);
const mockedActivityRecent = vi.mocked(activityRecent);

const noteFixture: NoteMeta = {
  path: "/v/notes/_inbox/2026-05-09T10-00-00.md",
  relPath: "notes/_inbox/2026-05-09T10-00-00.md",
  title: "2026-05-09T10-00-00",
  tags: [],
  mtime: Math.floor(Date.now() / 1000) - 60,
  size: 0,
  pinned: false,
};

const journalEntryFixture: TimelineItem = {
  kind: "JournalEntry",
  date: "2026-05-09",
  path: "/v/journal/2026/05/2026-05-09.md",
  mtime: Math.floor(Date.now() / 1000) - 30,
  title: "Day entry",
  snippet: "Today I worked on…",
};

const noteItemFixture: TimelineItem = {
  kind: "Note",
  relPath: "notes/work/standup.md",
  title: "Standup",
  mtime: Math.floor(Date.now() / 1000) - 90,
  snippet: "Pinned note body",
  pinned: true,
};

describe("JournalListPanel", () => {
  beforeEach(() => {
    mockedQuickList.mockReset();
    mockedQuickCreate.mockReset();
    mockedActivityRecent.mockReset();
  });

  it("renders empty states when both lists are empty", async () => {
    mockedQuickList.mockResolvedValue([]);
    mockedActivityRecent.mockResolvedValue([]);
    render(<JournalListPanel />);
    expect(
      await within(screen.getByTestId("journal-quick-capture")).findByText(
        /no quick notes yet/i,
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("journal-recent-activity")).getByText(
        /no activity yet/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders quick notes and activity items", async () => {
    mockedQuickList.mockResolvedValue([noteFixture]);
    mockedActivityRecent.mockResolvedValue([
      journalEntryFixture,
      noteItemFixture,
    ]);
    render(<JournalListPanel />);
    expect(
      await within(screen.getByTestId("journal-quick-capture")).findByText(
        noteFixture.title,
      ),
    ).toBeInTheDocument();
    const activitySection = screen.getByTestId("journal-recent-activity");
    expect(within(activitySection).getByText("Day entry")).toBeInTheDocument();
    expect(within(activitySection).getByText("Standup")).toBeInTheDocument();
    // Pinned note exposes a star marker.
    expect(within(activitySection).getByLabelText("pinned")).toBeInTheDocument();
  });

  it('calls quick_create then refreshes when "+ New quick note" is clicked', async () => {
    mockedQuickList.mockResolvedValue([]);
    mockedActivityRecent.mockResolvedValue([]);
    mockedQuickCreate.mockResolvedValue(noteFixture);
    const user = userEvent.setup();
    render(<JournalListPanel />);
    await screen.findByText(/no quick notes yet/i);

    // After create, refresh should pull the new note.
    mockedQuickList.mockResolvedValue([noteFixture]);
    mockedActivityRecent.mockResolvedValue([]);

    await user.click(screen.getByRole("button", { name: /new quick note/i }));
    await waitFor(() => expect(mockedQuickCreate).toHaveBeenCalledTimes(1));
    await within(screen.getByTestId("journal-quick-capture")).findByText(
      noteFixture.title,
    );
    expect(mockedQuickList).toHaveBeenCalledTimes(2);
  });

  it("surfaces backend errors", async () => {
    mockedQuickList.mockRejectedValue({ kind: "NotFound", message: "no vault" });
    mockedActivityRecent.mockResolvedValue([]);
    render(<JournalListPanel />);
    expect(
      await within(screen.getByTestId("journal-quick-capture")).findByText(
        /no vault/i,
      ),
    ).toBeInTheDocument();
  });
});
