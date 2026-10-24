import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_BASE_URLS,
  defaultAiConfig,
  EDITOR_FONT_DEFAULT,
  type AppConfig,
  type NoteMeta,
  type VaultInfo,
} from "../../../lib/types";
import { holdSave, resetAutosaveForTests } from "../../../state/autosave";
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
  appConfigSetAiProvider: vi.fn(),
  appConfigSetEditor: vi.fn(),
}));
vi.mock("../../../lib/api/ai", () => ({
  aiListModels: vi.fn(),
}));
vi.mock("../../../lib/api/auth", () => ({
  authListAuditLogs: vi.fn(),
  authSetLock: vi.fn(),
  authMigrateSecrets: vi.fn(),
  authLogAction: vi.fn().mockResolvedValue(undefined),
  authLock: vi.fn().mockResolvedValue(undefined),
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

import { authListAuditLogs } from "../../../lib/api/auth";
import {
  evernoteImport,
  listenEvernoteImportProgress,
} from "../../../lib/api/evernote";
import { aiListModels } from "../../../lib/api/ai";
import { notesWrite } from "../../../lib/api/notes";
import {
  appConfigSetAi,
  appConfigSetAiProvider,
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
const mockedSetAiProvider = vi.mocked(appConfigSetAiProvider);
const mockedListModels = vi.mocked(aiListModels);
const mockedListKnown = vi.mocked(vaultListKnown);
const mockedPick = vi.mocked(vaultPickFolder);
const mockedInit = vi.mocked(vaultInit);
const mockedSetActive = vi.mocked(vaultSetActive);
const mockedSetEditor = vi.mocked(appConfigSetEditor);
const mockedAuthListAuditLogs = vi.mocked(authListAuditLogs);
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
    ai: (() => {
      const ai = defaultAiConfig();
      ai.providers.openai = { ...ai.providers.openai, hasApiKey };
      ai.addedProviders = hasApiKey ? ["openai"] : [];
      return ai;
    })(),
    appearance: { palette: "default", uiFont: "", editorFont: "" },
    clipping: {
      htmlPaste: "markdown",
      headingStyle: "atx",
      bulletMarker: "-",
      codeBlockStyle: "fenced",
      emphasis: "_",
      strong: "**",
      linkStyle: "inline",
      images: "keep",
      tables: "gfm",
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
      savedVersion: "v1",
    },
  });
}

type Section =
  | "general"
  | "editor"
  | "ai"
  | "import"
  | "security"
  | "audit";

async function gotoSection(user: ReturnType<typeof userEvent.setup>, id: Section) {
  await user.click(await screen.findByTestId(`settings-nav-${id}`));
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
    mockedAuthListAuditLogs.mockReset();
    mockedNotesWrite.mockReset();
    useVaultStore.setState({ active: vault("/v", "v") });
    useAuthStore.setState({
      token: null,
      session: null,
      lockEnabled: false,
      migrationRequired: false,
      ready: true,
      busy: null,
      error: null,
    });
    useSettingsStore.setState({ config: config(), loading: false });
    useEditorStore.setState({ open: null, saveError: null });
    useUIStore.setState({ pendingAction: null, settingsOpen: true });
    mockedAuthListAuditLogs.mockResolvedValue([]);
    mockedSetAi.mockReset();
    mockedSetAi.mockImplementation(async (settings) => {
      const next = structuredClone(useSettingsStore.getState().config ?? config());
      if (settings.addedProviders !== undefined) {
        for (const id of next.ai.addedProviders ?? []) {
          if (!settings.addedProviders.includes(id)) {
            next.ai.providers[id] = { hasApiKey: false, baseUrl: DEFAULT_BASE_URLS[id] };
          }
        }
      }
      next.ai = { ...next.ai, ...settings };
      return next;
    });
    mockedSetAiProvider.mockReset();
    mockedSetAiProvider.mockImplementation(async (update) => {
      const next = structuredClone(useSettingsStore.getState().config ?? config());
      const provider = next.ai.providers[update.provider];
      provider.baseUrl = update.baseUrl ?? provider.baseUrl;
      provider.hasApiKey = update.clearApiKey ? false : update.apiKey !== null || provider.hasApiKey;
      return next;
    });
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
          savedVersion: "v1",
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
        return { meta: noteMeta(relPath), version: "v2" };
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
        return { meta: noteMeta(relPath), version: "v2" };
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

    it("keeps held (conflicting) edits as a .local copy before switching", async () => {
      const order: string[] = [];
      mockedListKnown.mockResolvedValue([vault("/v", "v"), vault("/w", "w")]);
      mockedNotesWrite.mockImplementation(async (relPath, content) => {
        order.push(`write:${relPath}:${content}:${useVaultStore.getState().active?.root}`);
        return { meta: noteMeta(relPath), version: "v2" };
      });
      mockedSetActive.mockImplementation(async (root) => {
        order.push(`setActive:${root}`);
        return vault(root, "w");
      });
      openDirtyNote();
      holdSave("note:notes/x.md");

      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-row-/w"));

      await waitFor(() => expect(useVaultStore.getState().active?.root).toBe("/w"));
      expect(order).toHaveLength(2);
      expect(order[0]).toMatch(/^write:notes\/x\.local-\d{8}-\d{6}\.md:edited:\/v$/);
      expect(order[1]).toBe("setActive:/w");
    });

    it("doesn't switch when held edits couldn't be kept as a copy", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockedListKnown.mockResolvedValue([vault("/v", "v"), vault("/w", "w")]);
      mockedNotesWrite.mockRejectedValue({ kind: "Io", message: "read-only" });
      openDirtyNote();
      holdSave("note:notes/x.md");

      const user = userEvent.setup();
      render(<SettingsModal />);
      await user.click(await screen.findByTestId("vault-row-/w"));

      expect(await screen.findByText(/couldn't be saved.*read-only/i)).toBeInTheDocument();
      expect(mockedSetActive).not.toHaveBeenCalled();
      expect(mockedNotesWrite.mock.calls[0]![0]).toMatch(/\.local-/);
      expect(useEditorStore.getState().open?.content).toBe("edited");
      resetAutosaveForTests();
      errorSpy.mockRestore();
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
    async function addProvider(user: ReturnType<typeof userEvent.setup>, id: string) {
      await user.click(screen.getByTestId("ai-add-provider"));
      await user.selectOptions(screen.getByTestId("ai-provider-choice"), id);
      await user.click(screen.getByTestId("ai-add-provider-confirm"));
      await screen.findByTestId(`ai-provider-save-${id}`);
    }

    it("starts with provider management and keeps connection, model and advanced controls out of the way", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      expect(screen.getByText(/No providers added yet/)).toBeVisible();
      for (const id of ["openai", "anthropic", "gemini", "openrouter", "zai", "ollama", "lmstudio"]) {
        expect(screen.queryByTestId(`ai-provider-${id}`)).toBeNull();
      }
      expect(screen.queryByTestId("ai-key-input-openai")).toBeNull();
      expect(screen.queryByTestId("ai-default-model-input")).toBeNull();
      expect(screen.getByTestId("ai-temperature-input")).not.toBeVisible();
      expect(mockedListModels).not.toHaveBeenCalled();
    });

    it("adds one provider before showing API or web authentication and prevents premature model selection", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await addProvider(user, "openai");
      expect(mockedSetAi).toHaveBeenCalledWith({ ...DEFAULT_AI_SETTINGS, addedProviders: ["openai"] });
      expect(screen.getByRole("radio", { name: /API key/ })).toBeChecked();
      expect(screen.getByRole("radio", { name: /Web sign-in/ })).toBeDisabled();
      expect(screen.getByText("Browser authentication is not connected yet.")).toBeVisible();
      expect(screen.getByTestId("ai-provider-save-openai")).toBeDisabled();
      expect(screen.getByRole("button", { name: "3 Model" })).toBeDisabled();
      expect(screen.queryByTestId("ai-default-model-input")).toBeNull();
      expect(mockedListModels).not.toHaveBeenCalled();
    });

    it("keeps keyboard focus out of collapsed advanced settings", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      act(() => screen.getByTestId("settings-nav-general").focus());
      await user.tab({ shift: true });
      expect(screen.getByText("Advanced chat settings")).toHaveFocus();
      await user.tab();
      expect(screen.getByTestId("settings-nav-general")).toHaveFocus();
    });

    it("sends the API key once, clears the input during saving, then lists only this provider's models", async () => {
      let resolve!: (value: AppConfig) => void;
      mockedSetAiProvider.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      mockedListModels.mockResolvedValue(["openai@gpt-4.1-mini", "openai@gpt-4.1"]);
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await addProvider(user, "openai");
      const keyInput = screen.getByTestId("ai-key-input-openai");
      expect(keyInput).toHaveAttribute("type", "password");
      await user.type(keyInput, "sk-secret-123");
      await user.click(screen.getByTestId("ai-provider-save-openai"));
      expect(keyInput).toHaveValue("");
      expect(keyInput).toBeDisabled();
      expect(mockedSetAiProvider).toHaveBeenCalledTimes(1);
      expect(mockedSetAiProvider).toHaveBeenCalledWith({ provider: "openai", baseUrl: null, apiKey: "sk-secret-123", clearApiKey: false });
      expect(screen.queryByDisplayValue("sk-secret-123")).toBeNull();
      expect(JSON.stringify(useSettingsStore.getState())).not.toContain("sk-secret");
      await act(async () => resolve(config(EDITOR_FONT_DEFAULT, true, true)));
      expect(await screen.findByLabelText("Available models")).toBeVisible();
      expect(mockedListModels).toHaveBeenCalledTimes(1);
      expect(mockedListModels).toHaveBeenCalledWith("openai");
      await user.click(screen.getByRole("button", { name: "Back to connection" }));
      expect(screen.getByTestId("ai-key-status-openai")).toHaveTextContent("Key saved");
      await user.click(screen.getByTestId("ai-replace-key-openai"));
      expect(screen.getByTestId("ai-key-input-openai")).toHaveValue("");
    });

    it("can remove a saved key while retaining the provider", async () => {
      useSettingsStore.setState({ config: config(EDITOR_FONT_DEFAULT, true, true) });
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(screen.getByRole("button", { name: /^OpenAI API key saved/ }));
      await user.click(screen.getByTestId("ai-remove-key-openai"));
      await waitFor(() =>
        expect(mockedSetAiProvider).toHaveBeenCalledWith({
          provider: "openai",
          baseUrl: null,
          apiKey: null,
          clearApiKey: true,
        }),
      );
      expect(await screen.findByTestId("ai-key-input-openai")).toHaveValue("");
      expect(screen.getByTestId("ai-provider-openai")).toBeVisible();
      expect(screen.getByTestId("ai-provider-save-openai")).toBeDisabled();
    });

    it("removes a provider and its key, retaining other registrations across reopening settings", async () => {
      const current = config(EDITOR_FONT_DEFAULT, true, true);
      current.ai.addedProviders = ["openai", "ollama"];
      useSettingsStore.setState({ config: current });
      const user = userEvent.setup();
      const { unmount } = render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(screen.getByTestId("ai-remove-provider-openai"));
      await waitFor(() => expect(screen.queryByTestId("ai-provider-openai")).toBeNull());
      expect(mockedSetAi).toHaveBeenCalledWith({ ...DEFAULT_AI_SETTINGS, addedProviders: ["ollama"] });
      expect(useSettingsStore.getState().config?.ai.providers.openai.hasApiKey).toBe(false);
      unmount();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      expect(screen.queryByTestId("ai-provider-openai")).toBeNull();
      expect(screen.getByTestId("ai-provider-ollama")).toBeVisible();
    });

    it("keeps the provider when saving a removal fails", async () => {
      useSettingsStore.setState({ config: config(EDITOR_FONT_DEFAULT, true, true) });
      mockedSetAi.mockRejectedValueOnce({ kind: "Io", message: "Could not save config" });
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(screen.getByTestId("ai-remove-provider-openai"));
      expect(await screen.findByTestId("ai-settings-error")).toHaveTextContent("Could not save config");
      expect(screen.getByTestId("ai-provider-openai")).toBeVisible();
      expect(useSettingsStore.getState().config?.ai.providers.openai.hasApiKey).toBe(true);
    });

    it("offers only providers that have not been added and can cancel adding", async () => {
      useSettingsStore.setState({ config: config(EDITOR_FONT_DEFAULT, true, true) });
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(screen.getByTestId("ai-add-provider"));
      expect(screen.queryByRole("option", { name: "OpenAI" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByTestId("ai-provider-choice")).toBeNull();
      expect(mockedSetAi).not.toHaveBeenCalled();
    });

    it("configures a local API before selecting and saving that provider's model", async () => {
      mockedListModels.mockResolvedValue(["ollama@llama3.2", "ollama@qwen3"]);
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await addProvider(user, "ollama");
      expect(screen.getByRole("radio", { name: /Local API/ })).toBeChecked();
      expect(screen.queryByTestId("ai-key-input-ollama")).toBeNull();
      expect(mockedListModels).not.toHaveBeenCalled();
      await user.click(screen.getByTestId("ai-provider-save-ollama"));
      await user.selectOptions(await screen.findByLabelText("Available models"), "qwen3");
      expect(mockedListModels).toHaveBeenCalledTimes(1);
      expect(mockedListModels).toHaveBeenCalledWith("ollama");
      await user.click(screen.getByTestId("ai-save-model"));
      await waitFor(() => expect(useSettingsStore.getState().config?.ai.defaultModel).toBe("ollama@qwen3"));
      expect(mockedSetAi).toHaveBeenLastCalledWith({ ...DEFAULT_AI_SETTINGS, defaultModel: "ollama@qwen3" });
      expect(useSettingsStore.getState().config?.ai.addedProviders).toEqual(["ollama"]);
    });

    it("allows a manual model ID when listing models fails", async () => {
      mockedListModels.mockRejectedValue({ kind: "Network", message: "Server is offline" });
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await addProvider(user, "ollama");
      await user.click(screen.getByTestId("ai-provider-save-ollama"));
      expect(await screen.findByRole("alert")).toHaveTextContent("Server is offline");
      await user.type(screen.getByTestId("ai-default-model-input"), "custom-local-model");
      await user.click(screen.getByTestId("ai-save-model"));
      await waitFor(() => expect(useSettingsStore.getState().config?.ai.defaultModel).toBe("ollama@custom-local-model"));
    });

    it("saves advanced defaults separately from provider registration", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await user.click(screen.getByText("Advanced chat settings"));
      const chats = screen.getByTestId("ai-chats-folder-input");
      await user.clear(chats);
      await user.type(chats, "notes/ai");
      await user.click(screen.getByTestId("ai-stream-toggle"));
      await user.click(screen.getByTestId("ai-save"));
      await waitFor(() =>
        expect(mockedSetAi).toHaveBeenCalledWith({
          ...DEFAULT_AI_SETTINGS,
          chatsFolder: "notes/ai",
          stream: false,
        }),
      );
    });

    it("rejects a model belonging to a different provider", async () => {
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "ai");
      await addProvider(user, "ollama");
      await user.click(screen.getByTestId("ai-provider-save-ollama"));
      const model = screen.getByTestId("ai-default-model-input");
      await user.type(model, "openai@gpt-4.1");
      mockedSetAi.mockClear();
      await user.click(screen.getByTestId("ai-save-model"));
      expect(await screen.findByTestId("ai-settings-error")).toHaveTextContent(/model ID for Ollama/);
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

  describe("backup", () => {
    it("lists Backup right after Vault in the navigation", () => {
      render(<SettingsModal />);
      const labels = screen
        .getAllByRole("button")
        .filter((b) => b.getAttribute("data-testid")?.startsWith("settings-nav-"))
        .map((b) => b.textContent);
      expect(labels.slice(0, 2)).toEqual(["Vault", "Backup"]);
    });

    it("opens on the Backup section when the Sync panel asks for it", () => {
      useUIStore.setState({ pendingAction: "showBackup" });
      render(<SettingsModal />);
      expect(screen.getByTestId("settings-nav-backup")).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByTestId("settings-backup")).toBeVisible();
      expect(useUIStore.getState().pendingAction).toBeNull();
    });
  });

  describe("security and local activity", () => {
    it("replaces account and administration navigation without displaying a username", async () => {
      useAuthStore.setState({ token: "local-token", session: { username: "local", role: "Admin" } });
      render(<SettingsModal />);
      await screen.findByTestId("vault-row-/v");
      expect(screen.getByTestId("settings-nav-security")).toBeInTheDocument();
      expect(screen.getByTestId("settings-nav-audit")).toHaveTextContent("Local Activity");
      expect(screen.queryByTestId("settings-nav-account")).toBeNull();
      expect(screen.queryByTestId("settings-nav-accounts")).toBeNull();
      expect(screen.queryByText("Administration")).toBeNull();
      expect(screen.queryByText("local")).toBeNull();
    });

    it("shows historical work events without an identity display", async () => {
      useAuthStore.setState({ token: "local-token", session: { username: "local", role: "Admin" } });
      mockedAuthListAuditLogs.mockResolvedValue([{ timestamp: "2026-05-15T01:00:00Z", username: "legacy-account", action: "note_open", detail: "notes/a.md" }]);
      const user = userEvent.setup();
      render(<SettingsModal />);
      await gotoSection(user, "audit");
      expect(await screen.findByText("note_open")).toBeVisible();
      expect(screen.queryByText("legacy-account")).toBeNull();
      expect(mockedAuthListAuditLogs).toHaveBeenCalledWith("local-token");
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
