import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
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

  it("calendar mode gives the list panel a 70% proportional track and hides the resizer", async () => {
    render(<AppShell />);
    await waitForShellRefresh();

    // Non-calendar view: fixed px width + draggable resizer.
    const shell = screen.getByTestId("app-shell");
    expect(shell.style.getPropertyValue("--list-panel-width")).toBe(
      `${LIST_PANEL_DEFAULT}px`,
    );
    expect(screen.getByTestId("list-panel-resizer")).toBeInTheDocument();

    act(() => {
      useUIStore.getState().setViewMode("calendar");
    });

    const track = shell.style.getPropertyValue("--list-panel-width");
    expect(track).toContain("* 0.7");
    expect(track).not.toContain("--ai-panel-width");
    // The drag handle is gone — the width is proportional, not drag-sized.
    expect(screen.queryByTestId("list-panel-resizer")).not.toBeInTheDocument();
  });
});
