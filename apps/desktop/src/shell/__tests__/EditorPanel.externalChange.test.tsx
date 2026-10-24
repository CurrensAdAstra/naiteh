import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the *real* CodeMirror view (like EditorPanel.realView.test.tsx) so
// the conflict resolutions operate on the live document exactly as in
// the app.

if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn(),
  notesRead: vi.fn(),
  notesVersion: vi.fn(),
}));
vi.mock("../../lib/api/journal", () => ({
  journalSave: vi.fn(),
  journalOpen: vi.fn(),
}));
vi.mock("../../lib/api/attachments", () => ({
  attachmentsImport: vi.fn(),
  attachmentsImportBytes: vi.fn(),
}));

import { journalSave } from "../../lib/api/journal";
import { notesRead, notesWrite } from "../../lib/api/notes";
import {
  flushPendingSave,
  holdSave,
  isSaveHeld,
  resetAutosaveForTests,
} from "../../state/autosave";
import { isDirty, useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { useVaultContentStore } from "../../state/vaultContentStore";
import { useVaultStore } from "../../state/vaultStore";
import { EditorPanel } from "../EditorPanel";

const mockedWrite = vi.mocked(notesWrite);
const mockedRead = vi.mocked(notesRead);
const mockedJournalSave = vi.mocked(journalSave);

const META = {
  path: "",
  relPath: "",
  title: "",
  tags: [],
  mtime: 0,
  size: 0,
  pinned: false,
};
const KEY = "note:notes/a.md";
const COPY_RE = /^notes\/a\.local-\d{8}-\d{6}\.md$/;

function view() {
  const v = useEditorStore.getState().view;
  if (v === null) throw new Error("no view mounted");
  return v;
}

function typeAtEnd(text: string) {
  act(() => {
    const v = view();
    const end = v.state.doc.length;
    v.dispatch({
      changes: { from: end, to: end, insert: text },
      selection: { anchor: end + text.length },
    });
  });
}

/** Open `notes/a.md` ("base", v1), type " local", and raise a conflict. */
function openInConflict(diskVersion = "v2") {
  act(() => useEditorStore.getState().openNote("notes/a.md", "base", "v1"));
  render(<EditorPanel />);
  typeAtEnd(" local");
  act(() => {
    holdSave(KEY);
    useEditorStore.getState().setExternalChange({ key: KEY, diskVersion });
  });
}

describe("EditorPanel changed-on-disk conflict", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedWrite.mockReset();
    mockedWrite.mockResolvedValue({ meta: META, version: "v3" });
    mockedRead.mockReset();
    mockedJournalSave.mockReset();
    useEditorStore.setState({
      open: null,
      view: null,
      saveError: null,
      externalChange: null,
    });
    useUIStore.setState({ editorMode: "edit", notice: null });
    useVaultContentStore.setState({ version: 0 });
    useVaultStore.setState({ active: { root: "/A", name: "A", initialized: true } });
  });

  afterEach(() => {
    resetAutosaveForTests();
  });

  it("a StaleWrite from autosave shows the banner and Ctrl+S no longer writes", async () => {
    mockedWrite.mockRejectedValueOnce({ kind: "StaleWrite", message: "v2" });
    act(() => useEditorStore.getState().openNote("notes/a.md", "base", "v1"));
    render(<EditorPanel />);
    typeAtEnd(" local");
    await act(async () => {
      await flushPendingSave();
    });
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "base local", "v1", "/A");
    const banner = screen.getByTestId("editor-external-change");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(/changed outside naiteh/);
    expect(banner).toHaveTextContent(/Google Drive sync/);
    expect(screen.getByTestId("editor-status")).toHaveTextContent(
      "● Changed on disk",
    );
    expect(screen.queryByTestId("editor-save-error")).not.toBeInTheDocument();
    // The edits stay in the editor, dirty.
    expect(view().state.doc.toString()).toBe("base local");
    expect(isDirty(useEditorStore.getState().open!)).toBe(true);

    mockedWrite.mockClear();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
      );
      await flushPendingSave();
    });
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-external-change")).toBeInTheDocument();
  });

  it("Load disk version discards local edits and shows the file from disk", async () => {
    openInConflict();
    mockedRead.mockResolvedValue({ content: "from drive", version: "v2" });
    await act(async () => {
      screen.getByTestId("external-change-load").click();
    });
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe("from drive"),
    );
    const open = useEditorStore.getState().open!;
    expect(open.savedVersion).toBe("v2");
    expect(isDirty(open)).toBe(false);
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(isSaveHeld(KEY)).toBe(false);
    expect(screen.queryByTestId("editor-external-change")).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-status")).toHaveTextContent("Saved");
    expect(mockedWrite).not.toHaveBeenCalled();

    // Autosave works again, against the new version.
    typeAtEnd("!");
    await act(async () => {
      await flushPendingSave();
    });
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "from drive!", "v2", "/A");
  });

  it("Keep mine overwrites the disk version conditionally and clears the conflict", async () => {
    openInConflict();
    await act(async () => {
      screen.getByTestId("external-change-keep").click();
    });
    await waitFor(() =>
      expect(screen.queryByTestId("editor-external-change")).not.toBeInTheDocument(),
    );
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "base local", "v2", "/A");
    const open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("base local");
    expect(open.savedVersion).toBe("v3");
    expect(isDirty(open)).toBe(false);
    expect(isSaveHeld(KEY)).toBe(false);
    expect(screen.getByTestId("editor-status")).toHaveTextContent("Saved");
  });

  it("Keep mine that hits StaleWrite again stays in conflict with the newer version", async () => {
    openInConflict();
    mockedWrite.mockRejectedValueOnce({ kind: "StaleWrite", message: "v4" });
    await act(async () => {
      screen.getByTestId("external-change-keep").click();
    });
    await waitFor(() =>
      expect(useEditorStore.getState().externalChange).toEqual({
        key: KEY,
        diskVersion: "v4",
      }),
    );
    expect(screen.getByTestId("editor-external-change")).toBeInTheDocument();
    expect(isSaveHeld(KEY)).toBe(true);
    expect(view().state.doc.toString()).toBe("base local");

    // Second attempt uses the newer version and succeeds.
    await act(async () => {
      screen.getByTestId("external-change-keep").click();
    });
    await waitFor(() =>
      expect(screen.queryByTestId("editor-external-change")).not.toBeInTheDocument(),
    );
    expect(mockedWrite).toHaveBeenLastCalledWith("notes/a.md", "base local", "v4", "/A");
    expect(useEditorStore.getState().open?.savedVersion).toBe("v3");
  });

  it("Save mine as copy writes a .local copy, then shows the disk version", async () => {
    openInConflict();
    mockedRead.mockResolvedValue({ content: "from drive", version: "v2" });
    await act(async () => {
      screen.getByTestId("external-change-copy").click();
    });
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe("from drive"),
    );
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [copyPath, copyContent, expected, root] = mockedWrite.mock.calls[0]!;
    expect(copyPath).toMatch(COPY_RE);
    expect(copyContent).toBe("base local");
    expect(expected).toBeNull();
    expect(root).toBe("/A");
    const open = useEditorStore.getState().open!;
    expect(open.key).toBe(KEY);
    expect(open.savedVersion).toBe("v2");
    expect(isDirty(open)).toBe(false);
    expect(useEditorStore.getState().externalChange).toBeNull();
    expect(isSaveHeld(KEY)).toBe(false);
    expect(useVaultContentStore.getState().version).toBe(1);
    expect(useUIStore.getState().notice).toMatch(/saved as notes\/a\.local-/);
  });

  it("a removed file: the banner says so and Re-save mine writes unconditionally", async () => {
    openInConflict("");
    const banner = screen.getByTestId("editor-external-change");
    expect(banner).toHaveTextContent(/deleted outside naiteh/);
    expect(screen.getByTestId("external-change-keep")).toHaveTextContent(
      "Re-save mine",
    );
    expect(screen.getByTestId("external-change-load")).toHaveTextContent(
      "Discard mine",
    );
    await act(async () => {
      screen.getByTestId("external-change-keep").click();
    });
    await waitFor(() =>
      expect(screen.queryByTestId("editor-external-change")).not.toBeInTheDocument(),
    );
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "base local", null, "/A");
    expect(useEditorStore.getState().open?.savedVersion).toBe("v3");
  });

  it("a removed file: Save mine as copy continues in the copy", async () => {
    openInConflict("");
    mockedRead.mockImplementation(async (relPath) => ({
      content: `copy of ${relPath}`,
      version: "vc",
    }));
    await act(async () => {
      screen.getByTestId("external-change-copy").click();
    });
    await waitFor(() =>
      expect(useEditorStore.getState().open?.key).toMatch(/^note:notes\/a\.local-/),
    );
    const [copyPath] = mockedWrite.mock.calls[0]!;
    expect(useEditorStore.getState().open?.source).toEqual({
      kind: "note",
      relPath: copyPath,
    });
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe(`copy of ${copyPath}`),
    );
    expect(isSaveHeld(KEY)).toBe(false);
  });

  it("a failed resolution keeps the conflict and reports the error", async () => {
    openInConflict();
    mockedWrite.mockRejectedValueOnce({ kind: "Io", message: "disk full" });
    await act(async () => {
      screen.getByTestId("external-change-copy").click();
    });
    expect(
      await screen.findByTestId("external-change-error"),
    ).toHaveTextContent(/disk full/);
    expect(screen.getByTestId("editor-external-change")).toBeInTheDocument();
    expect(isSaveHeld(KEY)).toBe(true);
    expect(view().state.doc.toString()).toBe("base local");
  });

  it("binds a conflict copy to A and ignores its late disk read after switching to B", async () => {
    let finishRead!: (doc: { content: string; version: string }) => void;
    mockedRead.mockReturnValue(new Promise((resolve) => { finishRead = resolve; }));
    openInConflict();
    await act(async () => screen.getByTestId("external-change-copy").click());
    await waitFor(() => expect(mockedRead).toHaveBeenCalled());
    expect(mockedWrite).toHaveBeenCalledWith(expect.stringMatching(COPY_RE), "base local", null, "/A");
    act(() => {
      useVaultStore.setState({ active: { root: "/B", name: "B", initialized: true } });
      useEditorStore.getState().openNote("notes/a.md", "B note", "b-version");
    });
    await act(async () => finishRead({ content: "A disk text", version: "a-version" }));
    expect(useEditorStore.getState().open).toMatchObject({ content: "B note", savedVersion: "b-version" });
  });
});
