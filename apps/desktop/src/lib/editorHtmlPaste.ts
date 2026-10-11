//! CodeMirror 6 extension: convert pasted / clipped HTML to Markdown.
//!
//! On paste, when the clipboard carries `text/html` (and no image files —
//! those belong to `editorAttachmentDrop`, which keeps priority), the HTML
//! is converted with the *current* clipping settings (read at paste time,
//! so changing them applies without rebuilding the editor) and replaces
//! the selection. Inside a fenced / indented code block the default
//! text/plain paste runs instead. See `lib/htmlToMarkdown`.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { filesFromClipboard } from "./editorAttachmentDrop";
import { clipboardToText } from "./htmlToMarkdown";
import type { ClippingConfig } from "./types";
import {
  selectClippingConfig,
  useSettingsStore,
} from "../state/settingsStore";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

const CODE_NODES = new Set(["FencedCode", "CodeBlock"]);

/** True when `pos` sits inside a fenced or indented code block. */
export function isInCodeBlock(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos, 50) ?? syntaxTree(state);
  return [-1, 1].some((side) => {
    for (
      let node: SyntaxNode | null = tree.resolveInner(pos, side as -1 | 1);
      node !== null;
      node = node.parent
    ) {
      if (!CODE_NODES.has(node.name)) continue;
      if (pos > node.from && pos < node.to) return true;
      // An unclosed fence runs to the end of the document.
      if (pos === node.to && node.name === "FencedCode") {
        return node.getChildren("CodeMark").length < 2;
      }
    }
    return false;
  });
}

/**
 * The text an HTML paste should insert, or null to fall back to the
 * default paste (images present, cursor in a code block, HTML paste
 * disabled, no / formatting-free HTML).
 */
export function htmlPasteText(
  state: EditorState,
  data: DataTransfer,
  opts: ClippingConfig,
): string | null {
  if (filesFromClipboard(data).length > 0) return null;
  if (state.selection.ranges.some((r) => isInCodeBlock(state, r.from))) {
    return null;
  }
  return clipboardToText(data, opts);
}

export function editorHtmlPaste(): ReturnType<
  typeof EditorView.domEventHandlers
> {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (data === null) return false;
      if (view.state.readOnly || !view.state.facet(EditorView.editable)) {
        return false;
      }
      const text = htmlPasteText(
        view.state,
        data,
        selectClippingConfig(useSettingsStore.getState()),
      );
      if (text === null) return false;
      event.preventDefault();
      view.dispatch(view.state.replaceSelection(text), {
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      return true;
    },
  });
}
