import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetAutosaveForTests } from "../../state/autosave";
import { useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { EditorPanel } from "../EditorPanel";

// Stub CodeMirror so jsdom doesn't have to render contenteditable + selection.
vi.mock("codemirror", () => {
  class MockEditorView {
    destroy = vi.fn();
    dispatch = vi.fn();
    requestMeasure = vi.fn();
    focus = vi.fn();
    static lineWrapping = { extension: null };
    static updateListener = { of: () => null };
  }
  return { EditorView: MockEditorView, basicSetup: [] };
});
vi.mock("@codemirror/lang-markdown", () => ({ markdown: () => null }));
vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: () => ({}),
    readOnly: { of: () => null },
  },
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
vi.mock("../../lib/api/attachments", () => ({
  attachmentsImport: vi.fn().mockResolvedValue({
    relPath: "attachments/screen-shot.png",
    fileName: "screen-shot.png",
    markdown: "![screen shot](attachments/screen-shot.png)",
  }),
}));

import { attachmentsImport } from "../../lib/api/attachments";
import { journalSave } from "../../lib/api/journal";
import { notesWrite } from "../../lib/api/notes";
import type { AppError } from "../../lib/types";
const mockedWrite = vi.mocked(notesWrite);
const mockedJournalSave = vi.mocked(journalSave);
const mockedAttachmentsImport = vi.mocked(attachmentsImport);

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
    resetAutosaveForTests();
    mockedWrite.mockClear();
    mockedJournalSave.mockClear();
    mockedAttachmentsImport.mockClear();
    mockedAttachmentsImport.mockResolvedValue({
      relPath: "attachments/screen-shot.png",
      fileName: "screen-shot.png",
      markdown: "![screen shot](attachments/screen-shot.png)",
    });
    useEditorStore.setState({ open: null, view: null });
    useUIStore.setState({ editorMode: "edit" });
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

  it("Edit toggle switches between the rendered view and the source editor", () => {
    useEditorStore.setState({
      open: noteOpen("notes/x.md", "# Title\n\nbody", "# Title\n\nbody"),
    });
    useUIStore.setState({ editorMode: "view" });
    render(<EditorPanel />);
    const button = screen.getByTestId("editor-mode-toggle");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveTextContent("Edit");
    expect(screen.getByTestId("markdown-viewer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByTestId("editor-source")).not.toBeVisible();

    act(() => {
      button.click();
    });
    expect(useUIStore.getState().editorMode).toBe("edit");
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("Done");
    expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument();
    expect(screen.getByTestId("editor-source")).toBeVisible();
    // Save status is shown in both modes.
    expect(screen.getByTestId("editor-status")).toHaveTextContent(/saved/i);
  });

  it("empty note in view mode offers to start writing", () => {
    useEditorStore.setState({ open: noteOpen("notes/x.md", "", "") });
    useUIStore.setState({ editorMode: "view" });
    render(<EditorPanel />);
    act(() => {
      screen.getByRole("button", { name: /start writing/i }).click();
    });
    expect(useUIStore.getState().editorMode).toBe("edit");
  });

  it("toggling a task in view mode edits the document and schedules a save", async () => {
    useEditorStore.setState({
      open: noteOpen("notes/x.md", "- [ ] buy milk\n", "- [ ] buy milk\n"),
    });
    useUIStore.setState({ editorMode: "view" });
    render(<EditorPanel />);
    act(() => {
      screen.getByRole("checkbox", { name: /mark task as done/i }).click();
    });
    expect(useEditorStore.getState().open?.content).toBe("- [x] buy milk\n");
    await waitFor(
      () => expect(mockedWrite).toHaveBeenCalledWith("notes/x.md", "- [x] buy milk\n"),
      { timeout: 2000 },
    );
  });

  it("imports an attachment and inserts its markdown", async () => {
    useEditorStore.setState({ open: noteOpen("notes/x.md", "body", "body") });
    render(<EditorPanel />);

    act(() => {
      screen.getByTestId("editor-attach-button").click();
    });

    await waitFor(() => {
      expect(useEditorStore.getState().open?.content).toBe(
        "body![screen shot](attachments/screen-shot.png)",
      );
    });
    expect(mockedAttachmentsImport).toHaveBeenCalledTimes(1);
  });

  it("does not show an error when attachment picking is cancelled", async () => {
    const cancelled: AppError = { kind: "Cancelled" };
    mockedAttachmentsImport.mockRejectedValueOnce(cancelled);
    useEditorStore.setState({ open: noteOpen("notes/x.md", "body", "body") });
    render(<EditorPanel />);

    act(() => {
      screen.getByTestId("editor-attach-button").click();
    });

    await waitFor(() => {
      expect(mockedAttachmentsImport).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables attachment insertion in view mode", () => {
    useEditorStore.setState({ open: noteOpen("notes/x.md", "body", "body") });
    useUIStore.setState({ editorMode: "view" });
    render(<EditorPanel />);

    expect(screen.getByTestId("editor-attach-button")).toBeDisabled();
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
