import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unlike EditorPanel.test.tsx this suite runs the *real* CodeMirror view,
// so dispatches fire the updateListener synchronously exactly as in the
// app (the behaviour that fake views hid).

// jsdom has no layout: give Range the measuring methods CodeMirror calls
// when scrolling the cursor into view, so it doesn't log TypeErrors.
if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = () =>
    [] as unknown as DOMRectList;
}
if (typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn(),
  notesRead: vi.fn(),
}));
vi.mock("../../lib/api/journal", () => ({
  journalSave: vi.fn(),
  journalOpen: vi.fn(),
}));
vi.mock("../../lib/api/attachments", () => ({
  attachmentsImport: vi.fn(),
  attachmentsImportBytes: vi.fn(),
}));

import { attachmentsImport } from "../../lib/api/attachments";
import { notesRead, notesWrite } from "../../lib/api/notes";
import { openDocument, reloadOpenDocument } from "../../lib/openDocument";
import { flushPendingSave, resetAutosaveForTests } from "../../state/autosave";
import { isDirty, useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { EditorPanel } from "../EditorPanel";

const mockedWrite = vi.mocked(notesWrite);
const mockedRead = vi.mocked(notesRead);
const mockedAttachmentsImport = vi.mocked(attachmentsImport);

const META = {
  path: "",
  relPath: "",
  title: "",
  tags: [],
  mtime: 0,
  size: 0,
  pinned: false,
};

function view() {
  const v = useEditorStore.getState().view;
  if (v === null) throw new Error("no view mounted");
  return v;
}

/** Simulate the user typing `text` at the end of the document. */
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

describe("EditorPanel with a real CodeMirror view", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedWrite.mockReset();
    mockedWrite.mockResolvedValue(META);
    mockedRead.mockReset();
    mockedAttachmentsImport.mockReset();
    useEditorStore.setState({ open: null, view: null, saveError: null });
    useUIStore.setState({ editorReadOnly: false });
  });

  afterEach(() => {
    resetAutosaveForTests();
  });

  it("typing mirrors into the store; the attach button inserts exactly once", async () => {
    mockedAttachmentsImport.mockResolvedValue({
      relPath: "attachments/a.png",
      fileName: "a.png",
      markdown: "![a](attachments/a.png)",
    });
    act(() => useEditorStore.getState().openNote("notes/x.md", "body"));
    render(<EditorPanel />);
    typeAtEnd("!");
    expect(useEditorStore.getState().open?.content).toBe("body!");

    act(() => screen.getByTestId("editor-attach-button").click());
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe("body!![a](attachments/a.png)"),
    );
    expect(useEditorStore.getState().open?.content).toBe(
      "body!![a](attachments/a.png)",
    );
  });

  it("switching notes with a pending debounce writes the edits to the original path", async () => {
    act(() => useEditorStore.getState().openNote("notes/a.md", "A"));
    render(<EditorPanel />);
    typeAtEnd(" edited");
    // Debounce (800ms) has not fired yet.
    expect(mockedWrite).not.toHaveBeenCalled();

    mockedRead.mockResolvedValue("B body");
    await act(async () => {
      await openDocument({ kind: "note", relPath: "notes/b.md" });
    });

    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "A edited");
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
    await waitFor(() => expect(view().state.doc.toString()).toBe("B body"));
  });

  it("re-opening the same path reloads the view with disk text", async () => {
    act(() => useEditorStore.getState().openNote("notes/a.md", "v1"));
    render(<EditorPanel />);
    mockedRead.mockResolvedValue("v2 from disk");
    await act(async () => {
      await openDocument({ kind: "note", relPath: "notes/a.md" });
    });
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe("v2 from disk"),
    );
  });

  it("an external reload (after sync) updates the view and the next edit never writes old text", async () => {
    act(() => useEditorStore.getState().openNote("notes/a.md", "old text"));
    render(<EditorPanel />);

    mockedRead.mockResolvedValue("pulled text");
    await act(async () => {
      await reloadOpenDocument();
    });
    await waitFor(() =>
      expect(view().state.doc.toString()).toBe("pulled text"),
    );
    expect(isDirty(useEditorStore.getState().open!)).toBe(false);

    typeAtEnd("!");
    await act(async () => {
      await flushPendingSave();
    });
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledWith("notes/a.md", "pulled text!");
  });

  it("a remount while dirty shows the current (unsaved) content", () => {
    act(() => useEditorStore.getState().openNote("notes/a.md", "saved"));
    act(() => useEditorStore.getState().setContent("unsaved edit"));
    render(<EditorPanel />);
    expect(view().state.doc.toString()).toBe("unsaved edit");
  });

  it("surfaces an autosave failure and keeps the note dirty", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedWrite.mockRejectedValue({ kind: "Io", message: "disk full" });
    act(() => useEditorStore.getState().openNote("notes/a.md", "a"));
    render(<EditorPanel />);
    typeAtEnd("b");
    await act(async () => {
      await flushPendingSave();
    });
    expect(screen.getByTestId("editor-save-error")).toHaveTextContent(
      /disk full/,
    );
    expect(screen.getByTestId("editor-status")).toHaveTextContent(
      /save failed/i,
    );
    expect(isDirty(useEditorStore.getState().open!)).toBe(true);
    errorSpy.mockRestore();
  });
});
