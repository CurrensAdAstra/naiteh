import { useCallback, useEffect, useState } from "react";

import { appConfigSetEditor } from "../../lib/api/settings";
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
  type VaultInfo,
} from "../../lib/types";
import { useEditorStore } from "../../state/editorStore";
import {
  selectEditorConfig,
  useSettingsStore,
} from "../../state/settingsStore";
import { useVaultStore } from "../../state/vaultStore";
import styles from "./SettingsListPanel.module.css";

export function SettingsListPanel() {
  const config = useSettingsStore((s) => s.config);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const setSettings = useSettingsStore((s) => s.setConfig);
  const activeVault = useVaultStore((s) => s.active);
  const setActiveVault = useVaultStore((s) => s.setActive);
  const closeOpenNote = useEditorStore((s) => s.closeNote);

  const [knownVaults, setKnownVaults] = useState<VaultInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "switch" | "pick" | "editor">(null);

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
      } catch (e) {
        setError(formatAppError(e));
      } finally {
        setBusy(null);
      }
    },
    [activeVault?.root, closeOpenNote, setActiveVault],
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
      </div>
    </div>
  );
}
