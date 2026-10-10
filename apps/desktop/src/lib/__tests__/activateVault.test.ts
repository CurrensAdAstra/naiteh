import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/notes", () => ({
  notesWrite: vi.fn(),
}));

import { activateVault } from "../activateVault";
import { notesWrite } from "../api/notes";
import { resetAutosaveForTests, scheduleSave } from "../../state/autosave";
import {
  beginOpen,
  isLatestOpen,
  useEditorStore,
} from "../../state/editorStore";
import { useVaultStore } from "../../state/vaultStore";

const mockedWrite = vi.mocked(notesWrite);

describe("activateVault", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedWrite.mockReset();
    useEditorStore.setState({ open: null });
    useVaultStore.setState({ active: null });
  });

  it("closes the open editor and sets the active vault in one step", () => {
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/x.md" },
        key: "note:notes/x.md",
        content: "x",
        savedContent: "x",
      },
    });

    const next = { root: "/w", name: "w", initialized: true };
    activateVault(next);

    expect(useEditorStore.getState().open).toBeNull();
    expect(useVaultStore.getState().active).toEqual(next);
  });

  it("drops pending autosaves (they belong to the previous vault) and cancels in-flight opens", async () => {
    vi.useFakeTimers();
    try {
      useVaultStore.setState({
        active: { root: "/v", name: "v", initialized: true },
      });
      scheduleSave({ kind: "note", relPath: "notes/x.md" }, "edit");
      const ticket = beginOpen();
      activateVault({ root: "/w", name: "w", initialized: true });
      expect(isLatestOpen(ticket)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(mockedWrite).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
