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
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "v1", null);
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
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a-edited", "v1", null);
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
    expect(mockedJournalSave).toHaveBeenCalledWith("2026-05-09", "x2", "v1", null);
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
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "bc", "v2", null);
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
      retrying: true,
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
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "held", null, null);
  });

  it("retains a pending save when the frontend vault changed and saves only after returning", async () => {
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
    expect(hasPendingSave()).toBe(true);
    expect((await flushPendingSave()).failedKeys).toEqual(["note:notes/a.md"]);
    useVaultStore.setState({ active: { root: "/old", name: "old", initialized: true } });
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "edit", null, "/old");
    expect(hasPendingSave()).toBe(false);
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
      null,
    );
  });

  it("a successful write records the version the backend returned", async () => {
    mockedWrite.mockResolvedValue({ meta: META, version: "sha-after" });
    useEditorStore.getState().openNote("notes/a.md", "a", "sha-before");
    useEditorStore.getState().setContent("a1");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "sha-before", null);
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
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "a1", "v1", null);
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
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "v1", null);
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

  it("a failed .local copy stays held and is retried until it lands", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedWrite.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    holdSave("note:notes/a.md");
    const result = await flushPendingSave({ leaving: true });
    expect(result).toEqual({ failedKeys: ["note:notes/a.md"], preserved: false });
    expect(isSaveHeld("note:notes/a.md")).toBe(true);
    expect(hasPendingSave()).toBe(true);
    expect(useEditorStore.getState().saveError).toEqual({
      key: "note:notes/a.md",
      message: "disk full",
      retrying: true,
    });
    // The editor moves on; the text survives only in the autosave queue.
    useEditorStore.getState().openNote("notes/b.md", "b", "v1");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockedWrite).toHaveBeenCalledTimes(2);
    const [relPath, content] = mockedWrite.mock.calls[1]!;
    expect(relPath).toMatch(/^notes\/a\.local-/);
    expect(content).toBe("a1");
    expect(isSaveHeld("note:notes/a.md")).toBe(false);
    expect(useEditorStore.getState().saveError).toBeNull();
    expect(useUIStore.getState().notice).toMatch(/kept as notes\/a\.local-/);
    expect(mockedWrite.mock.calls.some(([p]) => p === "notes/a.md")).toBe(false);
    errorSpy.mockRestore();
  });

  it("a persistently failing .local copy keeps the error and backs off", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedWrite.mockRejectedValue({ kind: "Io", message: "read-only" });
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    holdSave("note:notes/a.md");
    const result = await flushPendingSave({ leaving: true });
    expect(result.preserved).toBe(false);
    // 2s, 4s, 8s retries; then the next one is 16s away.
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000);
    expect(mockedWrite).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockedWrite).toHaveBeenCalledTimes(4);
    expect(mockedWrite.mock.calls.every(([p]) => /\.local-/.test(p))).toBe(true);
    expect(isSaveHeld("note:notes/a.md")).toBe(true);
    expect(useEditorStore.getState().saveError?.retrying).toBe(true);
    // A second leaving flush still reports the failure and doesn't hang.
    expect((await flushPendingSave({ leaving: true })).preserved).toBe(false);
    // Discarding (e.g. vault switch) means no retry is coming any more.
    discardPendingSave();
    expect(useEditorStore.getState().saveError).toEqual({
      key: "note:notes/a.md",
      message: "read-only",
      retrying: false,
    });
    errorSpy.mockRestore();
  });

  it("flushPendingSave reports keys whose ordinary write failed", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedWrite.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    expect(await flushPendingSave()).toEqual({
      failedKeys: ["note:notes/a.md"],
      preserved: true,
    });
    expect(await flushPendingSave()).toEqual({ failedKeys: [], preserved: true });
    errorSpy.mockRestore();
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
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "mine", "v4", null);
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
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "mine3", "v5", null);
  });

  it("discardPendingSave(key) forgets the key's hold too", () => {
    holdSave("note:notes/gone.md");
    discardPendingSave("note:notes/gone.md");
    expect(isSaveHeld("note:notes/gone.md")).toBe(false);
  });

  it("parks conflicting copies on a vault mismatch instead of reporting preservation", async () => {
    const a = { root: "/A", name: "A", initialized: true };
    useVaultStore.setState({ active: a });
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "A draft");
    holdSave("note:notes/a.md");
    useVaultStore.setState({ active: { root: "/B", name: "B", initialized: true } });
    const result = await flushPendingSave({ leaving: true });
    expect(result.preserved).toBe(false);
    expect(result.failedKeys).toContain("note:notes/a.md");
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(hasPendingSave()).toBe(true);
    useVaultStore.setState({ active: a });
    expect((await flushPendingSave({ leaving: true })).preserved).toBe(true);
    expect(mockedWrite).toHaveBeenCalledWith(expect.stringMatching(/\.local-/), "A draft", null, "/A");
  });

  it("captures saveNow's vault before waiting behind earlier writes", async () => {
    const first = deferred<NoteWriteResult>();
    useVaultStore.setState({ active: { root: "/A", name: "A", initialized: true } });
    mockedWrite.mockReturnValueOnce(first.promise);
    const earlier = saveNow({ kind: "note", relPath: "notes/first.md" }, "first", null);
    const later = saveNow({ kind: "note", relPath: "notes/second.md" }, "second", null);
    await vi.waitFor(() => expect(mockedWrite).toHaveBeenCalledTimes(1));
    useVaultStore.setState({ active: { root: "/B", name: "B", initialized: true } });
    first.resolve({ meta: META, version: "v2" });
    await Promise.all([earlier, later]);
    expect(mockedWrite).toHaveBeenNthCalledWith(2, "notes/second.md", "second", null, "/A");
  });

  it("keeps an in-flight draft visible to close/recovery protection after the editor closes", async () => {
    const writing = deferred<NoteWriteResult>();
    mockedWrite.mockReturnValueOnce(writing.promise);
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "draft");
    const flushing = flushPendingSave();
    await vi.waitFor(() => expect(mockedWrite).toHaveBeenCalled());
    expect(hasPendingSave()).toBe(true);
    writing.resolve({ meta: META, version: "v2" });
    await flushing;
    expect(hasPendingSave()).toBe(false);
  });

  it("reports a failure from a write already in flight when a recovery flush starts", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writing = deferred<NoteWriteResult>();
    mockedWrite.mockReturnValueOnce(writing.promise);
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "draft");
    const earlier = flushPendingSave();
    await vi.waitFor(() => expect(mockedWrite).toHaveBeenCalled());
    const recovering = flushPendingSave();
    writing.reject(new Error("vault changed"));
    await earlier;
    expect((await recovering).failedKeys).toEqual(["note:notes/a.md"]);
    expect(hasPendingSave()).toBe(true);
    resetAutosaveForTests();
    errorSpy.mockRestore();
  });
});
