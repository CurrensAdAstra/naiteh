import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NoteMeta } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { useUIStore } from "../../../state/uiStore";
import { flattenTree, buildTree } from "../buildTree";
import { NotesListPanel, ROW_HEIGHT_PX } from "../NotesListPanel";

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

// Count FileText icon renders: one per FileRow render.
const fileIconRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("lucide-react", async (orig) => {
  const actual = await orig<typeof import("lucide-react")>();
  const Real = actual.FileText;
  return {
    ...actual,
    FileText: (props: Record<string, unknown>) => {
      fileIconRenders.count++;
      return <Real {...props} />;
    },
  };
});

import { notesList, notesListDirs, notesRead } from "../../../lib/api/notes";

const mockedList = vi.mocked(notesList);
const mockedListDirs = vi.mocked(notesListDirs);
const mockedRead = vi.mocked(notesRead);

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

/** Zero-padded so title sort == numeric order. */
function many(n: number, folder = "notes"): NoteMeta[] {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i).padStart(5, "0");
    return note(`${folder}/n${id}.md`, `Note ${id}`);
  });
}

const rowCount = () => screen.getAllByRole("treeitem").length;

describe("NotesListPanel tree virtualization", () => {
  beforeEach(() => {
    mockedList.mockReset();
    mockedListDirs.mockReset();
    mockedListDirs.mockResolvedValue([]);
    mockedRead.mockReset();
    mockedRead.mockResolvedValue({ content: "x", version: "v1" });
    useEditorStore.setState({ open: null });
    useUIStore.setState({ pendingAction: null });
    fileIconRenders.count = 0;
  });

  it("mounts only the visible window of a 5000-note tree", async () => {
    mockedList.mockResolvedValue(many(5000));
    render(<NotesListPanel />);
    await screen.findByText("Note 00000");
    expect(rowCount()).toBeLessThan(60);
    expect(screen.queryByText("Note 04999")).toBeNull();
    const tree = screen.getByRole("tree");
    expect(
      (tree.firstElementChild as HTMLElement).style.height,
    ).toBe(`${5000 * ROW_HEIGHT_PX}px`);

    // Scrolling moves the window.
    tree.scrollTop = 4000 * ROW_HEIGHT_PX;
    fireEvent.scroll(tree);
    expect(await screen.findByText("Note 04000")).toBeInTheDocument();
    expect(screen.queryByText("Note 00000")).toBeNull();
    expect(rowCount()).toBeLessThan(60);
  });

  it("expands top-level folders by default, nested collapsed, and toggles rows", async () => {
    mockedList.mockResolvedValue([
      note("notes/work/a.md", "A"),
      note("notes/work/deep/b.md", "B"),
    ]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await screen.findByText("A");
    expect(screen.queryByText("B")).toBeNull();
    const deep = screen.getByTestId("notes-folder-notes/work/deep");
    expect(deep).toHaveAttribute("aria-expanded", "false");
    expect(rowCount()).toBe(3);

    await user.click(deep);
    expect(await screen.findByText("B")).toBeInTheDocument();
    expect(rowCount()).toBe(4);

    await user.click(screen.getByTestId("notes-folder-notes/work"));
    expect(rowCount()).toBe(1);
  });

  it("keeps expansion across refreshes", async () => {
    mockedList.mockResolvedValue([note("notes/work/deep/b.md", "B")]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    await user.click(await screen.findByTestId("notes-folder-notes/work/deep"));
    await screen.findByText("B");
    await act(async () => {
      const { notifyVaultContentChanged } = await import(
        "../../../state/vaultContentStore"
      );
      notifyVaultContentChanged();
    });
    await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("reveals and scrolls the selected note into view", async () => {
    mockedList.mockResolvedValue([
      ...many(3000),
      note("notes/a/b/target.md", "Target"),
    ]);
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/a/b/target.md" },
        key: "note:notes/a/b/target.md",
        content: "x",
        savedContent: "x",
        savedVersion: "v1",
      },
    });
    render(<NotesListPanel />);
    const row = await screen.findByTestId("notes-file-notes/a/b/target.md");
    expect(row.className).toMatch(/rowActive/);
    expect(row).toHaveAttribute("aria-selected", "true");
    // Folders come first, so "Target" sits at index 2: no scroll needed.
    expect(screen.getByRole("tree").scrollTop).toBe(0);

    // Opening a note far down scrolls to it.
    act(() => {
      useEditorStore.setState({
        open: {
          source: { kind: "note", relPath: "notes/n02500.md" },
          key: "note:notes/n02500.md",
          content: "x",
          savedContent: "x",
          savedVersion: "v1",
        },
      });
    });
    expect(
      await screen.findByTestId("notes-file-notes/n02500.md"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tree").scrollTop).toBeGreaterThan(0);
  });

  it("supports Up/Down/Left/Right/Enter keyboard navigation", async () => {
    mockedList.mockResolvedValue([
      note("notes/work/a.md", "A"),
      note("notes/loose.md", "Loose"),
    ]);
    const user = userEvent.setup();
    render(<NotesListPanel />);
    const folder = await screen.findByTestId("notes-folder-notes/work");
    expect(folder).toHaveAttribute("tabindex", "0");
    folder.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("notes-file-notes/work/a.md")).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(folder).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(folder).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("A")).toBeNull();
    await user.keyboard("{ArrowRight}");
    expect(folder).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByTestId("notes-file-notes/work/a.md")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByTestId("notes-file-notes/loose.md")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(useEditorStore.getState().open?.key).toBe("note:notes/work/a.md"),
    );
  });

  it("does not re-render unrelated rows when the selection changes", async () => {
    mockedList.mockResolvedValue(many(10));
    render(<NotesListPanel />);
    await screen.findByText("Note 00009");
    const before = fileIconRenders.count;
    act(() => {
      useEditorStore.setState({
        open: {
          source: { kind: "note", relPath: "notes/n00003.md" },
          key: "note:notes/n00003.md",
          content: "x",
          savedContent: "x",
          savedVersion: "v1",
        },
      });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("notes-file-notes/n00003.md").className,
      ).toMatch(/rowActive/),
    );
    // Only the newly active row (once for selection, once for roving focus)
    // and the row losing focus re-render -- not the other 7.
    expect(fileIconRenders.count - before).toBeLessThanOrEqual(3);
  });

  it("flattenTree only descends into expanded folders", () => {
    const tree = buildTree([
      note("notes/x/y/z.md", "Z"),
      note("notes/top.md", "Top"),
    ]);
    expect(flattenTree(tree, () => false).map((r) => r.depth)).toEqual([1, 1]);
    expect(flattenTree(tree, () => true)).toHaveLength(4);
  });
});
