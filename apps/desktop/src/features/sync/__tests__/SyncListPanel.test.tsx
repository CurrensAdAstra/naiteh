import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConflictPair, SyncStatus } from "../../../lib/types";
import { useUIStore } from "../../../state/uiStore";
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
vi.mock("../../../lib/api/notes", () => ({
  notesRead: vi.fn(),
  notesWrite: vi.fn(),
}));

import { notesRead, notesWrite } from "../../../lib/api/notes";
import { resetAutosaveForTests } from "../../../state/autosave";
import { useEditorStore } from "../../../state/editorStore";
import { useSyncStore } from "../../../state/syncStore";
import { useVaultContentStore } from "../../../state/vaultContentStore";

const mockedNotesRead = vi.mocked(notesRead);
const mockedNotesWrite = vi.mocked(notesWrite);

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
    mergePending: false,
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
    resetAutosaveForTests();
    mockedNotesRead.mockReset();
    mockedNotesWrite.mockReset();
    useEditorStore.setState({ open: null, view: null, saveError: null });
    useSyncStore.setState({ status: null, notInitialized: false, loaded: false });
  });

  it("Sync now flushes unsaved edits first, then reloads the open note and refreshes everything", async () => {
    const order: string[] = [];
    mockedStatus.mockResolvedValue(status({ dirty: false }));
    mockedNotesWrite.mockImplementation(async (relPath, content) => {
      order.push(`write:${relPath}:${content}`);
      return {
        path: "",
        relPath,
        title: "",
        tags: [],
        mtime: 0,
        size: 0,
        pinned: false,
      };
    });
    mockedNow.mockImplementation(async () => {
      order.push("sync");
      return status();
    });
    mockedNotesRead.mockImplementation(async () => {
      order.push("read");
      return "pulled from remote";
    });
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/a.md" },
        key: "note:notes/a.md",
        content: "local unsaved",
        savedContent: "local",
      },
    });
    const versionBefore = useVaultContentStore.getState().version;

    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(await screen.findByTestId("sync-now-button"));

    await waitFor(() => {
      expect(useEditorStore.getState().open?.content).toBe(
        "pulled from remote",
      );
    });
    expect(order).toEqual([
      "write:notes/a.md:local unsaved",
      "sync",
      "read",
    ]);
    expect(useEditorStore.getState().open?.savedContent).toBe(
      "pulled from remote",
    );
    // Status bar store refreshed immediately, lists told to refetch.
    expect(useSyncStore.getState().loaded).toBe(true);
    expect(useVaultContentStore.getState().version).toBeGreaterThan(
      versionBefore,
    );
  });

  it("shows conflict-scan failures instead of hiding them", async () => {
    mockedStatus.mockResolvedValue(status());
    mockedListConflicts.mockRejectedValue({ kind: "Io", message: "scan broke" });
    render(<SyncListPanel />);
    expect(
      await screen.findByTestId("sync-conflict-error"),
    ).toHaveTextContent(/scan broke/);
  });

  it("Keep mine closes the conflict sidecar if it is open", async () => {
    mockedStatus.mockResolvedValue(status());
    const pair = conflict("notes/a.md", "2026-05-09T10-00-00");
    mockedListConflicts.mockResolvedValueOnce([pair]).mockResolvedValueOnce([]);
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: pair.conflictRelPath },
        key: `note:${pair.conflictRelPath}`,
        content: "theirs",
        savedContent: "theirs",
      },
    });
    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(
      await screen.findByTestId("conflict-keep-ours-notes/a.md"),
    );
    await waitFor(() => expect(useEditorStore.getState().open).toBeNull());
    expect(mockedNotesWrite).not.toHaveBeenCalled();
  });

  it("points to Google Drive as the recommended backup", async () => {
    mockedStatus.mockRejectedValue({
      kind: "NotFound",
      message: "no repository at /v",
    });
    useUIStore.setState({ settingsOpen: false, pendingAction: null });
    render(<SyncListPanel />);
    expect(screen.getByTestId("sync-backup-hint")).toHaveTextContent(
      /optional.*Google Drive/i,
    );
    fireEvent.click(screen.getByTestId("sync-backup-settings-link"));
    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(useUIStore.getState().pendingAction).toBe("showBackup");
    await screen.findByTestId("sync-init-button");
  });

  it("warns about private repositories and GitHub's 100 MB limit next to the destination", async () => {
    mockedStatus.mockResolvedValue(status());
    render(<SyncListPanel />);
    expect(await screen.findByTestId("sync-remote-caveat")).toHaveTextContent(
      /private.*100 MB/is,
    );
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
    // vault/wiki/ipc-api.md ("Sync"). Render with no remote so the only text in the
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

  it("mergePending: explains the paused sync and re-enables it once resolved", async () => {
    mockedStatus
      .mockResolvedValueOnce(status({ mergePending: true }))
      .mockResolvedValue(status({ mergePending: false }));
    mockedListConflicts
      .mockResolvedValueOnce([conflict("notes/a.md", "2026-05-09T10-00-00")])
      .mockResolvedValue([]);

    const user = userEvent.setup();
    render(<SyncListPanel />);

    expect(await screen.findByTestId("sync-merge-pending")).toHaveTextContent(
      /resolve conflicts to finish sync/i,
    );
    expect(screen.getByTestId("sync-status-card")).toHaveTextContent(
      /merge pending/i,
    );
    expect(screen.getByTestId("sync-now-button")).toBeDisabled();

    await user.click(screen.getByTestId("conflict-keep-ours-notes/a.md"));

    await waitFor(() => {
      expect(screen.queryByTestId("sync-merge-pending")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("sync-now-button")).toBeEnabled();
  });

  it("surfaces the backend's refusal while a merge is pending", async () => {
    // mergePending with no visible conflicts: the button stays enabled so
    // the backend's explanation reaches the user.
    mockedStatus.mockResolvedValue(status({ mergePending: true }));
    mockedNow.mockRejectedValue({
      kind: "Conflict",
      message: "resolve all conflicts before syncing",
    });
    const user = userEvent.setup();
    render(<SyncListPanel />);
    await user.click(await screen.findByTestId("sync-now-button"));
    expect(
      await screen.findByText(/resolve all conflicts before syncing/i),
    ).toBeInTheDocument();
  });
});
