import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { useSettingsStore } from "../../../state/settingsStore";
import { useUIStore } from "../../../state/uiStore";
import { AiPanel } from "../AiPanel";

vi.mock("../../../lib/api/ai", () => ({
  aiImprove: vi.fn(),
}));

import { aiImprove } from "../../../lib/api/ai";
const mockedImprove = vi.mocked(aiImprove);

function configWithAi(apiKey: string | null): AppConfig {
  return {
    activeVault: "/v",
    knownVaults: ["/v"],
    theme: "light",
    editor: { fontSize: 14, lineWrapping: true },
    calendar: { subView: "timeline" },
    journal: { splitRatio: 0.5 },
    ai: {
      apiKey,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
  };
}

interface FakeViewState {
  doc: string;
  selFrom: number;
  selTo: number;
}

function makeFakeView(state: FakeViewState) {
  const dispatched: Array<{
    changes: { from: number; to: number; insert: string };
  }> = [];
  const view = {
    state: {
      doc: {
        toString: () => state.doc,
        get length() {
          return state.doc.length;
        },
      },
      selection: {
        main: { from: state.selFrom, to: state.selTo },
      },
      sliceDoc: (from: number, to: number) => state.doc.slice(from, to),
    },
    dispatch: (tx: { changes: { from: number; to: number; insert: string } }) => {
      dispatched.push(tx);
      const before = state.doc.slice(0, tx.changes.from);
      const after = state.doc.slice(tx.changes.to);
      state.doc = before + tx.changes.insert + after;
    },
    focus: vi.fn(),
  };
  return { view, dispatched };
}

function setOpenWithView(viewObj: ReturnType<typeof makeFakeView>["view"]) {
  // Cast to the EditorView type — the store treats it as opaque.
  useEditorStore.setState({
    open: {
      source: { kind: "note", relPath: "notes/x.md" },
      key: "note:notes/x.md",
      content: "doc body",
      savedContent: "doc body",
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view: viewObj as any,
  });
}

describe("AiPanel", () => {
  beforeEach(() => {
    mockedImprove.mockReset();
    useEditorStore.setState({ open: null, view: null });
    useSettingsStore.setState({ config: configWithAi("sk-test"), loading: false });
    useUIStore.setState({ aiPanelOpen: true });
  });

  it("warns when no API key is configured and disables Run", async () => {
    useSettingsStore.setState({ config: configWithAi(null), loading: false });
    render(<AiPanel />);
    expect(screen.getByTestId("ai-panel-key-missing")).toBeInTheDocument();
    expect(screen.getByTestId("ai-run")).toBeDisabled();
  });

  it("rejects an empty instruction without making a request", async () => {
    const user = userEvent.setup();
    render(<AiPanel />);
    await user.click(screen.getByTestId("ai-run"));
    expect(await screen.findByTestId("ai-error")).toHaveTextContent(/instruction/i);
    expect(mockedImprove).not.toHaveBeenCalled();
  });

  it("preset fills the instruction textarea", async () => {
    const user = userEvent.setup();
    render(<AiPanel />);
    await user.click(screen.getByTestId("ai-preset-improve-writing"));
    expect(
      (screen.getByTestId("ai-instruction") as HTMLTextAreaElement).value,
    ).toMatch(/improve clarity/i);
  });

  it("sends the current selection text to ai_improve and renders the result", async () => {
    const fake = makeFakeView({ doc: "alpha beta gamma", selFrom: 6, selTo: 10 });
    setOpenWithView(fake.view);
    mockedImprove.mockResolvedValue("REPLACEMENT");

    const user = userEvent.setup();
    render(<AiPanel />);
    fireEvent.change(screen.getByTestId("ai-instruction"), {
      target: { value: "make uppercase" },
    });
    await user.click(screen.getByTestId("ai-run"));

    await waitFor(() => {
      expect(mockedImprove).toHaveBeenCalledWith("beta", "make uppercase");
    });
    expect(
      within(await screen.findByTestId("ai-result")).getByText("REPLACEMENT"),
    ).toBeInTheDocument();
  });

  it('"Replace in editor" applies the result to the original range', async () => {
    const fake = makeFakeView({ doc: "alpha beta gamma", selFrom: 6, selTo: 10 });
    setOpenWithView(fake.view);
    mockedImprove.mockResolvedValue("REPLACEMENT");

    const user = userEvent.setup();
    render(<AiPanel />);
    fireEvent.change(screen.getByTestId("ai-instruction"), {
      target: { value: "x" },
    });
    await user.click(screen.getByTestId("ai-run"));
    const apply = await screen.findByTestId("ai-result-apply");
    await user.click(apply);

    expect(fake.dispatched).toHaveLength(1);
    expect(fake.dispatched[0]?.changes).toEqual({
      from: 6,
      to: 10,
      insert: "REPLACEMENT",
    });
  });

  it("Whole-document scope sends the entire doc to ai_improve", async () => {
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/x.md" },
        key: "note:notes/x.md",
        content: "full document body",
        savedContent: "full document body",
      },
      view: null,
    });
    mockedImprove.mockResolvedValue("WHOLE");

    const user = userEvent.setup();
    render(<AiPanel />);
    await user.click(screen.getByTestId("ai-scope-document"));
    fireEvent.change(screen.getByTestId("ai-instruction"), {
      target: { value: "rewrite" },
    });
    await user.click(screen.getByTestId("ai-run"));

    await waitFor(() => {
      expect(mockedImprove).toHaveBeenCalledWith(
        "full document body",
        "rewrite",
      );
    });
  });

  it("surfaces backend errors", async () => {
    setOpenWithView(
      makeFakeView({ doc: "doc body", selFrom: 0, selTo: 0 }).view,
    );
    mockedImprove.mockRejectedValue({
      kind: "Upstream",
      message: "ai request returned 429: rate limited",
    });

    const user = userEvent.setup();
    render(<AiPanel />);
    fireEvent.change(screen.getByTestId("ai-instruction"), {
      target: { value: "anything" },
    });
    await user.click(screen.getByTestId("ai-run"));
    const error = await screen.findByTestId("ai-error");
    expect(error).toHaveTextContent(/rate limited/i);
    expect(error).toHaveTextContent(/service error/i);
  });

  it("close button toggles aiPanelOpen off", async () => {
    const user = userEvent.setup();
    render(<AiPanel />);
    await user.click(screen.getByTestId("ai-panel-close"));
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
  });
});
