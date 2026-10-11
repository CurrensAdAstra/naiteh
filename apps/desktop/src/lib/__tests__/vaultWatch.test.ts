import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));
vi.mock("../api/notes", () => ({
  notesRead: vi.fn(),
  notesWrite: vi.fn(),
  notesVersion: vi.fn(),
}));
vi.mock("../api/journal", () => ({
  journalOpen: vi.fn(),
  journalSave: vi.fn(),
}));

import { journalOpen } from "../api/journal";
import { notesRead, notesVersion, notesWrite } from "../api/notes";
import type { VaultChange, VaultChangedPayload } from "../types";
import {
  changeTouches,
  FOCUS_RECHECK_THROTTLE_MS,
  startVaultWatch,
  VAULT_CHANGE_DEBOUNCE_MS,
} from "../vaultWatch";
import { isSaveHeld, resetAutosaveForTests } from "../../state/autosave";
import { isDirty, useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { useVaultContentStore } from "../../state/vaultContentStore";

const mockedVersion = vi.mocked(notesVersion);
const mockedRead = vi.mocked(notesRead);
const mockedWrite = vi.mocked(notesWrite);
const mockedJournalOpen = vi.mocked(journalOpen);

function fire(name: string, payload: unknown) {
  const handler = handlers.get(name);
  if (handler === undefined) throw new Error(`no listener for ${name}`);
  handler({ payload });
}

function change(
  relPath: string,
  kind: VaultChange["kind"] = "modified",
  own = false,
): VaultChange {
  return { relPath, kind, own };
}

function batch(changes: VaultChange[], overflow = false): VaultChangedPayload {
  return { vaultRoot: "/v", changes, overflow };
}

async function settle(ms: number = VAULT_CHANGE_DEBOUNCE_MS) {
  await vi.advanceTimersByTimeAsync(ms);
  // Let the IPC mocks and store updates behind the timer resolve.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("vaultWatch", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    resetAutosaveForTests();
    mockedVersion.mockReset();
    mockedRead.mockReset();
    mockedWrite.mockReset();
    mockedJournalOpen.mockReset();
    useEditorStore.setState({
      open: null,
      view: null,
      saveError: null,
      externalChange: null,
    });
    useUIStore.setState({ liveUpdatesUnavailable: "stale", notice: null });
    useVaultContentStore.setState({ version: 0 });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it("subscribes to both vault events and clears the live-updates flag", async () => {
    stop = await startVaultWatch();
    expect(handlers.has("vault:changed")).toBe(true);
    expect(handlers.has("vault:watch-error")).toBe(true);
    expect(useUIStore.getState().liveUpdatesUnavailable).toBeNull();
  });

  it("ignores batches where every change is naiteh's own", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    fire(
      "vault:changed",
      batch([change("notes/a.md", "modified", true), change("notes/b.md", "created", true)]),
    );
    await settle();
    expect(useVaultContentStore.getState().version).toBe(0);
    expect(mockedVersion).not.toHaveBeenCalled();
  });

  it("debounces list refreshes: several batches → one content-version bump", async () => {
    stop = await startVaultWatch();
    fire("vault:changed", batch([change("notes/x.md")]));
    await vi.advanceTimersByTimeAsync(VAULT_CHANGE_DEBOUNCE_MS / 2);
    fire("vault:changed", batch([change("notes/y.md", "created")]));
    await settle();
    expect(useVaultContentStore.getState().version).toBe(1);
    // Nothing open → no document check.
    expect(mockedVersion).not.toHaveBeenCalled();
  });

  it("reloads a clean open note that was modified outside naiteh", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    mockedVersion.mockResolvedValue("v2");
    mockedRead.mockResolvedValue({ content: "from drive", version: "v2" });
    fire("vault:changed", batch([change("notes/a.md")]));
    await settle();
    const open = useEditorStore.getState().open!;
    expect(open.content).toBe("from drive");
    expect(open.savedVersion).toBe("v2");
    expect(isDirty(open)).toBe(false);
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(useVaultContentStore.getState().version).toBe(1);
  });

  it("does not touch the open note when a change elsewhere arrives", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    fire("vault:changed", batch([change("notes/other.md")]));
    await settle();
    expect(mockedVersion).not.toHaveBeenCalled();
    expect(useEditorStore.getState().open?.content).toBe("old");
    expect(useVaultContentStore.getState().version).toBe(1);
  });

  it("puts a dirty open note into the conflict state and holds autosave", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    useEditorStore.getState().setContent("old + typing");
    mockedVersion.mockResolvedValue("v2");
    fire("vault:changed", batch([change("notes/a.md")]));
    await settle();
    expect(mockedRead).not.toHaveBeenCalled();
    expect(useEditorStore.getState().open?.content).toBe("old + typing");
    expect(useEditorStore.getState().externalChange).toEqual({
      key: "note:notes/a.md",
      diskVersion: "v2",
    });
    expect(isSaveHeld("note:notes/a.md")).toBe(true);
  });

  it("leaves a dirty note alone when the disk version still matches", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    useEditorStore.getState().setContent("old + typing");
    mockedVersion.mockResolvedValue("v1");
    fire("vault:changed", batch([change("notes/a.md")]));
    await settle();
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(isSaveHeld("note:notes/a.md")).toBe(false);
  });

  it("overflow refreshes lists and re-checks the open note even without a matching path", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    mockedVersion.mockResolvedValue("v1");
    fire("vault:changed", batch([], true));
    await settle();
    expect(useVaultContentStore.getState().version).toBe(1);
    expect(mockedVersion).toHaveBeenCalledWith("notes/a.md");
    expect(useEditorStore.getState().open?.content).toBe("old");
  });

  it("closes a clean open note that was removed and says so in the status bar", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    mockedVersion.mockRejectedValue({ kind: "NotFound", message: "notes/a.md" });
    fire("vault:changed", batch([change("notes/a.md", "removed")]));
    await settle();
    expect(useEditorStore.getState().open).toBeNull();
    expect(useUIStore.getState().notice).toMatch(/notes\/a\.md was deleted outside naiteh/);
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("a removed parent folder counts as touching the open note", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/work/a.md", "old", "v1");
    mockedVersion.mockRejectedValue({ kind: "NotFound", message: "gone" });
    fire("vault:changed", batch([change("notes/work", "removed")]));
    await settle();
    expect(mockedVersion).toHaveBeenCalledWith("notes/work/a.md");
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("a dirty note whose file was removed enters the conflict state with an empty disk version", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    useEditorStore.getState().setContent("old + typing");
    mockedVersion.mockRejectedValue({ kind: "NotFound", message: "notes/a.md" });
    fire("vault:changed", batch([change("notes/a.md", "removed")]));
    await settle();
    expect(useEditorStore.getState().open?.content).toBe("old + typing");
    expect(useEditorStore.getState().externalChange).toEqual({
      key: "note:notes/a.md",
      diskVersion: "",
    });
  });

  it("checks journal entries through journal_open", async () => {
    stop = await startVaultWatch();
    useEditorStore
      .getState()
      .openJournal("2026-05-09", "journal/2026/05/2026-05-09.md", "day", "v1");
    useEditorStore.getState().setContent("day + typing");
    mockedJournalOpen.mockResolvedValue({
      path: "",
      content: "other pc",
      exists: true,
      version: "v2",
    });
    fire("vault:changed", batch([change("journal/2026/05/2026-05-09.md")]));
    await settle();
    expect(mockedJournalOpen).toHaveBeenCalledWith("2026-05-09");
    expect(useEditorStore.getState().externalChange).toEqual({
      key: "journal:2026-05-09",
      diskVersion: "v2",
    });
  });

  it("vault:watch-error turns live updates off with the backend's message", async () => {
    stop = await startVaultWatch();
    fire("vault:watch-error", { vaultRoot: "/v", message: "too many open files" });
    expect(useUIStore.getState().liveUpdatesUnavailable).toBe(
      "too many open files",
    );
  });

  it("re-checks the open note on window focus, at most once per throttle window", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    mockedVersion.mockResolvedValue("v1");
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await settle(0);
    expect(mockedVersion).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FOCUS_RECHECK_THROTTLE_MS);
    mockedVersion.mockResolvedValue("v2");
    mockedRead.mockResolvedValue({ content: "newer", version: "v2" });
    window.dispatchEvent(new Event("focus"));
    await settle(0);
    expect(mockedVersion).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().open?.content).toBe("newer");
  });

  it("stop() detaches everything", async () => {
    stop = await startVaultWatch();
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    mockedVersion.mockResolvedValue("v1");
    stop();
    stop = null;
    expect(handlers.has("vault:changed")).toBe(false);
    expect(handlers.has("vault:watch-error")).toBe(false);
    window.dispatchEvent(new Event("focus"));
    await settle(0);
    expect(mockedVersion).not.toHaveBeenCalled();
  });

  it("changeTouches matches the file itself or a removed ancestor only", () => {
    expect(changeTouches(change("notes/a.md"), "notes/a.md")).toBe(true);
    expect(changeTouches(change("notes", "removed"), "notes/a.md")).toBe(true);
    expect(changeTouches(change("notes", "modified"), "notes/a.md")).toBe(false);
    expect(changeTouches(change("notes/a", "removed"), "notes/a.md")).toBe(false);
    expect(changeTouches(change("notes/b.md"), "notes/a.md")).toBe(false);
  });
});
