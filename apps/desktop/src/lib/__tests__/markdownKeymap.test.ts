import { describe, expect, it } from "vitest";

import { __INTERNALS } from "../markdownKeymap";

/**
 * Build a fake EditorView-shaped object that mutates an internal string
 * when dispatched. Enough for toggle/insert logic; no real CM6 wiring.
 */
interface FakeView {
  state: {
    readOnly: boolean;
    doc: { length: number; toString: () => string };
    selection: { main: { from: number; to: number } };
    sliceDoc: (from: number, to: number) => string;
  };
  dispatch: (tx: unknown) => void;
  /** test-only mirror of the post-dispatch doc + selection */
  doc: string;
  selection: { from: number; to: number };
}

interface Change {
  from: number;
  to: number;
  insert: string;
}

interface Tx {
  changes: Change | Change[];
  selection?: { anchor: number; head: number };
}

function makeView(initial: string, from: number, to: number, readOnly = false): FakeView {
  const view = {
    doc: initial,
    selection: { from, to },
  } as FakeView;
  view.state = {
    readOnly,
    doc: {
      get length() {
        return view.doc.length;
      },
      toString: () => view.doc,
    },
    selection: { main: { from, to } },
    sliceDoc: (a: number, b: number) => view.doc.slice(a, b),
  };
  view.dispatch = (tx: unknown) => {
    const t = tx as Tx;
    const changes = Array.isArray(t.changes) ? t.changes : [t.changes];
    // Apply right-to-left so earlier ranges stay valid.
    const sorted = [...changes].sort((a, b) => b.from - a.from);
    let doc = view.doc;
    for (const c of sorted) {
      doc = doc.slice(0, c.from) + c.insert + doc.slice(c.to);
    }
    view.doc = doc;
    if (t.selection !== undefined) {
      view.selection = {
        from: t.selection.anchor,
        to: t.selection.head,
      };
      view.state.selection.main = {
        from: t.selection.anchor,
        to: t.selection.head,
      };
    }
  };
  return view;
}

describe("markdownKeymap", () => {
  describe("toggleWrap (bold/italic/code)", () => {
    it("wraps the selection when not yet wrapped", () => {
      const v = makeView("hello world", 0, 5);
      __INTERNALS.toggleWrap(v as never, "**");
      expect(v.doc).toBe("**hello** world");
      expect(v.selection).toEqual({ from: 2, to: 7 });
    });

    it("strips surrounding markers when selection is already wrapped outside", () => {
      const v = makeView("**hello** world", 2, 7);
      __INTERNALS.toggleWrap(v as never, "**");
      expect(v.doc).toBe("hello world");
      expect(v.selection).toEqual({ from: 0, to: 5 });
    });

    it("strips inner markers when selection includes them", () => {
      const v = makeView("**hello** world", 0, 9);
      __INTERNALS.toggleWrap(v as never, "**");
      expect(v.doc).toBe("hello world");
      expect(v.selection).toEqual({ from: 0, to: 5 });
    });

    it("inserts paired markers + cursor between them when selection is empty", () => {
      const v = makeView("doc body", 4, 4);
      __INTERNALS.toggleWrap(v as never, "*");
      expect(v.doc).toBe("doc **body");
      expect(v.selection).toEqual({ from: 5, to: 5 });
    });

    it("does nothing in read-only state", () => {
      const v = makeView("hello world", 0, 5, true);
      const result = __INTERNALS.toggleWrap(v as never, "**");
      expect(result).toBe(false);
      expect(v.doc).toBe("hello world");
    });

    it("works for single-character markers (italic, code)", () => {
      const v = makeView("plain word", 6, 10);
      __INTERNALS.toggleWrap(v as never, "*");
      expect(v.doc).toBe("plain *word*");
      __INTERNALS.toggleWrap(v as never, "*");
      // Reverse-toggle restores the original.
      expect(v.doc).toBe("plain word");
    });
  });

  describe("insertLink", () => {
    it("wraps the selection as link text and selects the url placeholder", () => {
      const v = makeView("see naiteh later", 4, 10);
      __INTERNALS.insertLink(v as never);
      expect(v.doc).toBe("see [naiteh](url) later");
      // Cursor should land on the "url" placeholder.
      expect(v.selection).toEqual({ from: 13, to: 16 });
    });

    it("inserts a default link skeleton when nothing is selected", () => {
      const v = makeView("abc", 3, 3);
      __INTERNALS.insertLink(v as never);
      expect(v.doc).toBe("abc[text](url)");
      expect(v.selection).toEqual({ from: 10, to: 13 });
    });

    it("does nothing in read-only state", () => {
      const v = makeView("hello", 0, 5, true);
      const result = __INTERNALS.insertLink(v as never);
      expect(result).toBe(false);
      expect(v.doc).toBe("hello");
    });
  });
});
