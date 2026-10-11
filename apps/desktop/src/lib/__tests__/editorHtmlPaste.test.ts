import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/attachments", () => ({
  attachmentsImportBytes: vi.fn(),
}));

import { editorHtmlPaste, htmlPasteText, isInCodeBlock } from "../editorHtmlPaste";
import { DEFAULT_CLIPPING, type AppConfig } from "../types";
import { useSettingsStore } from "../../state/settingsStore";

function fakeClipboard(
  flavours: Record<string, string>,
  files: File[] = [],
): DataTransfer {
  const items = [
    ...Object.keys(flavours).map((type) => ({
      kind: "string",
      type,
      getAsFile: () => null,
    })),
    ...files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
  ];
  return {
    getData: (t: string) => flavours[t] ?? "",
    items,
    types: [...Object.keys(flavours), ...(files.length > 0 ? ["Files"] : [])],
    files,
  } as unknown as DataTransfer;
}

function stateAt(doc: string, marker = "|"): EditorState {
  const pos = doc.indexOf(marker);
  return EditorState.create({
    doc: doc.replace(marker, ""),
    selection: EditorSelection.cursor(pos),
    extensions: [markdown()],
  });
}

const RICH = { "text/html": "<p>Hi <b>there</b></p>", "text/plain": "Hi there" };

describe("isInCodeBlock", () => {
  it("detects fenced code", () => {
    const s = stateAt("text\n\n```js\nlet a|\n```\n\nafter");
    expect(isInCodeBlock(s, s.selection.main.from)).toBe(true);
  });

  it("is false outside the fence, including right after it", () => {
    const s = stateAt("```\ncode\n```|\n\nafter");
    expect(isInCodeBlock(s, s.selection.main.from)).toBe(false);
    const s2 = stateAt("para |here\n\n```\ncode\n```");
    expect(isInCodeBlock(s2, s2.selection.main.from)).toBe(false);
  });

  it("treats an unclosed fence at the document end as code", () => {
    const s = stateAt("```\nabc|");
    expect(isInCodeBlock(s, s.selection.main.from)).toBe(true);
  });

  it("detects indented code blocks", () => {
    const s = stateAt("para\n\n    code| here\n\nafter");
    expect(isInCodeBlock(s, s.selection.main.from)).toBe(true);
  });
});

describe("htmlPasteText", () => {
  it("converts HTML in normal text", () => {
    expect(htmlPasteText(stateAt("a |b"), fakeClipboard(RICH), DEFAULT_CLIPPING)).toBe(
      "Hi **there**",
    );
  });

  it("defers to the default paste inside a code block", () => {
    expect(
      htmlPasteText(stateAt("```\n|\n```"), fakeClipboard(RICH), DEFAULT_CLIPPING),
    ).toBeNull();
  });

  it("leaves image pastes to the attachment handler", () => {
    const img = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
    expect(
      htmlPasteText(stateAt("|"), fakeClipboard(RICH, [img]), DEFAULT_CLIPPING),
    ).toBeNull();
  });

  it("respects htmlPaste: plain", () => {
    expect(
      htmlPasteText(stateAt("|"), fakeClipboard(RICH), {
        ...DEFAULT_CLIPPING,
        htmlPaste: "plain",
      }),
    ).toBeNull();
  });
});

describe("editorHtmlPaste extension", () => {
  afterEach(() => {
    useSettingsStore.setState({ config: null, loading: true });
  });

  function paste(view: EditorView, data: DataTransfer): Event {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    view.contentDOM.dispatchEvent(event);
    return event;
  }

  it("replaces the selection using the settings read at paste time", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "start XX end",
        selection: EditorSelection.range(6, 8),
        extensions: [markdown(), editorHtmlPaste()],
      }),
      parent: document.body,
    });
    const ev = paste(view, fakeClipboard(RICH));
    expect(ev.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe("start Hi **there** end");

    useSettingsStore.setState({
      config: {
        clipping: { ...DEFAULT_CLIPPING, strong: "__" },
      } as unknown as AppConfig,
    });
    paste(view, fakeClipboard(RICH));
    expect(view.state.doc.toString()).toContain("Hi __there__");
    view.destroy();
  });
});
