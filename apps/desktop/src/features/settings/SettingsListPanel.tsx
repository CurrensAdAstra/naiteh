import { useCallback, useEffect, useState } from "react";

import {
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../lib/api/auth";
import { evernoteImport } from "../../lib/api/evernote";
import { appConfigSetAi, appConfigSetEditor } from "../../lib/api/settings";
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
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import {
  selectEditorConfig,
  useSettingsStore,
} from "../../state/settingsStore";
import { useVaultStore } from "../../state/vaultStore";
import styles from "./SettingsListPanel.module.css";

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

export function SettingsListPanel() {
  const session = useAuthStore((s) => s.session);
  const logAction = useAuthStore((s) => s.logAction);
  const config = useSettingsStore((s) => s.config);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const setSettings = useSettingsStore((s) => s.setConfig);
  const activeVault = useVaultStore((s) => s.active);
  const setActiveVault = useVaultStore((s) => s.setActive);
  const closeOpenNote = useEditorStore((s) => s.closeNote);

  const [knownVaults, setKnownVaults] = useState<VaultInfo[]>([]);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    | null
    | "switch"
    | "pick"
    | "editor"
    | "ai"
    | "accounts"
    | "evernote"
  >(null);
  const [lastImportReport, setLastImportReport] =
    useState<EvernoteImportReport | null>(null);

  // AI section local form state, synced from authoritative config below.
  const [aiKeyDraft, setAiKeyDraft] = useState("");
  const [aiModelDraft, setAiModelDraft] = useState("");
  const aiKeyFromConfig = config?.ai.apiKey ?? null;
  const aiModelFromConfig = config?.ai.model ?? null;
  useEffect(() => {
    if (aiKeyFromConfig !== null) setAiKeyDraft(aiKeyFromConfig);
    if (aiModelFromConfig !== null) setAiModelDraft(aiModelFromConfig);
  }, [aiKeyFromConfig, aiModelFromConfig]);

  const refreshKnown = useCallback(async () => {
    try {
      const list = await vaultListKnown();
      setKnownVaults(list);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, []);

  useEffect(() => {
    void refreshKnown();
  }, [refreshKnown, activeVault?.root]);

  const refreshAdmin = useCallback(async () => {
    if (session?.role !== "Admin") {
      setUsers([]);
      setAuditLogs([]);
      return;
    }
    try {
      const [nextUsers, nextLogs] = await Promise.all([
        authListUsers(session.username),
        authListAuditLogs(session.username, 100),
      ]);
      setUsers(nextUsers);
      setAuditLogs(nextLogs);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [session]);

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
        // Editor's open file points into the previous vault; clear it.
        closeOpenNote();
        setActiveVault(next);
        void logAction("vault_switch", root).catch(() => {});
      } catch (e) {
        setError(formatAppError(e));
      } finally {
        setBusy(null);
      }
    },
    [activeVault?.root, closeOpenNote, logAction, setActiveVault],
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
      closeOpenNote();
      setActiveVault(next);
      void logAction("vault_switch", initialized.root).catch(() => {});
      await refreshKnown();
    } catch (e) {
      if (isAppError(e) && e.kind === "Cancelled") return;
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleEditorChange(
    fontSize: number,
    lineWrapping: boolean,
  ) {
    setBusy("editor");
    setError(null);
    try {
      const next = await appConfigSetEditor(fontSize, lineWrapping);
      setSettings(next);
    } catch (e) {
      setError(formatAppError(e));
      // Re-pull authoritative state on failure.
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

  function onLineWrappingChange(e: React.ChangeEvent<HTMLInputElement>) {
    void handleEditorChange(editorConfig.fontSize, e.target.checked);
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
      const next = await appConfigSetAi(null, aiModelDraft, null);
      setSettings(next);
      setAiKeyDraft("");
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleSetUserActive(username: string, active: boolean) {
    if (session === null) return;
    setBusy("accounts");
    setError(null);
    try {
      const next = await authSetUserActive(session.username, username, active);
      setUsers(next);
      const nextLogs = await authListAuditLogs(session.username, 100);
      setAuditLogs(nextLogs);
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  async function handleEvernoteImport() {
    setBusy("evernote");
    setError(null);
    try {
      const report = await evernoteImport();
      setLastImportReport(report);
      void logAction(
        "evernote_import",
        `imported=${report.importedCount} failed=${report.failedCount}`,
      ).catch(() => {});
    } catch (e) {
      // Cancelling the file picker isn't an error worth surfacing.
      if (isAppError(e) && e.kind === "Cancelled") return;
      setError(formatAppError(e));
    } finally {
      setBusy(null);
    }
  }

  const aiKeyConfigured =
    config !== null &&
    config.ai.apiKey !== null &&
    config.ai.apiKey.trim() !== "";

  return (
    <div className={styles.panel} data-testid="list-panel-settings">
      <header className={styles.header}>
        <h2 className={styles.title}>Settings</h2>
      </header>
      <div className={styles.body}>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <section className={styles.section} data-testid="settings-vault">
          <h3 className={styles.sectionTitle}>Vault</h3>
          {knownVaults.length === 0 ? (
            <p className={styles.helpText}>No known vaults yet.</p>
          ) : (
            <ul className={styles.vaultList}>
              {knownVaults.map((vault) => {
                const isActive = vault.root === activeVault?.root;
                return (
                  <li key={vault.root}>
                    <button
                      type="button"
                      className={`${styles.vaultRow} ${
                        isActive ? styles.vaultRowActive : ""
                      }`}
                      onClick={() => void switchVault(vault.root)}
                      disabled={busy !== null || isActive}
                      data-testid={`vault-row-${vault.root}`}
                    >
                      <span className={styles.vaultName}>{vault.name}</span>
                      <span className={styles.vaultRoot}>{vault.root}</span>
                      {isActive && (
                        <span className={styles.vaultActiveBadge}>Active</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className={styles.actionGroup}>
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
          </div>
        </section>

        <section className={styles.section} data-testid="settings-editor">
          <h3 className={styles.sectionTitle}>Editor</h3>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="font-size-input">
              Font size
            </label>
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
          </div>
          <div className={styles.fieldRow}>
            <label
              className={styles.fieldLabel}
              htmlFor="line-wrapping-input"
            >
              Line wrapping
            </label>
            <input
              id="line-wrapping-input"
              type="checkbox"
              className={styles.checkbox}
              checked={editorConfig.lineWrapping}
              onChange={onLineWrappingChange}
              disabled={busy === "editor"}
              data-testid="line-wrapping-input"
            />
          </div>
          <p className={styles.helpText}>
            Defaults to {EDITOR_FONT_DEFAULT}px with line wrapping on.
            {config === null && " Loading current values…"}
          </p>
        </section>

        <section className={styles.section} data-testid="settings-ai">
          <h3 className={styles.sectionTitle}>AI Assist</h3>
          <p className={styles.helpText}>
            naiteh stays local-first. AI Assist is the one feature that
            sends note text to a third-party provider — only when you
            explicitly trigger it, using the API key you store here.
            Default endpoint is OpenAI&rsquo;s Chat Completions API.
          </p>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="ai-key-input">
              API key
            </label>
            <input
              id="ai-key-input"
              type="password"
              className={styles.numberInput}
              style={{ width: "180px", textAlign: "left" }}
              placeholder={aiKeyConfigured ? "••••••••" : "sk-…"}
              value={aiKeyDraft}
              onChange={(e) => setAiKeyDraft(e.target.value)}
              disabled={busy === "ai"}
              autoComplete="off"
              data-testid="ai-key-input"
            />
          </div>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel} htmlFor="ai-model-input">
              Model
            </label>
            <input
              id="ai-model-input"
              type="text"
              className={styles.numberInput}
              style={{ width: "180px", textAlign: "left" }}
              value={aiModelDraft}
              onChange={(e) => setAiModelDraft(e.target.value)}
              disabled={busy === "ai"}
              data-testid="ai-model-input"
            />
          </div>
          <div className={styles.actionGroup}>
            <button
              type="button"
              className={styles.button}
              onClick={() => void handleSaveAi()}
              disabled={busy === "ai" || aiModelDraft.trim() === ""}
              data-testid="ai-save"
            >
              {busy === "ai" ? "Saving…" : "Save AI settings"}
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
          </div>
        </section>

        <section
          className={styles.section}
          data-testid="settings-evernote-import"
        >
          <h3 className={styles.sectionTitle}>Import from Evernote</h3>
          <p className={styles.helpText}>
            Pick one or more <code>.enex</code> exports — naiteh converts each
            note to Markdown and places it under{" "}
            <code>notes/&lt;notebook&gt;/&lt;slug&gt;/</code> with its
            attachments alongside. Your original Evernote items stay untouched.
          </p>
          <div className={styles.actionGroup}>
            <button
              type="button"
              className={styles.button}
              onClick={() => void handleEvernoteImport()}
              disabled={busy === "evernote" || activeVault === null}
              data-testid="evernote-import-button"
            >
              {busy === "evernote" ? "Importing…" : "Choose .enex files…"}
            </button>
          </div>
          {lastImportReport !== null && (
            <div data-testid="evernote-import-summary">
              <dl className={styles.metaRow}>
                <dt>Imported</dt>
                <dd>{lastImportReport.importedCount}</dd>
              </dl>
              {lastImportReport.failedCount > 0 && (
                <dl className={styles.metaRow}>
                  <dt>Failed</dt>
                  <dd>{lastImportReport.failedCount}</dd>
                </dl>
              )}
              {lastImportReport.errors.length > 0 && (
                <ul className={styles.helpText}>
                  {lastImportReport.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
              {(() => {
                const withWarnings = lastImportReport.notes.filter(
                  (n) => n.warnings.length > 0,
                ).length;
                if (withWarnings === 0) return null;
                return (
                  <p className={styles.helpText}>
                    {withWarnings} note{withWarnings === 1 ? "" : "s"} have
                    import warnings — see <code>import_warnings:</code> in the
                    note&rsquo;s YAML front matter.
                  </p>
                );
              })()}
            </div>
          )}
        </section>

        {session?.role === "Admin" && (
          <>
            <section className={styles.section} data-testid="settings-accounts">
              <h3 className={styles.sectionTitle}>Accounts</h3>
              {users.length === 0 ? (
                <p className={styles.helpText}>No users loaded.</p>
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
                          <span className={styles.accountRole}>
                            {user.role}
                          </span>
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
                            void handleSetUserActive(
                              user.username,
                              !user.active,
                            )
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
            </section>

            <section className={styles.section} data-testid="settings-audit">
              <h3 className={styles.sectionTitle}>Audit Log</h3>
              {auditLogs.length === 0 ? (
                <p className={styles.helpText}>No log entries yet.</p>
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
                      <span className={styles.auditAction}>
                        {entry.action}
                      </span>
                      <span className={styles.auditUser}>
                        {entry.username}
                      </span>
                      {entry.detail !== null && (
                        <span className={styles.auditDetail}>
                          {entry.detail}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
