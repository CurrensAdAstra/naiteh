import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn(),
}));
vi.mock("../../lib/api/journal", () => ({
  journalSave: vi.fn(),
}));

import { journalSave } from "../../lib/api/journal";
import { notesWrite } from "../../lib/api/notes";
import type { NoteWriteResult } from "../../lib/types";
import {
  AUTOSAVE_DELAY_MS,
  discardPendingSave,
  flushPendingSave,
  hasPendingSave,
  holdSave,
  isSaveHeld,
  onSaved,
  releaseSave,
  resetAutosaveForTests,
  saveNow,
  scheduleSave,
  suspendAutosave,
} from "../autosave";
import { isDirty, useEditorStore } from "../editorStore";
import { useUIStore } from "../uiStore";
import { useVaultContentStore } from "../vaultContentStore";
import { useVaultStore } from "../vaultStore";

const mockedWrite = vi.mocked(notesWrite);
const mockedJournalSave = vi.mocked(journalSave);

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const META = {
  path: "/v/notes/a.md",
  relPath: "notes/a.md",
  title: "a",
  tags: [],
  mtime: 0,
  size: 0,
  pinned: false,
};

describe("autosave", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedWrite.mockReset();
    mockedWrite.mockResolvedValue({ meta: META, version: "v2" });
    mockedJournalSave.mockReset();
    mockedJournalSave.mockResolvedValue({ path: "", mtime: 0, version: "v2" });
    useEditorStore.setState({
      open: null,
      view: null,
      saveError: null,
      externalChange: null,
    });
    useVaultStore.setState({ active: null });
    useUIStore.setState({ notice: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes after the debounce window", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1");
    expect(mockedWrite).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "v1");
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);
  });

  it("a pending save still targets the original note after switching", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a-edited");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a-edited");
    // The user opens B before the debounce fires.
    useEditorStore.getState().openNote("notes/b.md", "b", "v1");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a-edited", "v1");
    // B is untouched.
    expect(useEditorStore.getState().open?.content).toBe("b");
    expect(useEditorStore.getState().open?.savedContent).toBe("b");
  });

  it("flushPendingSave writes immediately and cancels the timer", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it("flushPendingSave saves a dirty open document even if nothing was scheduled", async () => {
    useEditorStore.getState().openJournal("2026-05-09", "journal/2026/05/2026-05-09.md", "x", "v1");
    useEditorStore.getState().setContent("x2");
    await flushPendingSave();
    expect(mockedJournalSave).toHaveBeenCalledWith("2026-05-09", "x2", "v1");
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);
  });

  it("typing during an in-flight save keeps the note dirty and saves again", async () => {
    const first = deferred<NoteWriteResult>();
    mockedWrite.mockReturnValueOnce(first.promise);
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("b");
    const flushing = flushPendingSave();
    // Write of "b" is in flight; the user keeps typing.
    useEditorStore.getState().setContent("bc");
    first.resolve({ meta: META, version: "v2" });
    await flushing;
    let open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("b");
    expect(isDirty(open)).toBe(true);

    await flushPendingSave();
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "bc", "v2");
    open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("bc");
    expect(isDirty(open)).toBe(false);
  });

  it("a failed save is surfaced, keeps the note dirty, and is retried", async () => {
    vi.useFakeTimers();
    mockedWrite.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    await flushPendingSave();
    expect(useEditorStore.getState().saveError).toEqual({
      key: "note:notes/a.md",
      message: "disk full",
    });
    expect(isDirty(useEditorStore.getState().open!)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockedWrite).toHaveBeenCalledTimes(2);
    expect(useEditorStore.getState().saveError).toBeNull();
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);
    errorSpy.mockRestore();
  });

  it("suspension holds timer writes; discard drops them", async () => {
    vi.useFakeTimers();
    const resume = suspendAutosave();
    scheduleSave({ kind: "note", relPath: "notes/gone.md" }, "late edit");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(mockedWrite).not.toHaveBeenCalled();
    discardPendingSave("note:notes/gone.md");
    resume();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("a held save is written after resume", async () => {
    vi.useFakeTimers();
    const resume = suspendAutosave();
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "held");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(mockedWrite).not.toHaveBeenCalled();
    resume();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "held", null);
  });

  it("drops a pending save when the vault changed underneath it", async () => {
    vi.useFakeTimers();
    useVaultStore.setState({
      active: { root: "/old", name: "old", initialized: true },
    });
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "edit");
    useVaultStore.setState({
      active: { root: "/new", name: "new", initialized: true },
    });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("notifies save listeners after a successful write", async () => {
    const listener = vi.fn();
    const off = onSaved(listener);
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    await flushPendingSave();
    expect(listener).toHaveBeenCalledWith(
      { kind: "note", relPath: "notes/a.md" },
      "a1",
    );
    off();
  });

  // ── versions / changed-on-disk conflicts ─────────────────────────────

  it("sends the saved version as expectedVersion, null for a file not on disk yet", async () => {
    useEditorStore.getState().openJournal(
      "2026-05-09",
      "journal/2026/05/2026-05-09.md",
      "",
      "",
    );
    useEditorStore.getState().setContent("first words");
    await flushPendingSave();
    expect(mockedJournalSave).toHaveBeenCalledWith(
      "2026-05-09",
      "first words",
      null,
    );
    // The entry now exists: the next save is conditional on its version.
    expect(useEditorStore.getState().open?.savedVersion).toBe("v2");
    useEditorStore.getState().setContent("first words, more");
    await flushPendingSave();
    expect(mockedJournalSave).toHaveBeenLastCalledWith(
      "2026-05-09",
      "first words, more",
      "v2",
    );
  });

  it("a successful write records the version the backend returned", async () => {
    mockedWrite.mockResolvedValue({ meta: META, version: "sha-after" });
    useEditorStore.getState().openNote("notes/a.md", "a", "sha-before");
    useEditorStore.getState().setContent("a1");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "sha-before");
    expect(useEditorStore.getState().open?.savedVersion).toBe("sha-after");
  });

  it("StaleWrite puts the open note in conflict, holds autosave, and never retries blindly", async () => {
    vi.useFakeTimers();
    mockedWrite.mockRejectedValueOnce({ kind: "StaleWrite", message: "disk-v9" });
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(useEditorStore.getState().externalChange).toEqual({
      key: "note:notes/a.md",
      diskVersion: "disk-v9",
    });
    expect(useEditorStore.getState().saveError).toBeNull();
    expect(isSaveHeld("note:notes/a.md")).toBe(true);
    expect(isDirty(useEditorStore.getState().open!)).toBe(true);
    expect(useEditorStore.getState().open?.content).toBe("a1");

    // Neither the retry backoff nor a new debounce nor an explicit flush
    // writes while held — and the flush resolves rather than hanging.
    await vi.advanceTimersByTimeAsync(60_000);
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1b");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(hasPendingSave()).toBe(true);

    // Resolved (e.g. "Keep mine" wrote it): autosave resumes normally.
    releaseSave("note:notes/a.md");
    expect(isSaveHeld("note:notes/a.md")).toBe(false);
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledTimes(2);
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "a1", "v1");
  });

  it("holdSave stops a scheduled save until releaseSave", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1");
    holdSave("note:notes/a.md");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 3);
    expect(mockedWrite).not.toHaveBeenCalled();
    await flushPendingSave();
    expect(mockedWrite).not.toHaveBeenCalled();
    releaseSave("note:notes/a.md");
    // releaseSave drops what was parked; the editor's autosave effect
    // re-schedules anything still dirty (here: an explicit flush).
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "v1");
  });

  it("leaving a document with held edits keeps them as a .local copy", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    holdSave("note:notes/a.md");
    useEditorStore
      .getState()
      .setExternalChange({ key: "note:notes/a.md", diskVersion: "v2" });
    const versionBefore = useVaultContentStore.getState().version;
    await flushPendingSave({ leaving: true });
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [relPath, content, expected] = mockedWrite.mock.calls[0]!;
    expect(relPath).toMatch(/^notes\/a\.local-\d{8}-\d{6}\.md$/);
    expect(content).toBe("a1");
    expect(expected).toBeNull();
    expect(isSaveHeld("note:notes/a.md")).toBe(false);
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(useVaultContentStore.getState().version).toBe(versionBefore + 1);
    expect(useUIStore.getState().notice).toMatch(/kept as notes\/a\.local-/);
    // Nothing was written to the original path.
    expect(
      mockedWrite.mock.calls.some(([p]) => p === "notes/a.md"),
    ).toBe(false);
  });

  it("StaleWrite for a note that is no longer open keeps the edits as a copy", async () => {
    mockedWrite.mockImplementation(async (relPath) =>
      relPath === "notes/a.md"
        ? Promise.reject({ kind: "StaleWrite", message: "v2" })
        : { meta: META, version: "vc" },
    );
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1");
    // The user moved on before the write ran.
    useEditorStore.getState().openNote("notes/b.md", "b", "v1");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledTimes(2);
    expect(mockedWrite.mock.calls[1]![0]).toMatch(/^notes\/a\.local-/);
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
  });

  it("saveNow writes immediately, bypassing a hold, and reports the new version", async () => {
    const listener = vi.fn();
    onSaved(listener);
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("mine");
    holdSave("note:notes/a.md");
    mockedWrite.mockResolvedValue({ meta: META, version: "v5" });
    const version = await saveNow(
      { kind: "note", relPath: "notes/a.md" },
      "mine",
      "v4",
    );
    expect(version).toBe("v5");
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "mine", "v4");
    expect(useEditorStore.getState().open?.savedVersion).toBe("v5");
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);
    expect(listener).toHaveBeenCalledWith(
      { kind: "note", relPath: "notes/a.md" },
      "mine",
    );

    // A rejected saveNow propagates and doesn't poison later writes.
    mockedWrite.mockRejectedValueOnce({ kind: "StaleWrite", message: "v6" });
    await expect(
      saveNow({ kind: "note", relPath: "notes/a.md" }, "mine2", "v5"),
    ).rejects.toMatchObject({ kind: "StaleWrite" });
    releaseSave("note:notes/a.md");
    useEditorStore.getState().setContent("mine3");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "mine3", "v5");
  });

  it("discardPendingSave(key) forgets the key's hold too", () => {
    holdSave("note:notes/gone.md");
    discardPendingSave("note:notes/gone.md");
    expect(isSaveHeld("note:notes/gone.md")).toBe(false);
  });
});
