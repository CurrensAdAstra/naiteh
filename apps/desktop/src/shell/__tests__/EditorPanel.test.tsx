import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../../state/editorStore";
import { EditorPanel } from "../EditorPanel";

// Stub CodeMirror so jsdom doesn't have to render contenteditable + selection.
vi.mock("codemirror", () => {
  class MockEditorView {
    destroy = vi.fn();
    static lineWrapping = { extension: null };
    static updateListener = { of: () => null };
  }
  return { EditorView: MockEditorView, basicSetup: [] };
});
vi.mock("@codemirror/lang-markdown", () => ({ markdown: () => null }));
vi.mock("@codemirror/state", () => ({
  EditorState: { create: () => ({}) },
}));

vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn().mockResolvedValue({}),
}));

import { notesWrite } from "../../lib/api/notes";
const mockedWrite = vi.mocked(notesWrite);

describe("EditorPanel", () => {
  beforeEach(() => {
    mockedWrite.mockClear();
    useEditorStore.setState({ open: null });
  });

  it("shows the empty state when no note is open", () => {
    render(<EditorPanel />);
    expect(screen.getByText(/no note open/i)).toBeInTheDocument();
  });

  it("renders the toolbar with rel path when a note is open", () => {
    useEditorStore.setState({
      open: {
        relPath: "notes/work/standup.md",
        content: "hello",
        savedContent: "hello",
      },
    });
    render(<EditorPanel />);
    expect(screen.getByText("notes/work/standup.md")).toBeInTheDocument();
    expect(screen.getByTestId("editor-status")).toHaveTextContent(/saved/i);
  });

  it("flips to the dirty status when content drifts from disk", () => {
    useEditorStore.setState({
      open: {
        relPath: "notes/x.md",
        content: "a",
        savedContent: "a",
      },
    });
    render(<EditorPanel />);
    act(() => {
      useEditorStore.getState().setContent("a-modified");
    });
    expect(screen.getByTestId("editor-status")).toHaveTextContent(/unsaved/i);
  });

  it(
    "autosaves after the debounce window and marks the note saved",
    async () => {
      useEditorStore.setState({
        open: {
          relPath: "notes/x.md",
          content: "a",
          savedContent: "a",
        },
      });
      render(<EditorPanel />);
      act(() => {
        useEditorStore.getState().setContent("dirty");
      });
      await waitFor(
        () => {
          expect(mockedWrite).toHaveBeenCalledWith("notes/x.md", "dirty");
        },
        { timeout: 1500 },
      );
      await waitFor(() => {
        expect(useEditorStore.getState().open?.savedContent).toBe("dirty");
      });
    },
    2000,
  );

  it("Cmd+S triggers an immediate save", async () => {
    useEditorStore.setState({
      open: {
        relPath: "notes/x.md",
        content: "fresh",
        savedContent: "old",
      },
    });
    render(<EditorPanel />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true }),
    );
    await waitFor(() => {
      expect(mockedWrite).toHaveBeenCalledWith("notes/x.md", "fresh");
    });
  });
});
