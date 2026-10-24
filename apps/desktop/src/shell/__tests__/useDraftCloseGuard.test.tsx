import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const closeHandler: { fn: ((e: { preventDefault: () => void }) => Promise<void>) | null } = {
  fn: null,
};
const destroy = vi.fn().mockResolvedValue(undefined);
const subscribe = vi.fn(async (fn: typeof closeHandler.fn) => {
  closeHandler.fn = fn;
  return () => {};
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: subscribe,
    destroy,
  }),
}));
vi.mock("../../state/autosave", () => ({
  flushPendingSave: vi.fn(),
  hasPendingSave: vi.fn(),
}));

import { flushPendingSave, hasPendingSave } from "../../state/autosave";
import { useDraftCloseGuard } from "../useDraftCloseGuard";

const mockedFlush = vi.mocked(flushPendingSave);

describe("window close", () => {
  beforeEach(() => {
    closeHandler.fn = null;
    destroy.mockReset().mockResolvedValue(undefined);
    subscribe.mockClear();
    mockedFlush.mockReset();
    vi.mocked(hasPendingSave).mockReturnValue(true);
  });

  async function requestClose(canFlush = true) {
    const hook = renderHook(() => useDraftCloseGuard(canFlush));
    await waitFor(() => expect(closeHandler.fn).not.toBeNull());
    await act(async () => closeHandler.fn!({ preventDefault: () => {} }));
    return hook;
  }

  it("flushes (leaving) and closes when everything was preserved", async () => {
    mockedFlush.mockResolvedValue({ failedKeys: [], preserved: true });
    await requestClose();
    expect(mockedFlush).toHaveBeenCalledWith({ leaving: true });
    expect(destroy).toHaveBeenCalled();
  });

  it.each([true, false])("stays open on any failed save or preservation (preserved: %s)", async (preserved) => {
    mockedFlush.mockResolvedValue({ failedKeys: ["note:a.md"], preserved });
    const { result } = await requestClose();
    expect(destroy).not.toHaveBeenCalled();
    expect(result.current).toMatch(/Not closing/);
  });

  it("protects drafts when access or workspace loading prevents a safe flush", async () => {
    const { result } = await requestClose(false);
    expect(mockedFlush).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(result.current).toMatch(/only in memory/);
  });

  it("keeps the same native listener across loading and shell transitions", async () => {
    const { rerender } = renderHook(({ ready }) => useDraftCloseGuard(ready), { initialProps: { ready: false } });
    await waitFor(() => expect(closeHandler.fn).not.toBeNull());
    rerender({ ready: true });
    rerender({ ready: false });
    expect(subscribe).toHaveBeenCalledTimes(1);
    await act(async () => closeHandler.fn!({ preventDefault: () => {} }));
    expect(mockedFlush).not.toHaveBeenCalled();
  });

  it("allows a normal native close when no drafts remain", async () => {
    vi.mocked(hasPendingSave).mockReturnValue(false);
    const preventDefault = vi.fn();
    renderHook(() => useDraftCloseGuard(false));
    await waitFor(() => expect(closeHandler.fn).not.toBeNull());
    await closeHandler.fn!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("keeps protection installed if destroying the window fails", async () => {
    destroy.mockRejectedValue(new Error("window busy"));
    mockedFlush.mockResolvedValue({ failedKeys: [], preserved: true });
    const { result } = await requestClose();
    expect(result.current).toMatch(/window busy/);
    await act(async () => closeHandler.fn!({ preventDefault: () => {} }));
    expect(destroy).toHaveBeenCalledTimes(2);
  });
});
