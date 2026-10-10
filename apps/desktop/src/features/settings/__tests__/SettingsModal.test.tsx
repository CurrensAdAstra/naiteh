import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EDITOR_FONT_DEFAULT,
  type AppConfig,
  type NoteMeta,
  type VaultInfo,
} from "../../../lib/types";
import { resetAutosaveForTests } from "../../../state/autosave";
import { useEditorStore } from "../../../state/editorStore";
import { useSettingsStore } from "../../../state/settingsStore";
import { useUIStore } from "../../../state/uiStore";
import { useVaultStore } from "../../../state/vaultStore";
import { SettingsModal } from "../SettingsModal";

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
vi.mock("../../../lib/api/ai", () => ({
  aiImprove: vi.fn(),
  aiListModels: vi.fn(),
}));
vi.mock("../../../lib/api/auth", () => ({
  authListAuditLogs: vi.fn(),
  authListUsers: vi.fn(),
  authSetUserActive: vi.fn(),
  authCreateUser: vi.fn(),
  authChangePassword: vi.fn(),
  authLogAction: vi.fn().mockResolvedValue(undefined),
  authLogout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../lib/api/evernote", () => ({
  evernoteImport: vi.fn(),
  listenEvernoteImportProgress: vi
    .fn()
    .mockResolvedValue(() => {}),
}));
vi.mock("../../../lib/api/notes", () => ({
  notesWrite: vi.fn(),
}));
vi.mock("../../../lib/api/journal", () => ({
  journalSave: vi.fn(),
}));

import {
  authChangePassword,
  authCreateUser,
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../../lib/api/auth";
import {
  evernoteImport,
  listenEvernoteImportProgress,
} from "../../../lib/api/evernote";
import { aiListModels } from "../../../lib/api/ai";
import { notesWrite } from "../../../lib/api/notes";
import {
  appConfigSetAi,
  appConfigSetEditor,
} from "../../../lib/api/settings";
import {
  vaultInit,
  vaultListKnown,
  vaultPickFolder,
  vaultSetActive,
} from "../../../lib/api/vault";
import { useAuthStore } from "../../../state/authStore";

const mockedSetAi = vi.mocked(appConfigSetAi);
const mockedListModels = vi.mocked(aiListModels);
const mockedListKnown = vi.mocked(vaultListKnown);
const mockedPick = vi.mocked(vaultPickFolder);
const mockedInit = vi.mocked(vaultInit);
const mockedSetActive = vi.mocked(vaultSetActive);
const mockedSetEditor = vi.mocked(appConfigSetEditor);
const mockedAuthListUsers = vi.mocked(authListUsers);
const mockedAuthListAuditLogs = vi.mocked(authListAuditLogs);
const mockedAuthSetUserActive = vi.mocked(authSetUserActive);
const mockedAuthCreateUser = vi.mocked(authCreateUser);
const mockedAuthChangePassword = vi.mocked(authChangePassword);
const mockedEvernoteImport = vi.mocked(evernoteImport);
const mockedListenProgress = vi.mocked(listenEvernoteImportProgress);
const mockedNotesWrite = vi.mocked(notesWrite);

function vault(root: string, name: string, initialized = true): VaultInfo {
  return { root, name, initialized };
}

function config(
  fontSize = EDITOR_FONT_DEFAULT,
  lineWrapping = true,
  hasApiKey = false,
): AppConfig {
  return {
    activeVault: "/v",
    knownVaults: ["/v"],
    theme: "light",
    editor: { fontSize, lineWrapping },
    calendar: { subView: "timeline" },
    journal: { splitRatio: 0.5 },
    ai: {
      hasApiKey,
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
    },
  };
}

function noteMeta(relPath: string): NoteMeta {
  return { path: "", relPath, title: "", tags: [], mtime: 0, size: 0, pinned: false };
}

function openDirtyNote() {
  useEditorStore.setState({
    open: {
      source: { kind: "note", relPath: "notes/x.md" },
      key: "note:notes/x.md",
      content: "edited",
      savedContent: "x",
    },
  });
}

type Section =
  | "general"
  | "editor"
  | "ai"
  | "import"
  | "account"
  | "accounts"
  | "audit";

async function gotoSection(user: ReturnType<typeof userEvent.setup>, id: Section) {
  await user.click(await screen.findByTestId(`settings-nav-${id}`));
}

function signInAsAdmin() {
  useAuthStore.setState({
    token: "deadbeef",
    session: { username: "admin", role: "Admin" },
  });
}

describe("SettingsModal", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedListKnown.mockReset();
    mockedListKnown.mockResolvedValue([vault("/v", "v")]);
    mockedPick.mockReset();
    mockedInit.mockReset();
    mockedSetActive.mockReset();
    mockedSetEditor.mockReset();
    mockedAuthListUsers.mockReset();
    mockedAuthListAuditLogs.mockReset();
    mockedAuthSetUserActive.mockReset();
    mockedAuthCreateUser.mockReset();
    mockedAuthChangePassword.mockReset();
    mockedNotesWrite.mockReset();
    useVaultStore.setState({ active: vault("/v", "v") });
    useAuthStore.setState({
      token: null,
      session: null,
      pendingPasswordChange: null,
    });
    useSettingsStore.setState({ config: config(), loading: false });
    useEditorStore.setState({ open: null, saveError: null });
    useUIStore.setState({ pendingAction: null, settingsOpen: true });
    mockedAuthListUsers.mockResolvedValue([]);
    mockedAuthListAuditLogs.mockResolvedValue([]);
    mockedSetAi.mockReset();
    mockedSetAi.mockResolvedValue(config());
    mockedListModels.mockReset();
    mockedListModels.mockResolvedValue([]);
    mockedEvernoteImport.mockReset();
    mockedListenProgress.mockReset();
    mockedListenProgress.mockResolvedValue(() => {});
  });

  describe("vault", () => {
    it("renders known vaults with the active one badged", async () => {
      mockedListKnown.mockResolvedValue([vault("/v", "v"), vault("/w", "w")]);
      render(<SettingsModal />);
      await screen.findByTestId("vault-row-/v");
      expect(screen.getByTestId("vault-row-/v")).toHaveTextContent(/active/i);
      expect(screen.getByTestId("vault-row-/w")).not.toHaveTextContent(/active/i);
    });

    it("clicking another vault calls vault_set_active and clears the editor", async () => {
      mockedListKnown.mockResolvedValue([vault("/v", "v"), vault("/w", "w")]);
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
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-row-/w"));

      await waitFor(() => {
        expect(mockedSetActive).toHaveBeenCalledWith("/w");
        expect(useVaultStore.getState().active?.root).toBe("/w");
        expect(useEditorStore.getState().open).toBeNull();
      });
    });

    it("saves pending edits into the old vault before switching", async () => {
      const order: string[] = [];
      mockedListKnown.mockResolvedValue([vault("/v", "v"), vault("/w", "w")]);
      mockedNotesWrite.mockImplementation(async (relPath, content) => {
        order.push(`write:${relPath}:${content}:${useVaultStore.getState().active?.root}`);
        return noteMeta(relPath);
      });
      mockedSetActive.mockImplementation(async (root) => {
        order.push(`setActive:${root}`);
        return vault(root, "w");
      });
      openDirtyNote();

      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-row-/w"));

      await waitFor(() => expect(useVaultStore.getState().active?.root).toBe("/w"));
      expect(order).toEqual(["write:notes/x.md:edited:/v", "setActive:/w"]);
    });

    it("flushes before vault_init when creating a vault", async () => {
      const order: string[] = [];
      mockedPick.mockResolvedValue(vault("/new", "new", false));
      mockedNotesWrite.mockImplementation(async (relPath) => {
        order.push("write");
        return noteMeta(relPath);
      });
      mockedInit.mockImplementation(async (root) => {
        order.push("init");
        return vault(root, "new", true);
      });
      mockedSetActive.mockImplementation(async (root) => {
        order.push("setActive");
        return vault(root, "new", true);
      });
      openDirtyNote();

      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-create-new"));

      await waitFor(() => expect(order).toEqual(["write", "init", "setActive"]));
    });

    it("doesn't switch when the pending edits couldn't be saved", async () => {
      mockedListKnown.mockResolvedValue([vault("/v", "v"), vault("/w", "w")]);
      mockedNotesWrite.mockRejectedValue({ kind: "Io", message: "disk full" });
      openDirtyNote();

      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-row-/w"));

      expect(await screen.findByText(/couldn't be saved.*disk full/i)).toBeInTheDocument();
      expect(mockedSetActive).not.toHaveBeenCalled();
      expect(useVaultStore.getState().active?.root).toBe("/v");
      expect(useEditorStore.getState().open?.content).toBe("edited");
    });

    it("Open existing rejects an uninitialized folder", async () => {
      mockedPick.mockResolvedValue(vault("/x", "x", false));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-open-existing"));
      expect(await screen.findByText(/isn't a naiteh vault/i)).toBeInTheDocument();
      expect(mockedSetActive).not.toHaveBeenCalled();
    });

    it("Create new initializes an empty folder and switches to it", async () => {
      mockedPick.mockResolvedValue(vault("/new", "new", false));
      mockedInit.mockResolvedValue(vault("/new", "new", true));
      mockedSetActive.mockResolvedValue(vault("/new", "new", true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-create-new"));
      await waitFor(() => {
        expect(mockedInit).toHaveBeenCalledWith("/new");
        expect(mockedSetActive).toHaveBeenCalledWith("/new");
        expect(useVaultStore.getState().active?.root).toBe("/new");
      });
    });

    it("surfaces errors from vault_list_known", async () => {
      mockedListKnown.mockRejectedValue({ kind: "Io", message: "list failed" });
      render(<SettingsModal />);
      expect(await screen.findByText(/list failed/i)).toBeInTheDocument();
    });
  });

  describe("editor", () => {
    it("changing font size dispatches app_config_set_editor and updates the store", async () => {
      mockedSetEditor.mockResolvedValue(config(18, true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      fireEvent.change(await screen.findByTestId("font-size-input"), {
        target: { value: "18" },
      });
      await waitFor(() => {
        expect(mockedSetEditor).toHaveBeenCalledWith(18, true);
        expect(useSettingsStore.getState().config?.editor.fontSize).toBe(18);
      });
    });

    it("font size input clamps below the minimum", async () => {
      mockedSetEditor.mockResolvedValue(config(8, true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      fireEvent.change(await screen.findByTestId("font-size-input"), {
        target: { value: "1" },
      });
      await waitFor(() => expect(mockedSetEditor).toHaveBeenCalledWith(8, true));
    });

    it("font size input clamps above the maximum", async () => {
      mockedSetEditor.mockResolvedValue(config(32, true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      fireEvent.change(await screen.findByTestId("font-size-input"), {
        target: { value: "999" },
      });
      await waitFor(() => expect(mockedSetEditor).toHaveBeenCalledWith(32, true));
    });

    it("typing \"16\" saves 16 once — never the intermediate 1 → 8", async () => {
      // Keep the IPC pending to prove the field stays editable meanwhile.
      let resolveSave: (c: AppConfig) => void = () => {};
      mockedSetEditor.mockReturnValue(
        new Promise<AppConfig>((res) => {
          resolveSave = res;
        }),
      );
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      const input = await screen.findByTestId("font-size-input");

      await user.clear(input);
      await user.type(input, "16");
      expect(input).toHaveValue(16);
      expect(mockedSetEditor).not.toHaveBeenCalled();

      await user.keyboard("{Enter}");
      expect(mockedSetEditor).toHaveBeenCalledTimes(1);
      expect(mockedSetEditor).toHaveBeenCalledWith(16, true);
      expect(input).toBeEnabled();
      expect(input).toHaveValue(16);

      // Blurring after Enter doesn't send it again.
      await user.tab();
      await act(async () => {
        resolveSave(config(16, true));
      });
      expect(mockedSetEditor).toHaveBeenCalledTimes(1);
      expect(useSettingsStore.getState().config?.editor.fontSize).toBe(16);
    });

    it("commits on blur and restores the stored value for empty input", async () => {
      mockedSetEditor.mockResolvedValue(config(20, true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      const input = await screen.findByTestId("font-size-input");

      await user.clear(input);
      await user.tab();
      expect(input).toHaveValue(EDITOR_FONT_DEFAULT);
      expect(mockedSetEditor).not.toHaveBeenCalled();

      await user.type(input, "{Backspace}{Backspace}20");
      await user.tab();
      await waitFor(() => expect(mockedSetEditor).toHaveBeenCalledWith(20, true));
      expect(mockedSetEditor).toHaveBeenCalledTimes(1);
    });

    it("labels the font size input and the line-wrapping switch", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      expect(screen.getByLabelText("Font size")).toBe(
        screen.getByTestId("font-size-input"),
      );
      expect(screen.getByRole("switch", { name: "Line wrapping" })).toBe(
        screen.getByTestId("line-wrapping-input"),
      );
    });

    it("toggling line wrapping dispatches app_config_set_editor", async () => {
      mockedSetEditor.mockResolvedValue(config(EDITOR_FONT_DEFAULT, false));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "editor");
      await user.click(await screen.findByTestId("line-wrapping-input"));
      await waitFor(() => {
        expect(mockedSetEditor).toHaveBeenCalledWith(EDITOR_FONT_DEFAULT, false);
        expect(useSettingsStore.getState().config?.editor.lineWrapping).toBe(false);
      });
    });
  });

  describe("AI", () => {
    it("'Use local Ollama' switches the endpoint to the Ollama URL", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(await screen.findByTestId("ai-use-ollama"));
      await waitFor(() => {
        expect(mockedSetAi).toHaveBeenCalledWith({
          apiKey: null,
          clearApiKey: false,
          model: "gpt-4o-mini", // keeps the existing model (non-empty)
          baseUrl: "http://localhost:11434/v1",
        });
      });
    });

    it("'Load models' populates the model picker options", async () => {
      mockedListModels.mockResolvedValue(["llama3.2", "qwen2.5"]);
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(await screen.findByTestId("ai-load-models"));
      await waitFor(() => expect(mockedListModels).toHaveBeenCalled());
      expect(await screen.findByText(/2 models available/i)).toBeInTheDocument();
    });

    it("the API key is sent once and never kept in state", async () => {
      mockedSetAi.mockResolvedValue(config(EDITOR_FONT_DEFAULT, true, true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");

      const keyInput = screen.getByLabelText("API key");
      expect(keyInput).toHaveValue("");
      expect(keyInput).toHaveAttribute("type", "password");
      await user.type(keyInput, "sk-secret-123");
      await user.click(screen.getByTestId("ai-save"));

      await waitFor(() => {
        expect(mockedSetAi).toHaveBeenCalledWith({
          apiKey: "sk-secret-123",
          clearApiKey: false,
          model: "gpt-4o-mini",
          baseUrl: "https://api.openai.com/v1",
        });
      });
      expect(await screen.findByTestId("ai-key-status")).toHaveTextContent(
        "Key saved",
      );
      expect(screen.queryByTestId("ai-key-input")).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue("sk-secret-123")).toBeNull();
      expect(JSON.stringify(useSettingsStore.getState())).not.toContain(
        "sk-secret",
      );

      // "Replace key" starts from an empty field, not the old key.
      await user.click(screen.getByTestId("ai-replace-key"));
      expect(screen.getByTestId("ai-key-input")).toHaveValue("");
    });

    it("saving without typing a key keeps the stored one", async () => {
      useSettingsStore.setState({ config: config(EDITOR_FONT_DEFAULT, true, true) });
      mockedSetAi.mockResolvedValue(config(EDITOR_FONT_DEFAULT, true, true));
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      expect(screen.getByTestId("ai-key-status")).toHaveTextContent("Key saved");
      await user.click(screen.getByTestId("ai-save"));
      await waitFor(() =>
        expect(mockedSetAi).toHaveBeenCalledWith(
          expect.objectContaining({ apiKey: null, clearApiKey: false }),
        ),
      );
    });

    it("'Remove key' asks the backend to clear it", async () => {
      useSettingsStore.setState({ config: config(EDITOR_FONT_DEFAULT, true, true) });
      mockedSetAi.mockResolvedValue(config());
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(screen.getByTestId("ai-remove-key"));
      await waitFor(() =>
        expect(mockedSetAi).toHaveBeenCalledWith({
          apiKey: null,
          clearApiKey: true,
          model: "gpt-4o-mini",
          baseUrl: null,
        }),
      );
      expect(await screen.findByTestId("ai-key-input")).toHaveValue("");
    });

    it("rejects a plain-http remote endpoint before calling the backend", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      const url = screen.getByLabelText("Endpoint URL");
      await user.clear(url);
      await user.type(url, "http://llm.example.com/v1");
      await user.click(screen.getByTestId("ai-save"));
      expect(await screen.findByTestId("ai-settings-error")).toHaveTextContent(
        /only allowed for localhost/i,
      );
      expect(mockedSetAi).not.toHaveBeenCalled();
    });
  });

  describe("import", () => {
    it("renders the Evernote import section with an enabled button", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "import");
      const button = await screen.findByTestId("evernote-import-button");
      expect(button).toBeEnabled();
      expect(button).toHaveTextContent(/choose .enex/i);
    });

    it("clicking Import calls evernote_import and shows the summary", async () => {
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
      render(<SettingsModal />);
      await gotoSection(user, "import");
      await user.click(await screen.findByTestId("evernote-import-button"));
      await waitFor(() => expect(mockedEvernoteImport).toHaveBeenCalled());
      const summary = await screen.findByTestId("evernote-import-summary");
      expect(summary).toHaveTextContent("3");
      expect(summary).toHaveTextContent(/import warnings/i);
    });

    it("shows per-note progress while an import is in flight", async () => {
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
      let resolveImport: (r: unknown) => void = () => {};
      mockedEvernoteImport.mockReturnValue(
        new Promise((res) => {
          resolveImport = res as (r: unknown) => void;
        }) as ReturnType<typeof evernoteImport>,
      );

      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "import");
      await user.click(await screen.findByTestId("evernote-import-button"));

      const progress = await screen.findByTestId("evernote-import-progress");
      expect(progress).toHaveTextContent(/Books\.enex/);
      expect(progress).toHaveTextContent(/3\/10/);

      resolveImport({
        importedCount: 10,
        skippedCount: 0,
        failedCount: 0,
        notes: [],
        errors: [],
      });
      await waitFor(() => {
        expect(screen.queryByTestId("evernote-import-progress")).not.toBeInTheDocument();
      });
    });

    it("Cancelled errors from the picker are swallowed silently", async () => {
      mockedEvernoteImport.mockRejectedValue({ kind: "Cancelled", message: "Cancelled" });
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "import");
      await user.click(await screen.findByTestId("evernote-import-button"));
      await waitFor(() => expect(mockedEvernoteImport).toHaveBeenCalled());
      expect(screen.queryByTestId("evernote-import-summary")).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("runs the import when uiStore queues it (from the File menu)", async () => {
      mockedEvernoteImport.mockResolvedValue({
        importedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        notes: [{ sourceTitle: "A", relPath: "notes/x/a/index.md", warnings: [] }],
        errors: [],
      });
      useUIStore.setState({ pendingAction: "evernoteImport" });
      render(<SettingsModal />);
      await waitFor(() => expect(mockedEvernoteImport).toHaveBeenCalled());
      expect(mockedEvernoteImport).toHaveBeenCalledTimes(1);
      expect(useUIStore.getState().pendingAction).toBeNull();
      // The modal switched to the Import section.
      expect(screen.getByTestId("settings-nav-import")).toHaveAttribute(
        "aria-current",
        "page",
      );
    });
  });

  describe("account (any user)", () => {
    beforeEach(() => {
      useAuthStore.setState({
        token: "usertoken",
        session: { username: "mgkyung", role: "User" },
      });
    });

    it("non-admins see Account but no administration sections", async () => {
      render(<SettingsModal />);
      await screen.findByTestId("vault-row-/v");
      expect(screen.getByTestId("settings-nav-account")).toBeInTheDocument();
      expect(screen.queryByTestId("settings-nav-accounts")).toBeNull();
      expect(screen.queryByTestId("settings-nav-audit")).toBeNull();
    });

    it("changes the password", async () => {
      mockedAuthChangePassword.mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "account");

      await user.type(screen.getByLabelText("Current password"), "old-password");
      await user.type(screen.getByLabelText("New password"), "new-password-1");
      await user.type(screen.getByLabelText("Confirm new password"), "new-password-1");
      await user.click(screen.getByTestId("settings-change-password-submit"));

      await waitFor(() =>
        expect(mockedAuthChangePassword).toHaveBeenCalledWith(
          "usertoken",
          "old-password",
          "new-password-1",
        ),
      );
      expect(
        await screen.findByTestId("settings-change-password-success"),
      ).toHaveTextContent(/password changed/i);
      expect(screen.getByLabelText("Current password")).toHaveValue("");
    });

    it("validates before sending and shows backend errors", async () => {
      mockedAuthChangePassword.mockRejectedValue({
        kind: "Unauthorized",
        message: "current password is incorrect",
      });
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "account");

      await user.type(screen.getByLabelText("Current password"), "old-password");
      await user.type(screen.getByLabelText("New password"), "new-password-1");
      await user.type(screen.getByLabelText("Confirm new password"), "new-password-2");
      await user.click(screen.getByTestId("settings-change-password-submit"));
      expect(
        await screen.findByTestId("settings-change-password-error"),
      ).toHaveTextContent(/don't match/i);
      expect(mockedAuthChangePassword).not.toHaveBeenCalled();

      await user.clear(screen.getByLabelText("Confirm new password"));
      await user.type(screen.getByLabelText("Confirm new password"), "new-password-1");
      await user.click(screen.getByTestId("settings-change-password-submit"));
      expect(
        await screen.findByText(/current password is incorrect/i),
      ).toBeInTheDocument();
      // A wrong password is a form error, not a sign-out.
      expect(useAuthStore.getState().session).not.toBeNull();
    });
  });

  describe("administration", () => {
    it("shows admin account management and audit logs", async () => {
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
      signInAsAdmin();

      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "accounts");
      expect(await screen.findByTestId("settings-accounts")).toHaveTextContent(
        "mgkyung",
      );
      await gotoSection(user, "audit");
      expect(await screen.findByTestId("settings-audit")).toHaveTextContent(
        "login_success",
      );
    });

    it("admin can disable a standard account", async () => {
      mockedAuthListUsers.mockResolvedValue([
        { username: "admin", role: "Admin", active: true },
        { username: "mgkyung", role: "User", active: true },
      ]);
      mockedAuthSetUserActive.mockResolvedValue([
        { username: "admin", role: "Admin", active: true },
        { username: "mgkyung", role: "User", active: false },
      ]);
      signInAsAdmin();

      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "accounts");
      await user.click(await screen.findByTestId("account-toggle-mgkyung"));
      await waitFor(() =>
        expect(mockedAuthSetUserActive).toHaveBeenCalledWith(
          "deadbeef",
          "mgkyung",
          false,
        ),
      );
      expect(screen.getByTestId("account-toggle-admin")).toBeDisabled();
    });

    it("creates a user and shows the updated list", async () => {
      mockedAuthListUsers.mockResolvedValue([
        { username: "admin", role: "Admin", active: true },
      ]);
      mockedAuthCreateUser.mockResolvedValue([
        { username: "admin", role: "Admin", active: true },
        { username: "bob.smith", role: "Admin", active: true },
      ]);
      signInAsAdmin();

      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "accounts");
      const form = await screen.findByTestId("settings-create-user-form");

      await user.type(within(form).getByLabelText("Username"), "bob.smith");
      await user.type(within(form).getByLabelText("Password"), "password-123");
      await user.type(within(form).getByLabelText("Confirm password"), "password-123");
      await user.selectOptions(within(form).getByLabelText("Role"), "Admin");
      await user.click(within(form).getByTestId("settings-create-user-submit"));

      await waitFor(() =>
        expect(mockedAuthCreateUser).toHaveBeenCalledWith(
          "deadbeef",
          "bob.smith",
          "password-123",
          "Admin",
        ),
      );
      expect(await screen.findByTestId("account-toggle-bob.smith")).toBeInTheDocument();
      expect(screen.getByTestId("settings-create-user-success")).toHaveTextContent(
        "bob.smith",
      );
      expect(within(form).getByLabelText("Username")).toHaveValue("");
    });

    it("validates new users client-side and shows backend errors", async () => {
      mockedAuthCreateUser.mockRejectedValue({
        kind: "Conflict",
        message: "user already exists",
      });
      signInAsAdmin();
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "accounts");
      const form = await screen.findByTestId("settings-create-user-form");

      await user.type(within(form).getByLabelText("Username"), "bad name");
      await user.type(within(form).getByLabelText("Password"), "password-123");
      await user.type(within(form).getByLabelText("Confirm password"), "password-123");
      await user.click(within(form).getByTestId("settings-create-user-submit"));
      expect(
        await within(form).findByTestId("settings-create-user-error"),
      ).toHaveTextContent(/only contain letters/i);
      expect(mockedAuthCreateUser).not.toHaveBeenCalled();

      await user.clear(within(form).getByLabelText("Username"));
      await user.type(within(form).getByLabelText("Username"), "carol");
      await user.click(within(form).getByTestId("settings-create-user-submit"));
      expect(await within(form).findByText(/user already exists/i)).toBeInTheDocument();
    });
  });

  describe("dialog accessibility", () => {
    it("is a labelled modal dialog that takes focus on open", async () => {
      render(<SettingsModal />);
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(document.activeElement).toBe(screen.getByTestId("settings-nav-general"));
      await screen.findByTestId("vault-row-/v");
    });

    it("Escape closes the modal", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await screen.findByTestId("vault-row-/v");
      await user.keyboard("{Escape}");
      expect(useUIStore.getState().settingsOpen).toBe(false);
    });

    it("traps Tab / Shift+Tab inside the dialog", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await screen.findByTestId("vault-row-/v");
      const first = screen.getByTestId("settings-nav-general");
      const last = screen.getByTestId("vault-create-new");

      last.focus();
      await user.tab();
      expect(document.activeElement).toBe(first);

      await user.tab({ shift: true });
      expect(document.activeElement).toBe(last);

      // Controls of hidden sections are skipped.
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(screen.getByTestId("vault-open-existing"));
    });

    it("returns focus to the opener on close", async () => {
      const opener = document.createElement("button");
      opener.textContent = "open settings";
      document.body.appendChild(opener);
      opener.focus();

      const { unmount } = render(<SettingsModal />);
      await screen.findByTestId("vault-row-/v");
      expect(document.activeElement).not.toBe(opener);
      unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    });
  });
});
