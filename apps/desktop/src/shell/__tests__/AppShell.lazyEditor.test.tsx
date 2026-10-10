import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useVaultStore } from "../../state/vaultStore";
import { AppShell } from "../AppShell";

// Kept in its own file: React.lazy caches the resolved module for the
// lifetime of the module graph, so the fallback is only observable on the
// very first render of AppShell in a fresh (per-file) graph.

vi.mock("../EditorPanel", () => ({
  EditorPanel: () => <div data-testid="editor-panel">editor</div>,
}));
vi.mock("../PanelRouter", () => ({
  PanelRouter: ({ mode }: { mode: string }) => (
    <div data-testid={`list-panel-${mode}`}>{mode}</div>
  ),
}));
vi.mock("../../lib/api/workspace", () => ({
  workspaceGet: vi.fn().mockResolvedValue({ lastOpened: null }),
  workspaceSetLastOpened: vi.fn().mockResolvedValue({ lastOpened: null }),
}));
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

describe("AppShell lazy editor", () => {
  it("shows a lightweight placeholder until the editor chunk resolves", async () => {
    useVaultStore.setState({
      active: { root: "/tmp/vault", name: "vault", initialized: true },
    });
    render(<AppShell />);

    // The rest of the shell renders immediately; only the editor waits.
    expect(screen.getByTestId("list-panel")).toBeInTheDocument();
    const placeholder = screen.getByTestId("editor-panel-loading");
    expect(placeholder).toHaveAttribute("role", "status");
    expect(screen.queryByTestId("editor-panel")).not.toBeInTheDocument();

    expect(await screen.findByTestId("editor-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-panel-loading")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("status-sync")).toHaveTextContent(
        "Sync: local only",
      );
    });
  });
});
