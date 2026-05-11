import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { TagsBar } from "../TagsBar";

function setOpen(content: string) {
  useEditorStore.setState({
    open: {
      source: { kind: "note", relPath: "notes/x.md" },
      key: "note:notes/x.md",
      content,
      savedContent: content,
    },
  });
}

describe("TagsBar", () => {
  beforeEach(() => {
    useEditorStore.setState({ open: null, view: null });
    useUIStore.setState({ editorReadOnly: false });
  });

  it("renders nothing when no note is open", () => {
    const { container } = render(<TagsBar />);
    expect(container.textContent).toBe("");
  });

  it("renders existing tags as chips, plus the empty marker is absent", () => {
    setOpen("---\ntags: [work, idea]\n---\nbody");
    render(<TagsBar />);
    expect(screen.getByTestId("tag-chip-work")).toBeInTheDocument();
    expect(screen.getByTestId("tag-chip-idea")).toBeInTheDocument();
    expect(screen.queryByTestId("tags-bar-empty")).not.toBeInTheDocument();
  });

  it('shows "none" when there are no tags', () => {
    setOpen("body without front matter");
    render(<TagsBar />);
    expect(screen.getByTestId("tags-bar-empty")).toBeInTheDocument();
  });

  it("Enter adds a new tag to the content", async () => {
    setOpen("---\ntags: [a]\n---\nbody");
    const user = userEvent.setup();
    render(<TagsBar />);
    const input = screen.getByTestId("tags-bar-input");
    await user.type(input, "new{Enter}");
    expect(useEditorStore.getState().open!.content).toContain(
      "tags: [a, new]",
    );
  });

  it("Comma also commits the typed value as a chip", async () => {
    setOpen("body");
    const user = userEvent.setup();
    render(<TagsBar />);
    await user.type(screen.getByTestId("tags-bar-input"), "alpha,");
    expect(useEditorStore.getState().open!.content).toContain(
      "tags: [alpha]",
    );
  });

  it("× button removes a tag", async () => {
    setOpen("---\ntags: [a, b, c]\n---\nbody");
    const user = userEvent.setup();
    render(<TagsBar />);
    await user.click(screen.getByTestId("tag-remove-b"));
    expect(useEditorStore.getState().open!.content).toContain(
      "tags: [a, c]",
    );
  });

  it("Backspace from empty input removes the last tag", async () => {
    setOpen("---\ntags: [a, b]\n---\nbody");
    const user = userEvent.setup();
    render(<TagsBar />);
    const input = screen.getByTestId("tags-bar-input");
    input.focus();
    await user.keyboard("{Backspace}");
    expect(useEditorStore.getState().open!.content).toContain(
      "tags: [a]",
    );
  });

  it("disables the input + remove buttons in read-only mode", async () => {
    setOpen("---\ntags: [a]\n---\nbody");
    useUIStore.setState({ editorReadOnly: true });
    render(<TagsBar />);
    expect(screen.getByTestId("tags-bar-input")).toBeDisabled();
    expect(screen.getByTestId("tag-remove-a")).toBeDisabled();
  });

  it("adding an existing tag is a no-op", async () => {
    setOpen("---\ntags: [a]\n---\nbody");
    const user = userEvent.setup();
    render(<TagsBar />);
    const before = useEditorStore.getState().open!.content;
    await user.type(screen.getByTestId("tags-bar-input"), "a{Enter}");
    expect(useEditorStore.getState().open!.content).toBe(before);
  });

  it("ignores whitespace-only input on Enter", async () => {
    setOpen("---\ntags: [a]\n---\nbody");
    render(<TagsBar />);
    const input = screen.getByTestId("tags-bar-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useEditorStore.getState().open!.content).toContain("tags: [a]");
  });
});
