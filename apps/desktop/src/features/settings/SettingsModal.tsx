import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import { aiListModels } from "../../lib/api/ai";
import {
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../lib/api/auth";
import {
  evernoteImport,
  listenEvernoteImportProgress,
  type EvernoteImportProgress,
} from "../../lib/api/evernote";
import { appConfigSetAi, appConfigSetEditor } from "../../lib/api/settings";
import {
  aiBaseIsLocal,
  OLLAMA_BASE_URL,
  OPENAI_BASE_URL,
} from "../../lib/aiProvider";
import {
  vaultInit,
  vaultListKnown,
  vaultPickFolder,
  vaultSetActive,
} from "../../lib/api/vault";
import {
  EDITOR_FONT_DEFAULT,
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  formatAppError,
  isAppError,
  type AuditLogEntry,
  type AuthUser,
  type EvernoteImportReport,
  type VaultInfo,
} from "../../lib/types";
import { activateVault } from "../../lib/activateVault";
import { useAuthStore } from "../../state/authStore";
import {
  selectEditorConfig,
  useSettingsStore,
} from "../../state/settingsStore";
import { useUIStore } from "../../state/uiStore";
import { useVaultStore } from "../../state/vaultStore";
import { SettingItem } from "./SettingItem";
import styles from "./SettingsModal.module.css";

type SectionId =
  | "general"
  | "editor"
  | "ai"
  | "import"
  | "accounts"
  | "audit";

interface NavEntry {
  id: SectionId;
  label: string;
  group: "options" | "administration";
}

const NAV: readonly NavEntry[] = [
  { id: "general", label: "Vault", group: "options" },
  { id: "editor", label: "Editor", group: "options" },
  { id: "ai", label: "AI Assist", group: "options" },
  { id: "import", label: "Import from Evernote", group: "options" },
  { id: "accounts", label: "Accounts", group: "administration" },
  { id: "audit", label: "Audit Log", group: "administration" },
];

function formatAuditTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SettingsModal() {
  const session = useAuthStore((s) => s.session);
  const token = useAuthStore((s) => s.token);
  const logAction = useAuthStore((s) => s.logAction);
  const config = useSettingsStore((s) => s.config);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const setSettings = useSettingsStore((s) => s.setConfig);
  const activeVault = useVaultStore((s) => s.active);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  const isAdmin = session?.role === "Admin";
  const [activeSection, setActiveSection] = useState<SectionId>("general");

  const [knownVaults, setKnownVaults] = useState<VaultInfo[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    null | "switch" | "pick" | "editor" | "ai" | "accounts" | "evernote"
  >(null);
  const [lastImportReport, setLastImportReport] =
    useState<EvernoteImportReport | null>(null);
  const [importProgress, setImportProgress] =
    useState<EvernoteImportProgress | null>(null);

  const [aiKeyDraft, setAiKeyDraft] = useState("");
  const [aiModelDraft, setAiModelDraft] = useState("");
  const [aiModelOptions, setAiModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const aiKeyFromConfig = config?.ai.apiKey ?? null;
  const aiModelFromConfig = config?.ai.model ?? null;
  const aiBaseUrl = config?.ai.baseUrl ?? OPENAI_BASE_URL;
  const aiUsingLocal = aiBaseIsLocal(aiBaseUrl);
  useEffect(() => {
    if (aiKeyFromConfig !== null) setAiKeyDraft(aiKeyFromConfig);
    if (aiModelFromConfig !== null) setAiModelDraft(aiModelFromConfig);
  }, [aiKeyFromConfig, aiModelFromConfig]);

  const close = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  // Esc closes the modal, matching the command palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const refreshKnown = useCallback(async () => {
    try {
      setKnownVaults(await vaultListKnown());
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  useEffect(() => {
    void refreshKnown();
  }, [refreshKnown, activeVault?.root]);

  const refreshAdmin = useCallback(async () => {
    if (session?.role !== "Admin" || token === null) {
      setUsers([]);
      setAuditLogs([]);
      return;
    }
    try {
      const [nextUsers, nextLogs] = await Promise.all([
        authListUsers(token),
        authListAuditLogs(token, 100),
      ]);
      setUsers(nextUsers);
      setAuditLogs(nextLogs);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [session, token]);

  useEffect(() => {
    void refreshAdmin();
  }, [refreshAdmin]);

  const switchVault = useCallback(
    async (root: string) => {
      if (root === activeVault?.root) return;
      setBusy("switch");
      setError(null);
      try {
        const next = await vaultSetActive(root);
        activateVault(next);
        void logAction("vault_switch", root).catch(() => {});
      } catch (e) {
        setError(formatAppError(e));
      } finally {
        setBusy(null);
      }
    },
    [activeVault?.root, logAction],
  );

  async function handleAddVault(intent: "existing" | "new") {
    setBusy("pick");
    setError(null);
    try {
      const picked = await vaultPickFolder();
      if (intent === "existing" && !picked.initialized) {
        setError(
          "This folder isn't a naiteh vault. Choose “Create new vault” to initialize it.",
        );
        return;
      }
      if (intent === "new" && picked.initialized) {
        setError(
          "This folder already contains a vault. Choose “Open existing vault” to use it.",
        );
        return;
      }
      const initialized = picked.initialized
        ? picked
        : await vaultInit(picked.root);
      const next = await vaultSetActive(initialized.root);
      activateVault(next);
      void logAction("vault_switch", initialized.root).catch(() => {});
      await refreshKnown();
    } catch (e) {
      if (isAppError(e) && e.kind === "Cancelled") return;
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleEditorChange(fontSize: number, lineWrapping: boolean) {
    setBusy("editor");
    setError(null);
    try {
      setSettings(await appConfigSetEditor(fontSize, lineWrapping));
    } catch (e) {
      setError(formatAppError(e));
      await refreshSettings();
    } finally {
      setBusy(null);
    }
  }

  function onFontSizeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = Number(e.target.value);
    if (!Number.isFinite(raw)) return;
    const clamped = Math.min(
      EDITOR_FONT_MAX,
      Math.max(EDITOR_FONT_MIN, Math.round(raw)),
    );
    void handleEditorChange(clamped, editorConfig.lineWrapping);
  }

  async function handleSaveAi() {
    setBusy("ai");
    setError(null);
    try {
      const next = await appConfigSetAi(
        aiKeyDraft.trim() === "" ? null : aiKeyDraft,
        aiModelDraft,
        null,
      );
      setSettings(next);
    } catch (e) {
      setError(formatAppError(e));
      await refreshSettings();
    } finally {
      setBusy(null);
    }
  }

  async function handleClearAiKey() {
    setBusy("ai");
    setError(null);
    try {
      setSettings(await appConfigSetAi(null, aiModelDraft, null));
      setAiKeyDraft("");
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleUseProvider(baseUrl: string, fallbackModel: string) {
    setBusy("ai");
    setError(null);
    try {
      const model =
        aiModelDraft.trim() === "" ? fallbackModel : aiModelDraft.trim();
      const next = await appConfigSetAi(
        aiKeyDraft.trim() === "" ? null : aiKeyDraft,
        model,
        baseUrl,
      );
      setSettings(next);
      setAiModelDraft(model);
      setAiModelOptions([]);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleLoadModels() {
    setLoadingModels(true);
    setError(null);
    try {
      setAiModelOptions(await aiListModels());
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setLoadingModels(false);
    }
  }

  async function handleSetUserActive(username: string, active: boolean) {
    if (session === null || token === null) return;
    setBusy("accounts");
    setError(null);
    try {
      setUsers(await authSetUserActive(token, username, active));
      setAuditLogs(await authListAuditLogs(token, 100));
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  const handleEvernoteImport = useCallback(async () => {
    setBusy("evernote");
    setError(null);
    setImportProgress(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await listenEvernoteImportProgress(setImportProgress);
      const report = await evernoteImport();
      setLastImportReport(report);
      void logAction(
        "evernote_import",
        `imported=${report.importedCount} failed=${report.failedCount}`,
      ).catch(() => {});
    } catch (e) {
      if (isAppError(e) && e.kind === "Cancelled") return;
      setError(formatAppError(e));
    } finally {
      if (unlisten !== null) unlisten();
      setImportProgress(null);
      setBusy(null);
    }
  }, [logAction]);

  // The native File ▸ Import menu routes here via uiStore: open the modal
  // on the Import section and fire the picker.
  const pendingAction = useUIStore((s) => s.pendingAction);
  const clearPendingAction = useUIStore((s) => s.clearPendingAction);
  useEffect(() => {
    if (pendingAction === "evernoteImport") {
      clearPendingAction();
      setActiveSection("import");
      void handleEvernoteImport();
    }
  }, [pendingAction, clearPendingAction, handleEvernoteImport]);

  const aiKeyConfigured =
    config !== null &&
    config.ai.apiKey !== null &&
    config.ai.apiKey.trim() !== "";

  // Admin sections collapse away for non-admins.
  const visibleNav = NAV.filter(
    (n) => n.group !== "administration" || isAdmin,
  );

  function renderSection() {
    switch (activeSection) {
      case "general":
        return renderVault();
      case "editor":
        return renderEditor();
      case "ai":
        return renderAi();
      case "import":
        return renderImport();
      case "accounts":
        return renderAccounts();
      case "audit":
        return renderAudit();
    }
  }

  function renderVault() {
    return (
      <div data-testid="settings-vault">
        <h2 className={styles.sectionHeading}>Vault</h2>
        <p className={styles.sectionIntro}>
          The folder your notes live in. naiteh remembers multiple vaults but
          keeps one active at a time.
        </p>
        <SettingItem name="Known vaults" stacked>
          {knownVaults.length === 0 ? (
            <p className={styles.emptyNote}>No known vaults yet.</p>
          ) : (
            <ul className={styles.vaultList}>
              {knownVaults.map((vault) => {
                const active = vault.root === activeVault?.root;
                return (
                  <li key={vault.root}>
                    <button
                      type="button"
                      className={`${styles.vaultRow} ${
                        active ? styles.vaultRowActive : ""
                      }`}
                      onClick={() => void switchVault(vault.root)}
                      disabled={busy !== null || active}
                      data-testid={`vault-row-${vault.root}`}
                    >
                      <span className={styles.vaultName}>{vault.name}</span>
                      <span className={styles.vaultRoot}>{vault.root}</span>
                      {active && (
                        <span className={styles.vaultActiveBadge}>Active</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SettingItem>
        <SettingItem
          name="Add a vault"
          description="Open a folder that already holds a vault, or create a new one."
        >
          <button
            type="button"
            className={styles.button}
            onClick={() => void handleAddVault("existing")}
            disabled={busy !== null}
            data-testid="vault-open-existing"
          >
            Open existing vault
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void handleAddVault("new")}
            disabled={busy !== null}
            data-testid="vault-create-new"
          >
            Create new vault
          </button>
        </SettingItem>
      </div>
    );
  }

  function renderEditor() {
    return (
      <div data-testid="settings-editor">
        <h2 className={styles.sectionHeading}>Editor</h2>
        <SettingItem
          name="Font size"
          description={`Editor text size in pixels. Defaults to ${EDITOR_FONT_DEFAULT}.`}
        >
          <input
            id="font-size-input"
            type="number"
            className={styles.numberInput}
            min={EDITOR_FONT_MIN}
            max={EDITOR_FONT_MAX}
            step={1}
            value={editorConfig.fontSize}
            onChange={onFontSizeChange}
            disabled={busy === "editor"}
            data-testid="font-size-input"
          />
        </SettingItem>
        <SettingItem
          name="Line wrapping"
          description="Wrap long lines instead of scrolling horizontally."
        >
          <button
            type="button"
            role="switch"
            aria-checked={editorConfig.lineWrapping}
            aria-label="Line wrapping"
            className={`${styles.toggle} ${
              editorConfig.lineWrapping ? styles.toggleOn : ""
            }`}
            onClick={() =>
              void handleEditorChange(
                editorConfig.fontSize,
                !editorConfig.lineWrapping,
              )
            }
            disabled={busy === "editor"}
            data-testid="line-wrapping-input"
          />
        </SettingItem>
        {config === null && (
          <p className={styles.emptyNote}>Loading current values…</p>
        )}
      </div>
    );
  }

  function renderAi() {
    return (
      <div data-testid="settings-ai">
        <h2 className={styles.sectionHeading}>AI Assist</h2>
        <p className={styles.sectionIntro}>
          AI Assist is the one feature that sends note text out of the app —
          only when you trigger it. Use a hosted API (OpenAI) with a key, or
          run a model locally with{" "}
          <a href="https://ollama.com" target="_blank" rel="noreferrer">
            Ollama
          </a>{" "}
          for fully local, key-free, no-network AI.
        </p>
        <SettingItem
          name="Provider"
          description={
            <>
              Endpoint: <code>{aiBaseUrl}</code>
              {aiUsingLocal &&
                " — make sure Ollama is running (ollama serve) and you've pulled a model."}
            </>
          }
          testId="ai-endpoint"
        >
          <button
            type="button"
            className={`${styles.button} ${
              aiUsingLocal ? styles.buttonPrimary : ""
            }`}
            onClick={() => void handleUseProvider(OLLAMA_BASE_URL, "llama3.2")}
            disabled={busy === "ai"}
            aria-pressed={aiUsingLocal}
            data-testid="ai-use-ollama"
          >
            {aiUsingLocal ? "✓ Local Ollama" : "Use local Ollama"}
          </button>
          <button
            type="button"
            className={`${styles.button} ${
              !aiUsingLocal ? styles.buttonPrimary : ""
            }`}
            onClick={() => void handleUseProvider(OPENAI_BASE_URL, "gpt-4o-mini")}
            disabled={busy === "ai"}
            aria-pressed={!aiUsingLocal}
            data-testid="ai-use-openai"
          >
            {!aiUsingLocal ? "✓ OpenAI" : "Use OpenAI"}
          </button>
        </SettingItem>
        <SettingItem
          name="API key"
          description={
            aiUsingLocal
              ? "Not needed for a local Ollama endpoint."
              : "Stored in your app config; used only for AI Assist calls."
          }
        >
          <input
            id="ai-key-input"
            type="password"
            className={styles.textInput}
            placeholder={
              aiUsingLocal ? "—" : aiKeyConfigured ? "••••••••" : "sk-…"
            }
            value={aiKeyDraft}
            onChange={(e) => setAiKeyDraft(e.target.value)}
            disabled={busy === "ai"}
            autoComplete="off"
            data-testid="ai-key-input"
          />
        </SettingItem>
        <SettingItem
          name="Model"
          description="Load the list from the endpoint, then pick one."
        >
          <input
            id="ai-model-input"
            type="text"
            list="ai-model-options"
            className={styles.textInput}
            value={aiModelDraft}
            onChange={(e) => setAiModelDraft(e.target.value)}
            disabled={busy === "ai"}
            data-testid="ai-model-input"
          />
          <datalist id="ai-model-options">
            {aiModelOptions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </SettingItem>
        <SettingItem
          name="Save"
          description={
            aiModelOptions.length > 0
              ? `${aiModelOptions.length} model${
                  aiModelOptions.length === 1 ? "" : "s"
                } available.`
              : undefined
          }
        >
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => void handleSaveAi()}
            disabled={busy === "ai" || aiModelDraft.trim() === ""}
            data-testid="ai-save"
          >
            {busy === "ai" ? "Saving…" : "Save AI settings"}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void handleLoadModels()}
            disabled={loadingModels || busy === "ai"}
            data-testid="ai-load-models"
          >
            {loadingModels ? "Loading…" : "Load models"}
          </button>
          {aiKeyConfigured && (
            <button
              type="button"
              className={styles.button}
              onClick={() => void handleClearAiKey()}
              disabled={busy === "ai"}
              data-testid="ai-clear-key"
            >
              Clear API key
            </button>
          )}
        </SettingItem>
      </div>
    );
  }

  function renderImport() {
    const withWarnings =
      lastImportReport?.notes.filter((n) => n.warnings.length > 0).length ?? 0;
    return (
      <div data-testid="settings-evernote-import">
        <h2 className={styles.sectionHeading}>Import from Evernote</h2>
        <SettingItem
          name="Choose .enex files"
          description={
            <>
              naiteh converts each note to Markdown under{" "}
              <code>notes/&lt;notebook&gt;/&lt;slug&gt;/</code> with its
              attachments alongside. Your Evernote items stay untouched.
            </>
          }
        >
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() => void handleEvernoteImport()}
            disabled={busy === "evernote" || activeVault === null}
            data-testid="evernote-import-button"
          >
            {busy === "evernote" ? "Importing…" : "Choose .enex files…"}
          </button>
        </SettingItem>
        {busy === "evernote" && importProgress !== null && (
          <p className={styles.progressReport} data-testid="evernote-import-progress">
            Importing {importProgress.fileName} — {importProgress.noteDone}/
            {importProgress.noteTotal} notes
            {importProgress.totalFiles > 1 &&
              ` · file ${importProgress.fileIndex + 1}/${importProgress.totalFiles}`}
          </p>
        )}
        {lastImportReport !== null && (
          <div className={styles.progressReport} data-testid="evernote-import-summary">
            <div>
              Imported {lastImportReport.importedCount} note
              {lastImportReport.importedCount === 1 ? "" : "s"}
              {lastImportReport.failedCount > 0 &&
                `, ${lastImportReport.failedCount} failed`}
              .
            </div>
            {lastImportReport.errors.length > 0 && (
              <ul>
                {lastImportReport.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
            {withWarnings > 0 && (
              <div>
                {withWarnings} note{withWarnings === 1 ? "" : "s"} have import
                warnings — see <code>import_warnings:</code> in the note&rsquo;s
                YAML front matter.
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderAccounts() {
    return (
      <div data-testid="settings-accounts">
        <h2 className={styles.sectionHeading}>Accounts</h2>
        <SettingItem name="Users" stacked>
          {users.length === 0 ? (
            <p className={styles.emptyNote}>No users loaded.</p>
          ) : (
            <ul className={styles.accountList}>
              {users.map((user) => {
                const locked = user.username === "admin";
                return (
                  <li key={user.username} className={styles.accountRow}>
                    <div className={styles.accountMeta}>
                      <span className={styles.accountName}>
                        {user.username}
                      </span>
                      <span className={styles.accountRole}>{user.role}</span>
                      <span
                        className={
                          user.active
                            ? styles.accountActive
                            : styles.accountDisabled
                        }
                      >
                        {user.active ? "Active" : "Disabled"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={styles.button}
                      disabled={busy !== null || locked}
                      onClick={() =>
                        void handleSetUserActive(user.username, !user.active)
                      }
                      data-testid={`account-toggle-${user.username}`}
                    >
                      {user.active ? "Disable" : "Enable"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </SettingItem>
      </div>
    );
  }

  function renderAudit() {
    return (
      <div data-testid="settings-audit">
        <h2 className={styles.sectionHeading}>Audit Log</h2>
        <SettingItem name="Recent activity" stacked>
          {auditLogs.length === 0 ? (
            <p className={styles.emptyNote}>No log entries yet.</p>
          ) : (
            <ul className={styles.auditList}>
              {auditLogs.map((entry, index) => (
                <li
                  key={`${entry.timestamp}-${entry.action}-${index}`}
                  className={styles.auditRow}
                >
                  <span className={styles.auditTime}>
                    {formatAuditTimestamp(entry.timestamp)}
                  </span>
                  <span className={styles.auditAction}>{entry.action}</span>
                  <span className={styles.auditUser}>{entry.username}</span>
                  {entry.detail !== null && (
                    <span className={styles.auditDetail}>{entry.detail}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SettingItem>
      </div>
    );
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        // Click on the backdrop (not the modal) closes.
        if (e.target === e.currentTarget) close();
      }}
      data-testid="settings-modal"
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <nav className={styles.nav} aria-label="Settings sections">
          <div className={styles.navGroupLabel}>Options</div>
          {visibleNav
            .filter((n) => n.group === "options")
            .map((n) => (
              <button
                key={n.id}
                type="button"
                className={`${styles.navItem} ${
                  activeSection === n.id ? styles.navItemActive : ""
                }`}
                aria-current={activeSection === n.id ? "page" : undefined}
                onClick={() => setActiveSection(n.id)}
                data-testid={`settings-nav-${n.id}`}
              >
                {n.label}
              </button>
            ))}
          {isAdmin && (
            <>
              <div className={styles.navGroupLabel}>Administration</div>
              {visibleNav
                .filter((n) => n.group === "administration")
                .map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className={`${styles.navItem} ${
                      activeSection === n.id ? styles.navItemActive : ""
                    }`}
                    aria-current={activeSection === n.id ? "page" : undefined}
                    onClick={() => setActiveSection(n.id)}
                    data-testid={`settings-nav-${n.id}`}
                  >
                    {n.label}
                  </button>
                ))}
            </>
          )}
        </nav>

        <div className={styles.content}>
          <button
            type="button"
            className={styles.close}
            onClick={close}
            aria-label="Close settings"
            data-testid="settings-close"
          >
            <X size={18} strokeWidth={2} />
          </button>
          <div className={styles.scroll}>
            {error !== null && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            {renderSection()}
          </div>
        </div>
      </div>
    </div>
  );
}
