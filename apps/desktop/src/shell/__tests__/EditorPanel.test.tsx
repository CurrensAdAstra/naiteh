import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEditorStore } from "../../state/editorStore";
import { EditorPanel } from "../EditorPanel";

// Stub CodeMirror so jsdom doesn't have to render contenteditable + selection.
vi.mock("codemirror", () => {
  class MockEditorView {
    destroy = vi.fn();
    dispatch = vi.fn();
    static lineWrapping = { extension: null };
    static updateListener = { of: () => null };
  }
  return { EditorView: MockEditorView, basicSetup: [] };
});
vi.mock("@codemirror/lang-markdown", () => ({ markdown: () => null }));
vi.mock("@codemirror/state", () => ({
  EditorState: { create: () => ({}) },
  Compartment: class {
    of() {
      return null;
    }
    reconfigure() {
      return null;
    }
  },
}));

vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../lib/api/journal", () => ({
  journalSave: vi.fn().mockResolvedValue({}),
}));

import { journalSave } from "../../lib/api/journal";
import { notesWrite } from "../../lib/api/notes";
const mockedWrite = vi.mocked(notesWrite);
const mockedJournalSave = vi.mocked(journalSave);

function noteOpen(relPath: string, content: string, saved: string) {
  return {
    source: { kind: "note" as const, relPath },
    key: `note:${relPath}`,
    content,
    savedContent: saved,
  };
}

function journalOpen(date: string, content: string, saved: string) {
  return {
    source: {
      kind: "journal" as const,
      date,
      relPath: `journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`,
    },
    key: `journal:${date}`,
    content,
    savedContent: saved,
  };
}

describe("EditorPanel", () => {
  beforeEach(() => {
    mockedWrite.mockClear();
    mockedJournalSave.mockClear();
    useEditorStore.setState({ open: null });
  });

  it("shows the empty state when no note is open", () => {
    render(<EditorPanel />);
    expect(screen.getByText(/no note open/i)).toBeInTheDocument();
  });

  it("renders the toolbar with rel path when a note is open", () => {
    useEditorStore.setState({
      open: noteOpen("notes/work/standup.md", "hello", "hello"),
    });
    render(<EditorPanel />);
    expect(screen.getByText("notes/work/standup.md")).toBeInTheDocument();
    expect(screen.getByTestId("editor-status")).toHaveTextContent(/saved/i);
  });

  it("renders a journal-flavored toolbar when a journal entry is open", () => {
    useEditorStore.setState({ open: journalOpen("2026-05-09", "x", "x") });
    render(<EditorPanel />);
    expect(screen.getByText(/journal · 2026-05-09/i)).toBeInTheDocument();
  });

  it("Pin toggle reflects current front-matter and flips it on click", async () => {
    useEditorStore.setState({
      open: noteOpen("notes/x.md", "body without front matter", "body without front matter"),
    });
    render(<EditorPanel />);
    const button = screen.getByTestId("editor-pin-toggle");
    expect(button).toHaveAttribute("aria-pressed", "false");

    act(() => {
      button.click();
    });
    // The handler updates editor content via the (mocked) view; with no
    // real view dispatch we fall through to the store-direct path so the
    // store reflects the new content.
    await waitFor(() => {
      const open = useEditorStore.getState().open!;
      expect(open.content).toMatch(/pinned: true/);
    });
  });

  it("Pin toggle starts pressed when content already has pinned: true", () => {
    useEditorStore.setState({
      open: noteOpen(
        "notes/x.md",
        "---\npinned: true\n---\nbody",
        "---\npinned: true\n---\nbody",
      ),
    });
    render(<EditorPanel />);
    expect(screen.getByTestId("editor-pin-toggle")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("flips to the dirty status when content drifts from disk", () => {
    useEditorStore.setState({ open: noteOpen("notes/x.md", "a", "a") });
    render(<EditorPanel />);
    act(() => {
      useEditorStore.getState().setContent("a-modified");
    });
    expect(screen.getByTestId("editor-status")).toHaveTextContent(/unsaved/i);
  });

  it(
    "autosaves a note via notesWrite after the debounce window",
    async () => {
      useEditorStore.setState({ open: noteOpen("notes/x.md", "a", "a") });
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
      expect(mockedJournalSave).not.toHaveBeenCalled();
    },
    2000,
  );

  it(
    "autosaves a journal entry via journalSave after the debounce window",
    async () => {
      useEditorStore.setState({ open: journalOpen("2026-05-09", "a", "a") });
      render(<EditorPanel />);
      act(() => {
        useEditorStore.getState().setContent("dirty");
      });
      await waitFor(
        () => {
          expect(mockedJournalSave).toHaveBeenCalledWith(
            "2026-05-09",
            "dirty",
          );
        },
        { timeout: 1500 },
      );
      expect(mockedWrite).not.toHaveBeenCalled();
    },
    2000,
  );

  it("Cmd+S triggers an immediate save dispatched by source kind", async () => {
    useEditorStore.setState({ open: noteOpen("notes/x.md", "fresh", "old") });
    render(<EditorPanel />);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true }),
    );
    await waitFor(() => {
      expect(mockedWrite).toHaveBeenCalledWith("notes/x.md", "fresh");
    });
  });
});
