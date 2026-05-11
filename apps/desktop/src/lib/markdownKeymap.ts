import { keymap, type KeyBinding } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Toggle a paired-marker wrap (e.g. `**` for bold) on the current
 * selection. If the selection is already wrapped by `marker` on both
 * sides, the markers are stripped; otherwise the selection is wrapped.
 * When the selection is empty, the markers are inserted and the cursor
 * is placed between them so the user can keep typing.
 *
 * Returns true when a change was dispatched (the keymap convention).
 */
function toggleWrap(view: EditorView, marker: string): boolean {
  const state = view.state;
  if (state.readOnly) return false;
  const sel = state.selection.main;
  const m = marker.length;

  // Empty selection → insert paired markers, cursor between them.
  if (sel.from === sel.to) {
    view.dispatch({
      changes: { from: sel.from, to: sel.from, insert: `${marker}${marker}` },
      selection: { anchor: sel.from + m, head: sel.from + m },
      userEvent: "input.markdown.toggle",
    });
    return true;
  }

  const selected = state.sliceDoc(sel.from, sel.to);
  // Already wrapped *inside* the selection? Strip the inner markers.
  if (
    selected.length >= 2 * m &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(m, selected.length - m);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: inner },
      selection: { anchor: sel.from, head: sel.from + inner.length },
      userEvent: "input.markdown.toggle",
    });
    return true;
  }

  // Already wrapped *outside* the selection? Strip the surrounding markers.
  const before = state.sliceDoc(Math.max(0, sel.from - m), sel.from);
  const after = state.sliceDoc(sel.to, Math.min(state.doc.length, sel.to + m));
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: sel.from - m, to: sel.from, insert: "" },
        { from: sel.to, to: sel.to + m, insert: "" },
      ],
      selection: { anchor: sel.from - m, head: sel.to - m },
      userEvent: "input.markdown.toggle",
    });
    return true;
  }

  // Wrap the selection.
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `${marker}${selected}${marker}` },
    selection: { anchor: sel.from + m, head: sel.to + m },
    userEvent: "input.markdown.toggle",
  });
  return true;
}

/** `[text](url|)` with cursor placed inside the URL slot. */
function insertLink(view: EditorView): boolean {
  const state = view.state;
  if (state.readOnly) return false;
  const sel = state.selection.main;
  const selected = state.sliceDoc(sel.from, sel.to);
  const text = selected.length > 0 ? selected : "text";
  const inserted = `[${text}](url)`;
  // Place the cursor over the "url" placeholder so the user can replace it.
  const urlStart = sel.from + 1 + text.length + 2; // after `[text](`
  const urlEnd = urlStart + 3; // length of `url`
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: inserted },
    selection: { anchor: urlStart, head: urlEnd },
    userEvent: "input.markdown.link",
  });
  return true;
}

const BINDINGS: KeyBinding[] = [
  { key: "Mod-b", run: (v) => toggleWrap(v, "**"), preventDefault: true },
  { key: "Mod-i", run: (v) => toggleWrap(v, "*"), preventDefault: true },
  { key: "Mod-`", run: (v) => toggleWrap(v, "`"), preventDefault: true },
  {
    key: "Mod-Shift-x",
    run: (v) => toggleWrap(v, "~~"),
    preventDefault: true,
  },
  { key: "Mod-k", run: insertLink, preventDefault: true },
];

export function markdownKeymap(): Extension {
  return keymap.of(BINDINGS);
}

/** Exposed for direct testing without standing up a real EditorView. */
export const __INTERNALS = { toggleWrap, insertLink };
