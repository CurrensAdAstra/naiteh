import { beforeEach, describe, expect, it } from "vitest";

import { activateVault } from "../activateVault";
import { useEditorStore } from "../../state/editorStore";
import { useVaultStore } from "../../state/vaultStore";

describe("activateVault", () => {
  beforeEach(() => {
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
});
