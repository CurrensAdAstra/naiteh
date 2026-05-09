import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_FONT_DEFAULT,
  type AppConfig,
  type VaultInfo,
} from "../../../lib/types";
import { useEditorStore } from "../../../state/editorStore";
import { useSettingsStore } from "../../../state/settingsStore";
import { useVaultStore } from "../../../state/vaultStore";
import { SettingsListPanel } from "../SettingsListPanel";

vi.mock("../../../lib/api/vault", () => ({
  vaultListKnown: vi.fn(),
  vaultPickFolder: vi.fn(),
  vaultInit: vi.fn(),
  vaultSetActive: vi.fn(),
}));
vi.mock("../../../lib/api/settings", () => ({
  appConfigSetEditor: vi.fn(),
}));

import { appConfigSetEditor } from "../../../lib/api/settings";
import {
  vaultInit,
  vaultListKnown,
  vaultPickFolder,
  vaultSetActive,
} from "../../../lib/api/vault";

const mockedListKnown = vi.mocked(vaultListKnown);
const mockedPick = vi.mocked(vaultPickFolder);
const mockedInit = vi.mocked(vaultInit);
const mockedSetActive = vi.mocked(vaultSetActive);
const mockedSetEditor = vi.mocked(appConfigSetEditor);

function vault(root: string, name: string, initialized = true): VaultInfo {
  return { root, name, initialized };
}

function configWithEditor(fontSize: number, lineWrapping: boolean): AppConfig {
  return {
    activeVault: "/v",
    knownVaults: ["/v"],
    theme: "light",
    editor: { fontSize, lineWrapping },
    calendar: { subView: "timeline" },
    journal: { splitRatio: 0.5 },
  };
}

describe("SettingsListPanel", () => {
  beforeEach(() => {
    mockedListKnown.mockReset();
    mockedPick.mockReset();
    mockedInit.mockReset();
    mockedSetActive.mockReset();
    mockedSetEditor.mockReset();
    useVaultStore.setState({ active: vault("/v", "v") });
    useSettingsStore.setState({
      config: configWithEditor(EDITOR_FONT_DEFAULT, true),
      loading: false,
    });
    useEditorStore.setState({ open: null });
  });

  it("renders known vaults with the active one badged", async () => {
    mockedListKnown.mockResolvedValue([
      vault("/v", "v"),
      vault("/w", "w"),
    ]);
    render(<SettingsListPanel />);
    await screen.findByTestId("vault-row-/v");
    expect(screen.getByTestId("vault-row-/v")).toHaveTextContent(/active/i);
    expect(screen.getByTestId("vault-row-/w")).not.toHaveTextContent(
      /active/i,
    );
  });

  it("clicking another vault calls vault_set_active and clears the editor", async () => {
    mockedListKnown.mockResolvedValue([
      vault("/v", "v"),
      vault("/w", "w"),
    ]);
    mockedSetActive.mockResolvedValue(vault("/w", "w"));
    useEditorStore.setState({
      open: {
        source: { kind: "note", relPath: "notes/x.md" },
        key: "note:notes/x.md",
        content: "x",
        savedContent: "x",
      },
    });

    const user = userEvent.setup();
    render(<SettingsListPanel />);
    await user.click(await screen.findByTestId("vault-row-/w"));

    await waitFor(() => {
      expect(mockedSetActive).toHaveBeenCalledWith("/w");
      expect(useVaultStore.getState().active?.root).toBe("/w");
      expect(useEditorStore.getState().open).toBeNull();
    });
  });

  it("Open existing rejects an uninitialized folder", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedPick.mockResolvedValue(vault("/x", "x", false));

    const user = userEvent.setup();
    render(<SettingsListPanel />);
    await user.click(await screen.findByTestId("vault-open-existing"));

    expect(
      await screen.findByText(/isn't a naiteh vault/i),
    ).toBeInTheDocument();
    expect(mockedSetActive).not.toHaveBeenCalled();
  });

  it("Create new initializes an empty folder and switches to it", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedPick.mockResolvedValue(vault("/new", "new", false));
    mockedInit.mockResolvedValue(vault("/new", "new", true));
    mockedSetActive.mockResolvedValue(vault("/new", "new", true));

    const user = userEvent.setup();
    render(<SettingsListPanel />);
    await user.click(await screen.findByTestId("vault-create-new"));

    await waitFor(() => {
      expect(mockedInit).toHaveBeenCalledWith("/new");
      expect(mockedSetActive).toHaveBeenCalledWith("/new");
      expect(useVaultStore.getState().active?.root).toBe("/new");
    });
  });

  it("changing font size dispatches app_config_set_editor and updates the store", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedSetEditor.mockResolvedValue(configWithEditor(18, true));
    render(<SettingsListPanel />);

    const input = await screen.findByTestId("font-size-input");
    fireEvent.change(input, { target: { value: "18" } });

    await waitFor(() => {
      expect(mockedSetEditor).toHaveBeenCalledWith(18, true);
      expect(useSettingsStore.getState().config?.editor.fontSize).toBe(18);
    });
  });

  it("font size input clamps below the minimum", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedSetEditor.mockResolvedValue(configWithEditor(8, true));
    render(<SettingsListPanel />);
    const input = await screen.findByTestId("font-size-input");
    fireEvent.change(input, { target: { value: "1" } });
    await waitFor(() =>
      expect(mockedSetEditor).toHaveBeenCalledWith(8, true),
    );
  });

  it("font size input clamps above the maximum", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedSetEditor.mockResolvedValue(configWithEditor(32, true));
    render(<SettingsListPanel />);
    const input = await screen.findByTestId("font-size-input");
    fireEvent.change(input, { target: { value: "999" } });
    await waitFor(() =>
      expect(mockedSetEditor).toHaveBeenCalledWith(32, true),
    );
  });

  it("toggling line wrapping dispatches app_config_set_editor", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedSetEditor.mockResolvedValue(configWithEditor(EDITOR_FONT_DEFAULT, false));
    const user = userEvent.setup();
    render(<SettingsListPanel />);

    const checkbox = await screen.findByTestId("line-wrapping-input");
    await user.click(checkbox);

    await waitFor(() => {
      expect(mockedSetEditor).toHaveBeenCalledWith(EDITOR_FONT_DEFAULT, false);
      expect(useSettingsStore.getState().config?.editor.lineWrapping).toBe(false);
    });
  });

  it("surfaces errors from vault_list_known", async () => {
    mockedListKnown.mockRejectedValue({
      kind: "Io",
      message: "list failed",
    });
    render(<SettingsListPanel />);
    expect(await screen.findByText(/list failed/i)).toBeInTheDocument();
  });
});
