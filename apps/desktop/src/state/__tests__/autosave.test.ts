import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn(),
}));
vi.mock("../../lib/api/journal", () => ({
  journalSave: vi.fn(),
}));

import { journalSave } from "../../lib/api/journal";
import { notesWrite } from "../../lib/api/notes";
import {
  AUTOSAVE_DELAY_MS,
  discardPendingSave,
  flushPendingSave,
  onSaved,
  resetAutosaveForTests,
  scheduleSave,
  suspendAutosave,
} from "../autosave";
import { isDirty, useEditorStore } from "../editorStore";
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
    mockedWrite.mockResolvedValue(META);
    mockedJournalSave.mockReset();
    mockedJournalSave.mockResolvedValue({ path: "", mtime: 0 });
    useEditorStore.setState({ open: null, view: null, saveError: null });
    useVaultStore.setState({ active: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes after the debounce window", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("a1");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1");
    expect(mockedWrite).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1");
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);
  });

  it("a pending save still targets the original note after switching", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("a-edited");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a-edited");
    // The user opens B before the debounce fires.
    useEditorStore.getState().openNote("notes/b.md", "b");
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a-edited");
    // B is untouched.
    expect(useEditorStore.getState().open?.content).toBe("b");
    expect(useEditorStore.getState().open?.savedContent).toBe("b");
  });

  it("flushPendingSave writes immediately and cancels the timer", async () => {
    vi.useFakeTimers();
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("a1");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a1");
    await flushPendingSave();
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
  });

  it("flushPendingSave saves a dirty open document even if nothing was scheduled", async () => {
    useEditorStore.getState().openJournal(
      "2026-05-09",
      "journal/2026/05/2026-05-09.md",
      "x",
    );
    useEditorStore.getState().setContent("x2");
    await flushPendingSave();
    expect(mockedJournalSave).toHaveBeenCalledWith("2026-05-09", "x2");
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);
  });

  it("typing during an in-flight save keeps the note dirty and saves again", async () => {
    const first = deferred<typeof META>();
    mockedWrite.mockReturnValueOnce(first.promise);
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("b");
    const flushing = flushPendingSave();
    // Write of "b" is in flight; the user keeps typing.
    useEditorStore.getState().setContent("bc");
    first.resolve(META);
    await flushing;
    let open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("b");
    expect(isDirty(open)).toBe(true);

    await flushPendingSave();
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "bc");
    open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("bc");
    expect(isDirty(open)).toBe(false);
  });

  it("a failed save is surfaced, keeps the note dirty, and is retried", async () => {
    vi.useFakeTimers();
    mockedWrite.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    useEditorStore.getState().openNote("notes/a.md", "a");
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
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "held");
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
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("a1");
    await flushPendingSave();
    expect(listener).toHaveBeenCalledWith(
      { kind: "note", relPath: "notes/a.md" },
      "a1",
    );
    off();
  });
});
