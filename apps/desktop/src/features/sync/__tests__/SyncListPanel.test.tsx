import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConflictPair, SyncStatus } from "../../../lib/types";
import { SyncListPanel } from "../SyncListPanel";

vi.mock("../../../lib/api/sync", () => ({
  syncStatus: vi.fn(),
  syncInit: vi.fn(),
  syncSetRemote: vi.fn(),
  syncNow: vi.fn(),
  syncPull: vi.fn(),
  syncPush: vi.fn(),
  syncListConflicts: vi.fn(),
  syncResolveKeepOurs: vi.fn(),
  syncResolveKeepTheirs: vi.fn(),
}));
vi.mock("../../../lib/openByRelPath", () => ({
  openByRelPath: vi.fn().mockResolvedValue(undefined),
}));

import {
  syncInit,
  syncListConflicts,
  syncNow,
  syncResolveKeepOurs,
  syncResolveKeepTheirs,
  syncSetRemote,
  syncStatus,
} from "../../../lib/api/sync";

const mockedStatus = vi.mocked(syncStatus);
const mockedInit = vi.mocked(syncInit);
const mockedSetRemote = vi.mocked(syncSetRemote);
const mockedNow = vi.mocked(syncNow);
const mockedListConflicts = vi.mocked(syncListConflicts);
const mockedKeepOurs = vi.mocked(syncResolveKeepOurs);
const mockedKeepTheirs = vi.mocked(syncResolveKeepTheirs);

function conflict(rel: string, ts: string): ConflictPair {
  return {
    relPath: rel,
    conflictRelPath: rel.replace(".md", `.conflict-${ts}.md`),
    timestamp: ts,
  };
}

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    remoteUrl: null,
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: false,
    lastSync: null,
    ...overrides,
  };
}

describe("SyncListPanel", () => {
  beforeEach(() => {
    mockedStatus.mockReset();
    mockedInit.mockReset();
    mockedSetRemote.mockReset();
    mockedNow.mockReset();
    mockedListConflicts.mockReset();
    mockedListConflicts.mockResolvedValue([]);
    mockedKeepOurs.mockReset();
    mockedKeepOurs.mockResolvedValue(undefined);
    mockedKeepTheirs.mockReset();
    mockedKeepTheirs.mockResolvedValue(undefined);
  });

  it("offers an Initialize button when sync_status reports no repository", async () => {
    mockedStatus.mockRejectedValue({
      kind: "NotFound",
      message: "no repository at /v",
    });
    render(<SyncListPanel />);
    expect(
      await screen.findByTestId("sync-init-button"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("sync-status-card")).not.toBeInTheDocument();
  });

  it("clicking Initialize calls sync_init and refreshes status", async () => {
    mockedStatus
      .mockRejectedValueOnce({
        kind: "NotFound",
        message: "no repository at /v",
      })
      .mockResolvedValueOnce(status());
    mockedInit.mockResolvedValue();

    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(await screen.findByTestId("sync-init-button"));
    await waitFor(() => expect(mockedInit).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("sync-status-card")).toBeInTheDocument();
  });

  it("renders status fields when initialized", async () => {
    mockedStatus.mockResolvedValue(
      status({
        remoteUrl: "https://example.com/repo.git",
        branch: "main",
        ahead: 1,
        behind: 0,
        dirty: true,
        lastSync: Math.floor(Date.now() / 1000) - 60,
      }),
    );
    render(<SyncListPanel />);
    const card = await screen.findByTestId("sync-status-card");
    expect(within(card).getByText(/pending changes/i)).toBeInTheDocument();
    expect(
      within(card).getByText("https://example.com/repo.git"),
    ).toBeInTheDocument();
    expect(within(card).getByText("main")).toBeInTheDocument();
    expect(within(card).getByText("1 / 0")).toBeInTheDocument();
  });

  it("never shows the words 'git'/'commit'/'rebase' in UI copy", async () => {
    // Architecture.md §7.7. Render with no remote so the only text in the
    // panel is naiteh's own copy (no user-supplied URL muddying the search).
    mockedStatus.mockResolvedValue(status({ remoteUrl: null }));
    render(<SyncListPanel />);
    await screen.findByTestId("sync-status-card");
    const text = screen.getByTestId("list-panel-sync").textContent ?? "";
    const lower = text.toLowerCase();
    expect(lower).not.toMatch(/\bgit\b/);
    expect(lower).not.toMatch(/\bcommit\b/);
    expect(lower).not.toMatch(/\brebase\b/);
  });

  it("clicking Sync now calls sync_now and refreshes", async () => {
    mockedStatus
      .mockResolvedValueOnce(status({ dirty: true }))
      .mockResolvedValueOnce(
        status({
          dirty: false,
          lastSync: Math.floor(Date.now() / 1000),
        }),
      );
    mockedNow.mockResolvedValue(status({ dirty: false }));

    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(await screen.findByTestId("sync-now-button"));
    await waitFor(() => expect(mockedNow).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        within(screen.getByTestId("sync-status-card")).getByText(/up to date/i),
      ).toBeInTheDocument();
    });
  });

  it("Save destination is disabled until the URL field has content", async () => {
    mockedStatus.mockResolvedValue(status());
    const user = userEvent.setup();
    render(<SyncListPanel />);
    const button = await screen.findByTestId("sync-save-remote-button");
    expect(button).toBeDisabled();
    await user.type(
      screen.getByTestId("sync-remote-input"),
      "https://example.com/repo.git",
    );
    expect(button).toBeEnabled();
  });

  it("clicking Save destination calls sync_set_remote with the trimmed URL", async () => {
    mockedStatus
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(
        status({ remoteUrl: "https://example.com/repo.git" }),
      );
    mockedSetRemote.mockResolvedValue();
    const user = userEvent.setup();
    render(<SyncListPanel />);
    const input = await screen.findByTestId("sync-remote-input");
    await user.type(input, "  https://example.com/repo.git  ");
    await user.click(screen.getByTestId("sync-save-remote-button"));
    await waitFor(() =>
      expect(mockedSetRemote).toHaveBeenCalledWith(
        "https://example.com/repo.git",
      ),
    );
  });

  it("surfaces backend errors", async () => {
    mockedStatus.mockRejectedValue({
      kind: "Io",
      message: "boom",
    });
    render(<SyncListPanel />);
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });

  // ── conflicts ────────────────────────────────────────────────────────

  it("hides the conflicts section when there are none", async () => {
    mockedStatus.mockResolvedValue(status());
    mockedListConflicts.mockResolvedValue([]);
    render(<SyncListPanel />);
    await screen.findByTestId("sync-status-card");
    expect(screen.queryByTestId("sync-conflicts")).not.toBeInTheDocument();
  });

  it("renders one row per conflict with both action buttons", async () => {
    mockedStatus.mockResolvedValue(status());
    mockedListConflicts.mockResolvedValue([
      conflict("notes/a.md", "2026-05-09T10-00-00"),
      conflict("notes/work/b.md", "2026-05-10T11-22-33"),
    ]);

    render(<SyncListPanel />);
    const section = await screen.findByTestId("sync-conflicts");
    expect(within(section).getByText(/conflicts \(2\)/i)).toBeInTheDocument();
    expect(screen.getByTestId("conflict-notes/a.md")).toBeInTheDocument();
    expect(
      screen.getByTestId("conflict-keep-ours-notes/a.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("conflict-keep-theirs-notes/work/b.md"),
    ).toBeInTheDocument();
  });

  it("Keep mine calls sync_resolve_keep_ours and refreshes the list", async () => {
    mockedStatus.mockResolvedValue(status());
    mockedListConflicts
      .mockResolvedValueOnce([conflict("notes/a.md", "2026-05-09T10-00-00")])
      .mockResolvedValueOnce([]);

    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(
      await screen.findByTestId("conflict-keep-ours-notes/a.md"),
    );

    await waitFor(() => {
      expect(mockedKeepOurs).toHaveBeenCalledWith(
        "notes/a.conflict-2026-05-09T10-00-00.md",
      );
    });
    await waitFor(() => {
      expect(screen.queryByTestId("sync-conflicts")).not.toBeInTheDocument();
    });
  });

  it("Keep theirs passes both paths", async () => {
    mockedStatus.mockResolvedValue(status());
    mockedListConflicts
      .mockResolvedValueOnce([conflict("notes/a.md", "2026-05-09T10-00-00")])
      .mockResolvedValueOnce([]);

    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(
      await screen.findByTestId("conflict-keep-theirs-notes/a.md"),
    );

    await waitFor(() => {
      expect(mockedKeepTheirs).toHaveBeenCalledWith(
        "notes/a.conflict-2026-05-09T10-00-00.md",
      );
    });
  });
});
