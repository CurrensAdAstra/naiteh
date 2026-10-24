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
import type { NoteDocument } from "../types";
import { notesRead, notesWrite } from "../api/notes";
import {
  closeDocument,
  openDocument,
  reloadOpenDocument,
  targetForRelPath,
} from "../openDocument";
import {
  holdSave,
  isSaveHeld,
  resetAutosaveForTests,
  scheduleSave,
} from "../../state/autosave";
import { isDirty, useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";

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
    mockedWrite.mockResolvedValue({ meta: META, version: "v2" });
    mockedJournalOpen.mockReset();
    useEditorStore.setState({
      open: null,
      view: null,
      saveError: null,
      externalChange: null,
    });
  });

  it("opens a different document in view mode", async () => {
    useUIStore.setState({ editorMode: "edit" });
    mockedRead.mockResolvedValue({ content: "body", version: "v1" });
    await openDocument({ kind: "note", relPath: "notes/a.md" });
    expect(useUIStore.getState().editorMode).toBe("view");
  });

  it("keeps the mode when re-opening the same document", async () => {
    mockedRead.mockResolvedValue({ content: "body", version: "v1" });
    await openDocument({ kind: "note", relPath: "notes/a.md" });
    useUIStore.setState({ editorMode: "edit" });
    await openDocument({ kind: "note", relPath: "notes/a.md" });
    expect(useUIStore.getState().editorMode).toBe("edit");
  });

  it("opens straight into edit mode when asked (new notes)", async () => {
    useUIStore.setState({ editorMode: "view" });
    mockedRead.mockResolvedValue({ content: "", version: "v1" });
    await openDocument({ kind: "note", relPath: "notes/new.md" }, { edit: true });
    expect(useUIStore.getState().editorMode).toBe("edit");
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
    const a = deferred<NoteDocument>();
    const b = deferred<NoteDocument>();
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
    b.resolve({ content: "B body", version: "vb" });
    await expect(openB).resolves.toBe(true);
    a.resolve({ content: "A body", version: "va" });
    await expect(openA).resolves.toBe(false);
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
    expect(useEditorStore.getState().open?.content).toBe("B body");
  });

  it("flushes the previous note's pending edits to its own path before switching", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a-edited");
    scheduleSave({ kind: "note", relPath: "notes/a.md" }, "a-edited");
    const order: string[] = [];
    mockedWrite.mockImplementation(async (relPath) => {
      order.push(`write:${relPath}`);
      return { meta: META, version: "v2" };
    });
    mockedRead.mockImplementation(async (relPath) => {
      order.push(`read:${relPath}`);
      return { content: "B", version: "v1" };
    });

    await openDocument({ kind: "note", relPath: "notes/b.md" });

    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a-edited", "v1", null);
    expect(order).toEqual(["write:notes/a.md", "read:notes/b.md"]);
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
  });

  it("opens journal entries by date with the canonical relPath", async () => {
    mockedJournalOpen.mockResolvedValue({ path: "", content: "day", exists: true, version: "v1" });
    await openDocument({ kind: "journal", date: "2026-05-09" });
    expect(useEditorStore.getState().open?.source).toEqual({
      kind: "journal",
      date: "2026-05-09",
      relPath: "journal/2026/05/2026-05-09.md",
    });
  });

  it("reloadOpenDocument pushes fresh disk text without marking dirty", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    const rev = useEditorStore.getState().revision;
    mockedRead.mockResolvedValue({ content: "pulled", version: "v1" });
    await reloadOpenDocument();
    const open = useEditorStore.getState().open!;
    expect(open.content).toBe("pulled");
    expect(isDirty(open)).toBe(false);
    expect(useEditorStore.getState().revision).toBe(rev + 1);
  });

  it("reloadOpenDocument leaves newer local edits alone", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    useEditorStore.getState().setContent("typed during sync");
    mockedRead.mockResolvedValue({ content: "pulled", version: "v1" });
    await reloadOpenDocument();
    expect(mockedRead).not.toHaveBeenCalled();
    expect(useEditorStore.getState().open?.content).toBe("typed during sync");
  });

  it("reloadOpenDocument closes a note deleted by the pull", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old", "v1");
    mockedRead.mockRejectedValue({ kind: "NotFound", message: "notes/a.md" });
    await reloadOpenDocument();
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("closeDocument flushes by default, discards on request", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a1");
    await closeDocument();
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "a1", "v1", null);
    expect(useEditorStore.getState().open).toBeNull();

    mockedWrite.mockClear();
    useEditorStore.getState().openNote("notes/b.md", "b", "v1");
    useEditorStore.getState().setContent("b1");
    scheduleSave({ kind: "note", relPath: "notes/b.md" }, "b1");
    await closeDocument({ discard: true });
    expect(useEditorStore.getState().open).toBeNull();
    await new Promise((r) => setTimeout(r, 900));
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("records the version token read from disk", async () => {
    mockedRead.mockResolvedValue({ content: "body", version: "sha-a" });
    await openDocument({ kind: "note", relPath: "notes/a.md" });
    expect(useEditorStore.getState().open?.savedVersion).toBe("sha-a");

    mockedJournalOpen.mockResolvedValue({
      path: "",
      content: "",
      exists: false,
      version: "",
    });
    await openDocument({ kind: "journal", date: "2026-05-10" });
    expect(useEditorStore.getState().open?.savedVersion).toBe("");
  });

  it("reloadOpenDocument adopts the new version", async () => {
    useEditorStore.getState().openNote("notes/a.md", "old", "sha-1");
    mockedRead.mockResolvedValue({ content: "pulled", version: "sha-2" });
    await reloadOpenDocument();
    expect(useEditorStore.getState().open?.savedVersion).toBe("sha-2");
  });

  it("opening another document while in conflict keeps the held edits as a copy", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a local");
    holdSave("note:notes/a.md");
    useEditorStore
      .getState()
      .setExternalChange({ key: "note:notes/a.md", diskVersion: "v2" });
    mockedRead.mockResolvedValue({ content: "B", version: "vb" });
    await openDocument({ kind: "note", relPath: "notes/b.md" });
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite.mock.calls[0]![0]).toMatch(/^notes\/a\.local-/);
    expect(mockedWrite.mock.calls[0]![1]).toBe("a local");
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(isSaveHeld("note:notes/a.md")).toBe(false);
  });
});
