import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteDocument, NoteMeta } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { useUIStore } from "../../../state/uiStore";
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
  notesWrite: vi.fn(),
}));

import {
  resetAutosaveForTests,
  scheduleSave,
} from "../../../state/autosave";
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
  notesWrite,
} from "../../../lib/api/notes";

const mockedWrite = vi.mocked(notesWrite);
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function openNoteState(relPath: string, content: string, saved: string) {
  useEditorStore.setState({
    open: {
      source: { kind: "note", relPath },
      key: `note:${relPath}`,
      content,
      savedContent: saved,
      savedVersion: "v1",
    },
  });
}

describe("NotesListPanel", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedWrite.mockReset();
    mockedWrite.mockImplementation(async (relPath) => ({
      meta: note(relPath, "x"),
      version: "v2",
    }));
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
    useUIStore.setState({ pendingAction: null, editorMode: "view" });
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
    mockedRead.mockResolvedValue({ content: "hello body", version: "v1" });
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

  it("creates a note from the dialog and opens it ready to edit", async () => {
    const created = note("notes/my-new-note.md", "My New Note");
    mockedList.mockResolvedValueOnce([]);
    mockedList.mockResolvedValueOnce([created]);
    mockedCreate.mockResolvedValue(created);
    mockedRead.mockResolvedValue({ content: "---\ntitle: My New Note\n---\n", version: "v1" });

    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText(/no notes yet/i);
    await user.click(screen.getByRole("button", { name: /new note/i }));
    const dialog = screen.getByRole("dialog", { name: "New note" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByLabelText("Note title")).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Create note" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Note title"), " My New Note {Enter}");

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith("notes", "My New Note");
      expect(useEditorStore.getState().open?.source).toEqual({
        kind: "note",
        relPath: "notes/my-new-note.md",
      });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useUIStore.getState().editorMode).toBe("edit");
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it("cancels the new-note dialog and returns focus to its button", async () => {
    mockedList.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText(/no notes yet/i);
    const trigger = screen.getByRole("button", { name: /new note/i });
    await user.click(trigger);
    await user.type(screen.getByLabelText("Note title"), "Discard this title");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps the title and shows creation errors inside the dialog for retry", async () => {
    mockedList.mockResolvedValue([]);
    mockedCreate.mockRejectedValueOnce({ kind: "Io", message: "Disk is full" });
    mockedCreate.mockResolvedValueOnce(note("notes/retry.md", "Retry"));
    mockedRead.mockResolvedValue({ content: "", version: "v1" });
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(screen.getByRole("button", { name: /new note/i }));
    await user.type(screen.getByLabelText("Note title"), "Retry{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "New note" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Disk is full");
    expect(within(dialog).getByLabelText("Note title")).toHaveValue("Retry");
    await user.click(within(dialog).getByRole("button", { name: "Create note" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockedCreate).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate creation and dismissal while a note is being created", async () => {
    mockedList.mockResolvedValue([]);
    const pending = deferred<NoteMeta>();
    mockedCreate.mockReturnValue(pending.promise);
    mockedRead.mockResolvedValue({ content: "", version: "v1" });
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(screen.getByRole("button", { name: /new note/i }));
    await user.type(screen.getByLabelText("Note title"), "One note{Enter}");
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Enter}{Escape}");
    expect(screen.getByRole("dialog", { name: "New note" })).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledTimes(1);
    pending.resolve(note("notes/one-note.md", "One note"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("highlights the currently open note", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/loose.md" },
        key: "note:notes/loose.md",
        content: "x",
        savedContent: "x",
        savedVersion: "v1",
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
        savedVersion: "v1",
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

  // ── autosave races ───────────────────────────────────────────────────

  it("delete flushes pending edits first and a late autosave can't resurrect the file", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    const del = deferred<void>();
    mockedDelete.mockReturnValue(del.promise);
    openNoteState("notes/loose.md", "edited", "x");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-delete-notes/loose.md"),
    );
    await waitFor(() =>
      expect(mockedDelete).toHaveBeenCalledWith("notes/loose.md"),
    );
    // Pending edits were written to the file before it was deleted.
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    expect(mockedWrite).toHaveBeenCalledWith("notes/loose.md", "edited", "v1", null);

    // While the delete is in flight the user types and the debounce fires.
    useEditorStore.getState().setContent("edited more");
    scheduleSave({ kind: "note", relPath: "notes/loose.md" }, "edited more", 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedWrite).toHaveBeenCalledTimes(1);

    del.resolve();
    await waitFor(() => expect(useEditorStore.getState().open).toBeNull());
    await new Promise((r) => setTimeout(r, 900));
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("rename keeps unsaved in-memory edits and never writes to the old path afterwards", async () => {
    mockedList.mockResolvedValue([note("notes/loose.md", "Loose")]);
    const ren = deferred<NoteMeta>();
    mockedRename.mockReturnValue(ren.promise);
    openNoteState("notes/loose.md", "v1", "v0");
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("renamed");
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(
      await screen.findByTestId("notes-rename-notes/loose.md"),
    );
    await waitFor(() => expect(mockedRename).toHaveBeenCalled());
    expect(mockedWrite).toHaveBeenCalledWith("notes/loose.md", "v1", "v1", null);

    // Typing during the rename; its debounce fires mid-rename.
    useEditorStore.getState().setContent("v2");
    scheduleSave({ kind: "note", relPath: "notes/loose.md" }, "v2", 0);
    await new Promise((r) => setTimeout(r, 20));

    ren.resolve(note("notes/renamed.md", "Renamed"));
    await waitFor(() =>
      expect(useEditorStore.getState().open?.key).toBe("note:notes/renamed.md"),
    );
    // In-memory content survives; nothing re-read from disk.
    expect(useEditorStore.getState().open?.content).toBe("v2");
    expect(mockedRead).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 900));
    const oldPathWrites = mockedWrite.mock.calls.filter(
      ([p]) => p === "notes/loose.md",
    );
    expect(oldPathWrites).toEqual([["notes/loose.md", "v1", "v1", null]]);
    promptSpy.mockRestore();
  });

  it("out-of-order opens: the last click wins even if the first read resolves last", async () => {
    mockedList.mockResolvedValue([
      note("notes/a.md", "A"),
      note("notes/b.md", "B"),
    ]);
    const a = deferred<NoteDocument>();
    const b = deferred<NoteDocument>();
    mockedRead.mockImplementation((p) =>
      p === "notes/a.md" ? a.promise : b.promise,
    );
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(await screen.findByTestId("notes-file-notes/a.md"));
    await waitFor(() => expect(mockedRead).toHaveBeenCalledWith("notes/a.md"));
    await user.click(screen.getByTestId("notes-file-notes/b.md"));
    await waitFor(() => expect(mockedRead).toHaveBeenCalledWith("notes/b.md"));
    b.resolve({ content: "B body", version: "vb" });
    await waitFor(() =>
      expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md"),
    );
    a.resolve({ content: "A body", version: "va" });
    await new Promise((r) => setTimeout(r, 20));
    expect(useEditorStore.getState().open?.key).toBe("note:notes/b.md");
    expect(useEditorStore.getState().open?.content).toBe("B body");
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
    mockedList.mockResolvedValue([]);
    mockedListDirs.mockResolvedValueOnce([]).mockResolvedValueOnce([
      "notes/Projects",
    ]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText(/no notes yet/i);
    await user.click(screen.getByTestId("notes-new-folder"));
    await user.type(screen.getByLabelText("Folder name"), "Projects{Enter}");
    await waitFor(() => {
      expect(mockedCreateDir).toHaveBeenCalledWith("notes/Projects");
    });
    expect(await screen.findByTestId("notes-folder-notes/Projects")).toBeInTheDocument();
  });

  it("opens the subfolder dialog with the selected parent", async () => {
    mockedList.mockResolvedValue([]);
    mockedListDirs.mockResolvedValue(["notes/work"]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(await screen.findByTestId("notes-folder-new-notes/work"));
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    expect(dialog).toHaveAccessibleDescription("In notes/work/");
    await user.type(within(dialog).getByLabelText("Folder name"), "Meetings{Enter}");
    await waitFor(() => {
      expect(mockedCreateDir).toHaveBeenCalledWith("notes/work/Meetings");
    });
  });

  it.each(["work/meetings", "work\\meetings", ".", ".."])(
    "keeps an invalid folder name (%s) in the dialog without creating it",
    async (name) => {
      mockedList.mockResolvedValue([]);
      const user = userEvent.setup();
      render(<NotesListPanel />);
      await user.click(screen.getByTestId("notes-new-folder"));
      await user.type(screen.getByLabelText("Folder name"), `${name}{Enter}`);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByLabelText("Folder name")).toHaveValue(name);
      expect(mockedCreateDir).not.toHaveBeenCalled();
    },
  );

  it("traps focus in the folder dialog and closes it with Escape", async () => {
    mockedList.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    const trigger = screen.getByTestId("notes-new-folder");
    await user.click(trigger);
    const input = screen.getByLabelText("Folder name");
    await user.type(input, "Projects");
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Create folder" })).toHaveFocus();
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(mockedCreateDir).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
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

  // ── menu-triggered (File ▸ New Note / New Folder) ────────────────────

  it("opens the new-note dialog when uiStore queues it (Cmd+N)", async () => {
    mockedList.mockResolvedValue([]);
    mockedCreate.mockResolvedValue(note("notes/from-menu.md", "From Menu"));
    mockedRead.mockResolvedValue({ content: "body", version: "v1" });
    useUIStore.setState({ pendingAction: "newNote" });

    render(<NotesListPanel />);
    await userEvent.type(await screen.findByLabelText("Note title"), "From Menu{Enter}");
    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledWith("notes", "From Menu");
    });
    expect(useUIStore.getState().pendingAction).toBeNull();
  });

  it("opens the new-folder dialog when uiStore queues it (Shift+Cmd+N)", async () => {
    mockedList.mockResolvedValue([]);
    useUIStore.setState({ pendingAction: "newFolder" });

    render(<NotesListPanel />);
    await userEvent.type(await screen.findByLabelText("Folder name"), "Inbox2{Enter}");
    await waitFor(() => {
      expect(mockedCreateDir).toHaveBeenCalledWith("notes/Inbox2");
    });
    expect(useUIStore.getState().pendingAction).toBeNull();
  });
});
