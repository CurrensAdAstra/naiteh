import { beforeEach, describe, expect, it } from "vitest";

import { isDirty, useEditorStore } from "../editorStore";

describe("editorStore", () => {
  beforeEach(() => {
    useEditorStore.setState({ open: null });
  });

  it("openNote seeds both content and savedContent", () => {
    useEditorStore.getState().openNote("notes/x.md", "hello");
    const open = useEditorStore.getState().open;
    expect(open).not.toBeNull();
    expect(open!.source).toEqual({ kind: "note", relPath: "notes/x.md" });
    expect(open!.key).toBe("note:notes/x.md");
    expect(open!.content).toBe("hello");
    expect(open!.savedContent).toBe("hello");
    expect(isDirty(open!)).toBe(false);
  });

  it("openJournal stores the date and rel path", () => {
    useEditorStore
      .getState()
      .openJournal("2026-05-09", "journal/2026/05/2026-05-09.md", "");
    const open = useEditorStore.getState().open;
    expect(open!.source).toEqual({
      kind: "journal",
      date: "2026-05-09",
      relPath: "journal/2026/05/2026-05-09.md",
    });
    expect(open!.key).toBe("journal:2026-05-09");
  });

  it("setContent diverges content from savedContent", () => {
    useEditorStore.getState().openNote("notes/x.md", "hello");
    useEditorStore.getState().setContent("hello world");
    const open = useEditorStore.getState().open!;
    expect(open.content).toBe("hello world");
    expect(open.savedContent).toBe("hello");
    expect(isDirty(open)).toBe(true);
  });

  it("markSaved promotes the current content to savedContent", () => {
    useEditorStore.getState().openNote("notes/x.md", "a");
    useEditorStore.getState().setContent("b");
    useEditorStore.getState().markSaved();
    const open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("b");
    expect(isDirty(open)).toBe(false);
  });

  it("setContent is a no-op when no note is open", () => {
    useEditorStore.getState().setContent("ignored");
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("closeNote clears open", () => {
    useEditorStore.getState().openNote("notes/x.md", "a");
    useEditorStore.getState().closeNote();
    expect(useEditorStore.getState().open).toBeNull();
  });
});
