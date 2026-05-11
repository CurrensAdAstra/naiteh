import { render, screen } from "@testing-library/react";
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

describe("AppShell", () => {
  beforeEach(resetStores);

  it("renders activity bar, list panel, editor panel, and status bar", () => {
    render(<AppShell />);
    expect(screen.getByRole("navigation", { name: /activity bar/i })).toBeInTheDocument();
    expect(screen.getByTestId("list-panel")).toBeInTheDocument();
    expect(screen.getByTestId("editor-panel")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toBeInTheDocument();
  });

  it("preserves the Editor Panel DOM node across ViewMode changes", () => {
    render(<AppShell />);
    const editorBefore = screen.getByTestId("editor-panel");

    const sequence: ViewMode[] = ["notes", "calendar", "tags", "settings"];
    for (const mode of sequence) {
      act(() => {
        useUIStore.getState().setViewMode(mode);
      });
      expect(screen.getByTestId(`list-panel-${mode}`)).toBeInTheDocument();
    }

    const editorAfter = screen.getByTestId("editor-panel");
    expect(editorAfter).toBe(editorBefore);
  });

  it("status bar shows the active vault name", () => {
    render(<AppShell />);
    expect(screen.getByTestId("status-bar")).toHaveTextContent("vault");
  });
});
