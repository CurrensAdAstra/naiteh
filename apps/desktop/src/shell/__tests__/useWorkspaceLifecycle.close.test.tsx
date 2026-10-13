import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeHandler: { fn: ((e: { preventDefault: () => void }) => Promise<void>) | null } = {
  fn: null,
};
const destroy = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: vi.fn(async (fn: typeof closeHandler.fn) => {
      closeHandler.fn = fn;
      return () => {};
    }),
    destroy,
  }),
}));
vi.mock("../../lib/api/workspace", () => ({
  workspaceGet: vi.fn().mockResolvedValue({ lastOpened: null }),
  workspaceSetLastOpened: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/vaultWatch", () => ({
  startVaultWatch: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../state/autosave", () => ({
  flushPendingSave: vi.fn(),
}));
vi.mock("../../state/syncStore", () => ({
  useSyncStore: {
    getState: () => ({ refresh: vi.fn().mockResolvedValue(undefined), reset: vi.fn() }),
  },
}));

import { flushPendingSave } from "../../state/autosave";
import { useUIStore } from "../../state/uiStore";
import { useWorkspaceLifecycle } from "../useWorkspaceLifecycle";

const mockedFlush = vi.mocked(flushPendingSave);

describe("window close", () => {
  beforeEach(() => {
    closeHandler.fn = null;
    destroy.mockClear();
    mockedFlush.mockReset();
    useUIStore.setState({ notice: null });
  });

  async function requestClose(): Promise<void> {
    renderHook(() => useWorkspaceLifecycle());
    await waitFor(() => expect(closeHandler.fn).not.toBeNull());
    await closeHandler.fn!({ preventDefault: () => {} });
  }

  it("flushes (leaving) and closes when everything was preserved", async () => {
    mockedFlush.mockResolvedValue({ failedKeys: [], preserved: true });
    await requestClose();
    expect(mockedFlush).toHaveBeenCalledWith({ leaving: true });
    expect(destroy).toHaveBeenCalled();
  });

  it("stays open and explains when held edits couldn't be preserved", async () => {
    mockedFlush.mockResolvedValue({ failedKeys: ["note:a.md"], preserved: false });
    await requestClose();
    expect(destroy).not.toHaveBeenCalled();
    expect(useUIStore.getState().notice).toMatch(/Not closing/);
  });
});
