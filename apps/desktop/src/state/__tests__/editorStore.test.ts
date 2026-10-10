import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  beginOpen,
  cancelPendingOpens,
  insertAtCursor,
  isDirty,
  isLatestOpen,
  readCurrentDoc,
  replaceRange,
  replaceWholeDocument,
  useEditorStore,
} from "../editorStore";

/**
 * A *real* CodeMirror view wired exactly like EditorPanel: its
 * updateListener mirrors every doc change into the store synchronously
 * inside `dispatch`. Fake views whose dispatch never fires listeners hid
 * the double-insert bug in replaceRange.
 */
function mountRealView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            useEditorStore.getState().setContent(update.state.doc.toString());
          }
        }),
      ],
    }),
    parent,
  });
  useEditorStore.setState({ view });
  return view;
}

describe("editorStore", () => {
  let view: EditorView | null = null;

  beforeEach(() => {
    useEditorStore.setState({ open: null, view: null, saveError: null });
  });

  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = "";
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

  it("openNote bumps revision even when re-opening the same path", () => {
    useEditorStore.getState().openNote("notes/x.md", "a");
    const r1 = useEditorStore.getState().revision;
    useEditorStore.getState().openNote("notes/x.md", "b");
    expect(useEditorStore.getState().revision).toBe(r1 + 1);
    expect(useEditorStore.getState().open?.content).toBe("b");
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

  it("markSaved records exactly the written content for that note", () => {
    useEditorStore.getState().openNote("notes/x.md", "a");
    useEditorStore.getState().setContent("b");
    useEditorStore.getState().markSaved("note:notes/x.md", "b");
    const open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("b");
    expect(isDirty(open)).toBe(false);
  });

  it("markSaved keeps edits typed during the write dirty", () => {
    useEditorStore.getState().openNote("notes/x.md", "a");
    useEditorStore.getState().setContent("b");
    // write of "b" in flight; user keeps typing
    useEditorStore.getState().setContent("bc");
    useEditorStore.getState().markSaved("note:notes/x.md", "b");
    const open = useEditorStore.getState().open!;
    expect(open.savedContent).toBe("b");
    expect(isDirty(open)).toBe(true);
  });

  it("markSaved for a note that is no longer open is a no-op", () => {
    useEditorStore.getState().openNote("notes/b.md", "B");
    useEditorStore.getState().setContent("B2");
    useEditorStore.getState().markSaved("note:notes/a.md", "B2");
    expect(useEditorStore.getState().open?.savedContent).toBe("B");
  });

  it("reloadOpen replaces content cleanly and bumps revision", () => {
    useEditorStore.getState().openNote("notes/x.md", "old");
    const r = useEditorStore.getState().revision;
    useEditorStore.getState().reloadOpen("note:notes/x.md", "new");
    const open = useEditorStore.getState().open!;
    expect(open.content).toBe("new");
    expect(open.savedContent).toBe("new");
    expect(useEditorStore.getState().revision).toBe(r + 1);
  });

  it("retargetOpen moves the document but keeps unsaved content", () => {
    useEditorStore.getState().openNote("notes/x.md", "a");
    useEditorStore.getState().setContent("a-edited");
    useEditorStore
      .getState()
      .retargetOpen("note:notes/x.md", { kind: "note", relPath: "notes/y.md" });
    const open = useEditorStore.getState().open!;
    expect(open.key).toBe("note:notes/y.md");
    expect(open.content).toBe("a-edited");
    expect(isDirty(open)).toBe(true);
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

  it("only the newest open ticket is current", () => {
    const a = beginOpen();
    const b = beginOpen();
    expect(isLatestOpen(a)).toBe(false);
    expect(isLatestOpen(b)).toBe(true);
    cancelPendingOpens();
    expect(isLatestOpen(b)).toBe(false);
  });

  describe("with a real EditorView", () => {
    it("replaceRange keeps the store equal to the view (no double insert)", () => {
      useEditorStore.getState().openNote("notes/x.md", "ab");
      view = mountRealView("ab");
      expect(replaceRange(2, 2, "X")).toBe(true);
      expect(view.state.doc.toString()).toBe("abX");
      expect(useEditorStore.getState().open?.content).toBe("abX");
    });

    it("replaceRange replaces a middle range once", () => {
      useEditorStore.getState().openNote("notes/x.md", "alpha beta gamma");
      view = mountRealView("alpha beta gamma");
      replaceRange(6, 10, "BETA!");
      expect(view.state.doc.toString()).toBe("alpha BETA! gamma");
      expect(useEditorStore.getState().open?.content).toBe("alpha BETA! gamma");
    });

    it("replaceRange rejects out-of-bounds ranges", () => {
      useEditorStore.getState().openNote("notes/x.md", "ab");
      view = mountRealView("ab");
      expect(replaceRange(1, 5, "X")).toBe(false);
      expect(view.state.doc.toString()).toBe("ab");
    });

    it("insertAtCursor inserts at the selection once", () => {
      useEditorStore.getState().openNote("notes/x.md", "hello");
      view = mountRealView("hello");
      view.dispatch({ selection: { anchor: 5 } });
      insertAtCursor(" ![img](attachments/a.png)");
      const expected = "hello ![img](attachments/a.png)";
      expect(view.state.doc.toString()).toBe(expected);
      expect(useEditorStore.getState().open?.content).toBe(expected);
      expect(readCurrentDoc()).toBe(expected);
    });

    it("replaceWholeDocument keeps the store equal to the view", () => {
      useEditorStore.getState().openNote("notes/x.md", "body");
      view = mountRealView("body");
      replaceWholeDocument("---\npinned: true\n---\nbody");
      expect(view.state.doc.toString()).toBe("---\npinned: true\n---\nbody");
      expect(useEditorStore.getState().open?.content).toBe(
        "---\npinned: true\n---\nbody",
      );
    });
  });
});
