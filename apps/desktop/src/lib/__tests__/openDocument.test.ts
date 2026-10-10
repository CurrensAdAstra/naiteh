import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/notes", () => ({
  notesRead: vi.fn(),
  notesWrite: vi.fn(),
}));
vi.mock("../api/journal", () => ({
  journalOpen: vi.fn(),
  journalSave: vi.fn(),
}));

import { journalOpen } from "../api/journal";
import { notesRead, notesWrite } from "../api/notes";
import {
  closeDocument,
  openDocument,
  reloadOpenDocument,
  targetForRelPath,
} from "../openDocument";
import { resetAutosaveForTests, scheduleSave } from "../../state/autosave";
import { isDirty, useEditorStore } from "../../state/editorStore";

const mockedRead = vi.mocked(notesRead);
const mockedWrite = vi.mocked(notesWrite);
const mockedJournalOpen = vi.mocked(journalOpen);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const META = {
  path: "",
  relPath: "",
  title: "",
  tags: [],
  mtime: 0,
  size: 0,
  pinned: false,
};

describe("openDocument", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedRead.mockReset();
    mockedWrite.mockReset();
    mockedWrite.mockResolvedValue(META);
    mockedJournalOpen.mockReset();
    useEditorStore.setState({ open: null, view: null, saveError: null });
  });

  it("classifies canonical journal paths", () => {
    expect(targetForRelPath("journal/2026/05/2026-05-09.md")).toEqual({
      kind: "journal",
      date: "2026-05-09",
    });
    expect(targetForRelPath("journal/draft.md")).toEqual({
      kind: "note",
      relPath: "journal/draft.md",
    });
    // Folder doesn't match the date → not the canonical location.
    expect(targetForRelPath("journal/2026/04/2026-05-09.md")).toEqual({
      kind: "note",
      relPath: "journal/2026/04/2026-05-09.md",
    });
  });

  it("only the latest of overlapping opens wins (A then B, A resolves last)", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    mockedRead.mockImplementation((relPath) =>
      relPath === "notes/a.md" ? a.promise : b.promise,
    );
    const openA = openDocument({ kind: "note", relPath: "notes/a.md" });
    await vi.waitFor(() =>
      expect(mockedRead).toHaveBeenCalledWith("notes/a.md"),
    );
    const openB = openDocument({ kind: "note", relPath: "notes/b.md" });
    await vi.waitFor(() =>
      expect(mockedRead).toHaveBeenCalledWith("notes/b.md"),
    );
    b.resolve("B body");
    await expect(openB).resolves.toBe(true);
    a.resolve("A body");
    await expect(openA).resolves.toBe(false);
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
    expect(useEditorStore.getState().open?.content).toBe("B body");
  });

  it("flushes the previous note's pending edits to its own path before switching", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("a-edited");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a-edited");
    const order: string[] = [];
    mockedWrite.mockImplementation(async (relPath) => {
      order.push(`write:${relPath}`);
      return META;
    });
    mockedRead.mockImplementation(async (relPath) => {
      order.push(`read:${relPath}`);
      return "B";
    });

    await openDocument({ kind: "note", relPath: "notes/b.md" });

    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a-edited");
    expect(order).toEqual(["write:notes/a.md", "read:notes/b.md"]);
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
  });

  it("opens journal entries by date with the canonical relPath", async () => {
    mockedJournalOpen.mockResolvedValue({ path: "", content: "day", exists: true });
    await openDocument({ kind: "journal", date: "2026-05-09" });
    expect(useEditorStore.getState().open?.source).toEqual({
      kind: "journal",
      date: "2026-05-09",
      relPath: "journal/2026/05/2026-05-09.md",
    });
  });

  it("reloadOpenDocument pushes fresh disk text without marking dirty", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old");
    const rev = useEditorStore.getState().revision;
    mockedRead.mockResolvedValue("pulled");
    await reloadOpenDocument();
    const open = useEditorStore.getState().open!;
    expect(open.content).toBe("pulled");
    expect(isDirty(open)).toBe(false);
    expect(useEditorStore.getState().revision).toBe(rev + 1);
  });

  it("reloadOpenDocument leaves newer local edits alone", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old");
    useEditorStore.getState().setContent("typed during sync");
    mockedRead.mockResolvedValue("pulled");
    await reloadOpenDocument();
    expect(mockedRead).not.toHaveBeenCalled();
    expect(useEditorStore.getState().open?.content).toBe("typed during sync");
  });

  it("reloadOpenDocument closes a note deleted by the pull", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old");
    mockedRead.mockRejectedValue({ kind: "NotFound", message: "notes/a.md" });
    await reloadOpenDocument();
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("closeDocument flushes by default, discards on request", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a");
    useEditorStore.getState().setContent("a1");
    await closeDocument();
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1");
    expect(useEditorStore.getState().open).toBeNull();

    mockedWrite.mockClear();
    useEditorStore.getState().openNote("notes/b.md", "b");
    useEditorStore.getState().setContent("b1");
    scheduleSave({ kind: "note", relPath: "notes/b.md" }, "b1");
    await closeDocument({ discard: true });
    expect(useEditorStore.getState().open).toBeNull();
    await new Promise((r) => setTimeout(r, 900));
    expect(mockedWrite).not.toHaveBeenCalled();
  });
});
