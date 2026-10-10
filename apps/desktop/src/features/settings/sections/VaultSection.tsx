import { useCallback, useEffect, useState } from "react";

import { activateVault } from "../../../lib/activateVault";
import {
  vaultInit,
  vaultListKnown,
  vaultPickFolder,
  vaultSetActive,
} from "../../../lib/api/vault";
import {
  formatAppError,
  isAppError,
  type VaultInfo,
} from "../../../lib/types";
import { useAuthStore } from "../../../state/authStore";
import { flushPendingSave, hasPendingSave } from "../../../state/autosave";
import { useEditorStore } from "../../../state/editorStore";
import { useVaultStore } from "../../../state/vaultStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

/**
 * Persist unsaved editor text into the *current* vault before the backend
 * switches away from it. Returns an error message when the save didn't
 * land (it's still queued for retry), in which case the switch must not
 * happen — activating the next vault would discard those edits.
 */
async function saveBeforeSwitch(): Promise<string | null> {
  await flushPendingSave();
  if (!hasPendingSave()) return null;
  const saveError = useEditorStore.getState().saveError;
  return `Your open note couldn't be saved${
    saveError !== null ? ` (${saveError.message})` : ""
  }, so the vault wasn't switched. Fix the problem and try again.`;
}

export function VaultSection() {
  const activeVault = useVaultStore((s) => s.active);
  const logAction = useAuthStore((s) => s.logAction);
  const [knownVaults, setKnownVaults] = useState<VaultInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function switchVault(root: string) {
    if (root === activeVault?.root) return;
    setBusy(true);
    setError(null);
    try {
      const saveProblem = await saveBeforeSwitch();
      if (saveProblem !== null) {
        setError(saveProblem);
        return;
      }
      const next = await vaultSetActive(root);
      activateVault(next);
      void logAction("vault_switch", root).catch(() => {});
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAddVault(intent: "existing" | "new") {
    setBusy(true);
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
      const saveProblem = await saveBeforeSwitch();
      if (saveProblem !== null) {
        setError(saveProblem);
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
      setBusy(false);
    }
  }

  return (
    <div data-testid="settings-vault">
      <h2 className={styles.sectionHeading}>Vault</h2>
      <p className={styles.sectionIntro}>
        The folder your notes live in. naiteh remembers multiple vaults but
        keeps one active at a time.
      </p>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
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
                    disabled={busy || active}
                    aria-current={active ? "true" : undefined}
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
          disabled={busy}
          data-testid="vault-open-existing"
        >
          Open existing vault
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => void handleAddVault("new")}
          disabled={busy}
          data-testid="vault-create-new"
        >
          Create new vault
        </button>
      </SettingItem>
    </div>
  );
}
