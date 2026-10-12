import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DAY_TIMELINE_DEFAULT,
  JOURNAL_SPLIT_DEFAULT,
  LIST_PANEL_DEFAULT,
  useUIStore,
  type ViewMode,
} from "../../state/uiStore";
import { useVaultStore } from "../../state/vaultStore";
import { AppShell } from "../AppShell";
import appShellSource from "../AppShell.tsx?raw";

// The editor chunk (CodeMirror + the Markdown renderer) is lazy-loaded;
// under a busy full-suite run its first import can exceed the 1s default.
const LAZY_EDITOR_WAIT = { timeout: 5000 };

// Stub the PanelRouter so list panels with their own data fetching don't
// pollute this test. The contract we care about is "the right testid is
// present per mode", which the stub honors.
vi.mock("../PanelRouter", () => ({
  PanelRouter: ({ mode }: { mode: string }) => (
    <div data-testid={`list-panel-${mode}`}>{mode}</div>
  ),
}));

// The timeline fetches its own data; its contents have their own tests.
vi.mock("../../features/calendar/DayTimeline", () => ({
  DayTimeline: ({ onHide }: { onHide?: () => void }) => (
    <div data-testid="day-timeline">
      <button data-testid="day-timeline-hide-stub" onClick={onHide}>
        hide
      </button>
    </div>
  ),
}));

// Workspace IPC is fire-and-forget during mount; mock it to no-op.
vi.mock("../../lib/api/workspace", () => ({
  workspaceGet: vi.fn().mockResolvedValue({ lastOpened: null }),
  workspaceSetLastOpened: vi.fn().mockResolvedValue({ lastOpened: null }),
}));
vi.mock("../../lib/openByRelPath", () => ({
  openByRelPath: vi.fn().mockResolvedValue(undefined),
}));
// Sync status refresh fires on mount + a 30s interval — stub it so the
// store doesn't hit the (unmocked) Tauri invoke.
vi.mock("../../lib/api/sync", () => ({
  syncStatus: vi.fn().mockResolvedValue({
    remoteUrl: null,
    branch: "main",
    ahead: 0,
    behind: 0,
    dirty: false,
    lastSync: null,
  }),
  syncInit: vi.fn(),
  syncSetRemote: vi.fn(),
  syncPull: vi.fn(),
  syncPush: vi.fn(),
  syncNow: vi.fn(),
}));

function resetStores() {
  useUIStore.setState({
    viewMode: "journal",
    listPanelWidth: LIST_PANEL_DEFAULT,
    journalSplitRatio: JOURNAL_SPLIT_DEFAULT,
    dayTimelineWidth: DAY_TIMELINE_DEFAULT,
    dayTimelineHidden: false,
  });
  useVaultStore.setState({
    active: { root: "/tmp/vault", name: "vault", initialized: true },
  });
}

async function waitForShellRefresh() {
  await waitFor(() => {
    expect(screen.getByTestId("status-sync")).toHaveTextContent("Sync: local only");
  });
}

describe("AppShell", () => {
  beforeEach(resetStores);

  it("renders activity bar, list panel, editor panel, and status bar", async () => {
    render(<AppShell />);
    await waitForShellRefresh();

    expect(screen.getByRole("navigation", { name: /activity bar/i })).toBeInTheDocument();
    expect(screen.getByTestId("list-panel")).toBeInTheDocument();
    expect(await screen.findByTestId("editor-panel", {}, LAZY_EDITOR_WAIT)).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
  });

  it("preserves the Editor Panel DOM node across ViewMode changes", async () => {
    render(<AppShell />);
    await waitForShellRefresh();
    const editorBefore = await screen.findByTestId("editor-panel", {}, LAZY_EDITOR_WAIT);

    const sequence: ViewMode[] = ["notes", "calendar", "tags", "sync"];
    for (const mode of sequence) {
      act(() => {
        useUIStore.getState().setViewMode(mode);
      });
      expect(screen.getByTestId(`list-panel-${mode}`)).toBeInTheDocument();
    }

    const editorAfter = screen.getByTestId("editor-panel");
    expect(editorAfter).toBe(editorBefore);
  });

  it("does not import EditorPanel (and so CodeMirror) statically", () => {
    // A static import would put the codemirror chunk in index.html's
    // modulepreload list, i.e. download it on the login screen.
    expect(appShellSource).not.toMatch(
      /^import[^;]*from\s+["']\.\/EditorPanel["']/m,
    );
    expect(appShellSource).toMatch(/import\(\s*["']\.\/EditorPanel["']\s*\)/);
  });

  it("status bar shows the active vault name", async () => {
    render(<AppShell />);
    await waitForShellRefresh();

    expect(screen.getByTestId("status-bar")).toHaveTextContent("vault");
  });

  it("only calendar mode shows the day timeline pane next to the editor", async () => {
    render(<AppShell />);
    await waitForShellRefresh();
    const shell = screen.getByTestId("app-shell");
    const editor = await screen.findByTestId("editor-panel", {}, LAZY_EDITOR_WAIT);

    const others: ViewMode[] = ["journal", "notes", "search", "tags", "sync"];
    for (const mode of others) {
      act(() => useUIStore.getState().setViewMode(mode));
      expect(screen.queryByTestId("day-timeline-pane"), mode).toBeNull();
      expect(screen.queryByTestId("day-timeline-resizer"), mode).toBeNull();
      expect(shell.style.getPropertyValue("--list-panel-width")).toBe(
        `${LIST_PANEL_DEFAULT}px`,
      );
      expect(screen.getByTestId("list-panel-resizer")).toBeInTheDocument();
    }

    act(() => useUIStore.getState().setViewMode("calendar"));
    const pane = screen.getByTestId("day-timeline-pane");
    expect(pane).toHaveStyle({ width: `${DAY_TIMELINE_DEFAULT}px` });
    expect(screen.getByTestId("day-timeline-resizer")).toBeInTheDocument();
    // Left to right inside the editor cell: timeline, then the editor.
    expect(
      pane.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The list panel keeps its drag-sized width and resizer.
    expect(shell.style.getPropertyValue("--list-panel-width")).toBe(
      `${LIST_PANEL_DEFAULT}px`,
    );
    expect(screen.getByTestId("list-panel-resizer")).toBeInTheDocument();

    act(() => useUIStore.getState().setViewMode("notes"));
    expect(screen.queryByTestId("day-timeline-pane")).toBeNull();
    expect(screen.getByTestId("editor-panel")).toBe(editor);
  });

  it("hiding the timeline leaves a toggle that brings it back", async () => {
    useUIStore.setState({ viewMode: "calendar" });
    render(<AppShell />);
    await waitForShellRefresh();
    act(() => screen.getByTestId("day-timeline-hide-stub").click());
    expect(screen.queryByTestId("day-timeline-pane")).toBeNull();
    act(() => screen.getByTestId("day-timeline-show").click());
    expect(screen.getByTestId("day-timeline-pane")).toBeInTheDocument();
  });
});
