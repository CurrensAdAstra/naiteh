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
  appConfigSetAi: vi.fn(),
  appConfigSetEditor: vi.fn(),
}));
vi.mock("../../../lib/api/auth", () => ({
  authListAuditLogs: vi.fn(),
  authListUsers: vi.fn(),
  authSetUserActive: vi.fn(),
}));
vi.mock("../../../lib/api/evernote", () => ({
  evernoteImport: vi.fn(),
  listenEvernoteImportProgress: vi
    .fn()
    .mockResolvedValue(() => {}),
}));

import {
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../../lib/api/auth";
import {
  evernoteImport,
  listenEvernoteImportProgress,
} from "../../../lib/api/evernote";
import { appConfigSetEditor } from "../../../lib/api/settings";
import {
  vaultInit,
  vaultListKnown,
  vaultPickFolder,
  vaultSetActive,
} from "../../../lib/api/vault";
import { useAuthStore } from "../../../state/authStore";

const mockedListKnown = vi.mocked(vaultListKnown);
const mockedPick = vi.mocked(vaultPickFolder);
const mockedInit = vi.mocked(vaultInit);
const mockedSetActive = vi.mocked(vaultSetActive);
const mockedSetEditor = vi.mocked(appConfigSetEditor);
const mockedAuthListUsers = vi.mocked(authListUsers);
const mockedAuthListAuditLogs = vi.mocked(authListAuditLogs);
const mockedAuthSetUserActive = vi.mocked(authSetUserActive);
const mockedEvernoteImport = vi.mocked(evernoteImport);
const mockedListenProgress = vi.mocked(listenEvernoteImportProgress);

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
    ai: {
      apiKey: null,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
  };
}

describe("SettingsListPanel", () => {
  beforeEach(() => {
    mockedListKnown.mockReset();
    mockedPick.mockReset();
    mockedInit.mockReset();
    mockedSetActive.mockReset();
    mockedSetEditor.mockReset();
    mockedAuthListUsers.mockReset();
    mockedAuthListAuditLogs.mockReset();
    mockedAuthSetUserActive.mockReset();
    useVaultStore.setState({ active: vault("/v", "v") });
    useAuthStore.setState({ session: null });
    useSettingsStore.setState({
      config: configWithEditor(EDITOR_FONT_DEFAULT, true),
      loading: false,
    });
    useEditorStore.setState({ open: null });
    mockedAuthListUsers.mockResolvedValue([]);
    mockedAuthListAuditLogs.mockResolvedValue([]);
    mockedEvernoteImport.mockReset();
    mockedListenProgress.mockReset();
    mockedListenProgress.mockResolvedValue(() => {});
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

  it("renders the Evernote import section with an enabled button", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    render(<SettingsListPanel />);
    const button = await screen.findByTestId("evernote-import-button");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent(/choose .enex/i);
  });

  it("clicking Import calls evernote_import and shows the summary", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedEvernoteImport.mockResolvedValue({
      importedCount: 3,
      skippedCount: 0,
      failedCount: 0,
      notes: [
        { sourceTitle: "A", relPath: "notes/x/a/index.md", warnings: [] },
        {
          sourceTitle: "B",
          relPath: "notes/x/b/index.md",
          warnings: ["dropped resource (application/vnd.evernote.ink)"],
        },
        { sourceTitle: "C", relPath: "notes/x/c/index.md", warnings: [] },
      ],
      errors: [],
    });
    const user = userEvent.setup();
    render(<SettingsListPanel />);

    await user.click(await screen.findByTestId("evernote-import-button"));

    await waitFor(() => {
      expect(mockedEvernoteImport).toHaveBeenCalled();
    });
    const summary = await screen.findByTestId("evernote-import-summary");
    expect(summary).toHaveTextContent("3"); // imported count
    expect(summary).toHaveTextContent(/import warnings/i);
  });

  it("shows per-note progress while an import is in flight", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    // The listener fires a progress payload as soon as it's registered.
    mockedListenProgress.mockImplementation((handler) => {
      handler({
        fileIndex: 0,
        totalFiles: 1,
        fileName: "Books.enex",
        noteDone: 3,
        noteTotal: 10,
      });
      return Promise.resolve(() => {});
    });
    // Keep the import pending so the progress line stays mounted.
    let resolveImport: (r: unknown) => void = () => {};
    mockedEvernoteImport.mockReturnValue(
      new Promise((res) => {
        resolveImport = res as (r: unknown) => void;
      }) as ReturnType<typeof evernoteImport>,
    );

    const user = userEvent.setup();
    render(<SettingsListPanel />);
    await user.click(await screen.findByTestId("evernote-import-button"));

    const progress = await screen.findByTestId("evernote-import-progress");
    expect(progress).toHaveTextContent(/Books\.enex/);
    expect(progress).toHaveTextContent(/3\/10/);

    // Settle the import; progress should disappear.
    resolveImport({
      importedCount: 10,
      skippedCount: 0,
      failedCount: 0,
      notes: [],
      errors: [],
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("evernote-import-progress"),
      ).not.toBeInTheDocument();
    });
  });

  it("Cancelled errors from the picker are swallowed silently", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedEvernoteImport.mockRejectedValue({
      kind: "Cancelled",
      message: "Cancelled",
    });
    const user = userEvent.setup();
    render(<SettingsListPanel />);

    await user.click(await screen.findByTestId("evernote-import-button"));

    await waitFor(() => {
      expect(mockedEvernoteImport).toHaveBeenCalled();
    });
    // No summary, no error banner — the section just goes back to idle.
    expect(screen.queryByTestId("evernote-import-summary")).toBeNull();
  });

  it("shows admin account management and audit logs", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedAuthListUsers.mockResolvedValue([
      { username: "admin", role: "Admin", active: true },
      { username: "mgkyung", role: "User", active: true },
    ]);
    mockedAuthListAuditLogs.mockResolvedValue([
      {
        timestamp: "2026-05-15T01:00:00Z",
        username: "admin",
        action: "login_success",
        detail: null,
      },
    ]);
    useAuthStore.setState({
      token: "deadbeef",
      session: { username: "admin", role: "Admin" },
    });

    render(<SettingsListPanel />);

    expect(await screen.findByTestId("settings-accounts")).toHaveTextContent(
      "mgkyung",
    );
    expect(screen.getByTestId("settings-audit")).toHaveTextContent(
      "login_success",
    );
  });

  it("admin can disable a standard account", async () => {
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedAuthListUsers.mockResolvedValue([
      { username: "admin", role: "Admin", active: true },
      { username: "mgkyung", role: "User", active: true },
    ]);
    mockedAuthSetUserActive.mockResolvedValue([
      { username: "admin", role: "Admin", active: true },
      { username: "mgkyung", role: "User", active: false },
    ]);
    mockedAuthListAuditLogs.mockResolvedValue([]);
    useAuthStore.setState({
      token: "deadbeef",
      session: { username: "admin", role: "Admin" },
    });

    const user = userEvent.setup();
    render(<SettingsListPanel />);
    await user.click(await screen.findByTestId("account-toggle-mgkyung"));

    await waitFor(() => {
      expect(mockedAuthSetUserActive).toHaveBeenCalledWith(
        "deadbeef",
        "mgkyung",
        false,
      );
    });
  });
});
