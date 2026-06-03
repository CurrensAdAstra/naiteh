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
  notesDelete: vi.fn(),
  notesRename: vi.fn(),
  notesListDirs: vi.fn(),
  notesCreateDir: vi.fn(),
  notesDeleteDir: vi.fn(),
  notesRenameDir: vi.fn(),
}));

import {
  notesCreate,
  notesCreateDir,
  notesDelete,
  notesDeleteDir,
  notesList,
  notesListDirs,
  notesRead,
  notesRename,
  notesRenameDir,
} from "../../../lib/api/notes";

const mockedList = vi.mocked(notesList);
const mockedRead = vi.mocked(notesRead);
const mockedCreate = vi.mocked(notesCreate);
const mockedDelete = vi.mocked(notesDelete);
const mockedRename = vi.mocked(notesRename);
const mockedListDirs = vi.mocked(notesListDirs);
const mockedCreateDir = vi.mocked(notesCreateDir);
const mockedDeleteDir = vi.mocked(notesDeleteDir);
const mockedRenameDir = vi.mocked(notesRenameDir);

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
    mockedDelete.mockReset();
    mockedRename.mockReset();
    mockedListDirs.mockReset();
    mockedListDirs.mockResolvedValue([]);
    mockedCreateDir.mockReset();
    mockedCreateDir.mockResolvedValue(undefined);
    mockedDeleteDir.mockReset();
    mockedDeleteDir.mockResolvedValue(undefined);
    mockedRenameDir.mockReset();
    mockedRenameDir.mockResolvedValue(undefined);
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
      const open = useEditorStore.getState().open;
      expect(open).not.toBeNull();
      expect(open!.source).toEqual({
        kind: "note",
        relPath: "notes/loose.md",
      });
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
      open: {
        source: { kind: "note", relPath: "notes/loose.md" },
        key: "note:notes/loose.md",
        content: "x",
        savedContent: "x",
      },
    });
    render(<NotesListPanel />);
    const row = await screen.findByTestId("notes-file-notes/loose.md");
    expect(row.className).toMatch(/rowActive/);
  });

  it("surfaces backend errors", async () => {
    mockedList.mockRejectedValue({ kind: "NotFound", message: "no vault" });
    render(<NotesListPanel />);
    expect(
      await within(screen.getByTestId("list-panel-notes")).findByText(/no vault/i),
    ).toBeInTheDocument();
  });

  it("rename action calls notesRename with the prompted filename", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    mockedRename.mockResolvedValue(note("notes/renamed.md", "Renamed"));
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("renamed");
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-rename-notes/loose.md"),
    );
    await waitFor(() =>
      expect(mockedRename).toHaveBeenCalledWith(
        "notes/loose.md",
        "notes/renamed.md",
      ),
    );
    promptSpy.mockRestore();
  });

  it("rename appends .md when missing and stays in the same folder", async () => {
    mockedList.mockResolvedValue([note("notes/work/standup.md", "Standup")]);
    mockedRename.mockResolvedValue(
      note("notes/work/morning.md", "Morning"),
    );
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("morning");
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-rename-notes/work/standup.md"),
    );
    await waitFor(() =>
      expect(mockedRename).toHaveBeenCalledWith(
        "notes/work/standup.md",
        "notes/work/morning.md",
      ),
    );
    promptSpy.mockRestore();
  });

  it("rename is a no-op when the prompt is cancelled or unchanged", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-rename-notes/loose.md"),
    );
    expect(mockedRename).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("delete action calls notesDelete after confirm and clears the editor when the open note is deleted", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    mockedDelete.mockResolvedValue(undefined);
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/loose.md" },
        key: "note:notes/loose.md",
        content: "x",
        savedContent: "x",
      },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-delete-notes/loose.md"),
    );
    await waitFor(() => {
      expect(mockedDelete).toHaveBeenCalledWith("notes/loose.md");
      expect(useEditorStore.getState().open).toBeNull();
    });
    confirmSpy.mockRestore();
  });

  it("delete is a no-op when the confirm prompt is cancelled", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-delete-notes/loose.md"),
    );
    expect(mockedDelete).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  // ── folders ──────────────────────────────────────────────────────────

  it("shows an empty folder from notes_list_dirs", async () => {
    mockedList.mockResolvedValue([]);
    mockedListDirs.mockResolvedValue(["notes/work"]);
    render(<NotesListPanel />);
    expect(
      await screen.findByTestId("notes-folder-notes/work"),
    ).toBeInTheDocument();
  });

  it("New folder button creates a folder under notes/", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Projects");
    mockedList.mockResolvedValue([]);
    mockedListDirs.mockResolvedValueOnce([]).mockResolvedValueOnce([
      "notes/Projects",
    ]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText(/no notes yet/i);
    await user.click(screen.getByTestId("notes-new-folder"));
    await waitFor(() => {
      expect(mockedCreateDir).toHaveBeenCalledWith("notes/Projects");
    });
    promptSpy.mockRestore();
  });

  it("deletes a folder after confirm", async () => {
    mockedList.mockResolvedValue([]);
    mockedListDirs.mockResolvedValue(["notes/work"]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-folder-delete-notes/work"),
    );
    await waitFor(() => {
      expect(mockedDeleteDir).toHaveBeenCalledWith("notes/work");
    });
    confirmSpy.mockRestore();
  });

  it("renames a folder, keeping it in the same parent", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("office");
    mockedList.mockResolvedValue([]);
    mockedListDirs.mockResolvedValue(["notes/work"]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-folder-rename-notes/work"),
    );
    await waitFor(() => {
      expect(mockedRenameDir).toHaveBeenCalledWith("notes/work", "notes/office");
    });
    promptSpy.mockRestore();
  });
});
