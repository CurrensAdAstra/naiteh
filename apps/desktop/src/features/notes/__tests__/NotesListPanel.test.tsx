import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteMeta } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { NotesListPanel } from "../NotesListPanel";

vi.mock("../../../lib/api/notes", () => ({
  notesList: vi.fn(),
  notesRead: vi.fn(),
  notesCreate: vi.fn(),
}));

import { notesCreate, notesList, notesRead } from "../../../lib/api/notes";

const mockedList = vi.mocked(notesList);
const mockedRead = vi.mocked(notesRead);
const mockedCreate = vi.mocked(notesCreate);

function note(relPath: string, title: string): NoteMeta {
  return {
    path: `/v/${relPath}`,
    relPath,
    title,
    tags: [],
    mtime: 0,
    size: 0,
    pinned: false,
  };
}

describe("NotesListPanel", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedRead.mockReset();
    mockedCreate.mockReset();
    useEditorStore.setState({ open: null });
  });

  it("renders the empty state when the vault has no notes", async () => {
    mockedList.mockResolvedValue([]);
    render(<NotesListPanel />);
    expect(
      await screen.findByText(/no notes yet/i),
    ).toBeInTheDocument();
  });

  it("renders folder hierarchy and files", async () => {
    mockedList.mockResolvedValue([
      note("notes/work/standup.md", "Standup"),
      note("notes/personal/idea.md", "Idea"),
      note("notes/loose.md", "Loose"),
    ]);
    render(<NotesListPanel />);
    expect(await screen.findByText("Standup")).toBeInTheDocument();
    expect(screen.getByText("Idea")).toBeInTheDocument();
    expect(screen.getByText("Loose")).toBeInTheDocument();
    // Folder labels
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("personal")).toBeInTheDocument();
  });

  it("loads file content and updates editorStore on click", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    mockedRead.mockResolvedValue("hello body");
    const user = userEvent.setup();
    render(<NotesListPanel />);
    const fileButton = await screen.findByTestId("notes-file-notes/loose.md");
    await user.click(fileButton);
    await waitFor(() => {
      expect(useEditorStore.getState().open?.relPath).toBe("notes/loose.md");
    });
    expect(useEditorStore.getState().open?.content).toBe("hello body");
  });

  it("creates a note via prompt and refreshes", async () => {
    const promptSpy = vi
      .spyOn(window, "prompt")
      .mockReturnValue("My New Note");
    const created = note("notes/my-new-note.md", "My New Note");
    mockedList.mockResolvedValueOnce([]);
    mockedList.mockResolvedValueOnce([created]);
    mockedCreate.mockResolvedValue(created);
    mockedRead.mockResolvedValue("---\ntitle: My New Note\n---\n");

    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText(/no notes yet/i);
    await user.click(screen.getByRole("button", { name: /new note/i }));

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith("notes", "My New Note");
    });
    expect(mockedList).toHaveBeenCalledTimes(2);
    promptSpy.mockRestore();
  });

  it("does nothing when the title prompt is cancelled", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    mockedList.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText(/no notes yet/i);
    await user.click(screen.getByRole("button", { name: /new note/i }));
    expect(mockedCreate).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("highlights the currently open note", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    useEditorStore.setState({
      open: { relPath: "notes/loose.md", content: "x", savedContent: "x" },
    });
    render(<NotesListPanel />);
    const row = await screen.findByTestId("notes-file-notes/loose.md");
    // active class is the second token in className
    expect(row.className).toMatch(/rowActive/);
  });

  it("surfaces backend errors", async () => {
    mockedList.mockRejectedValue({ kind: "NotFound", message: "no vault" });
    render(<NotesListPanel />);
    expect(
      await within(screen.getByTestId("list-panel-notes")).findByText(/no vault/i),
    ).toBeInTheDocument();
  });
});
