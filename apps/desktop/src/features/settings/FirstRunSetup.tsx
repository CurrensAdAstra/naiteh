import { useState } from "react";

import { vaultInit, vaultPickFolder, vaultSetActive } from "../../lib/api/vault";
import { formatAppError, isAppError } from "../../lib/types";
import { useVaultStore } from "../../state/vaultStore";
import styles from "./FirstRunSetup.module.css";

type Intent = "existing" | "new";

export function FirstRunSetup() {
  const setActive = useVaultStore((s) => s.setActive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePick(intent: Intent) {
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
          "This folder is already a naiteh vault. Choose “Open existing vault” to use it.",
        );
        return;
      }
      const initialized = picked.initialized ? picked : await vaultInit(picked.root);
      const active = await vaultSetActive(initialized.root);
      setActive(active);
    } catch (e) {
      if (isAppError(e) && e.kind === "Cancelled") return;
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.root} data-testid="first-run-setup">
      <h1 className={styles.title}>Welcome to naiteh</h1>
      <p className={styles.subtitle}>Choose where your notes will live.</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          onClick={() => void handlePick("new")}
          disabled={busy}
        >
          Create new vault
        </button>
        <button
          type="button"
          className={`${styles.button} ${styles.secondary}`}
          onClick={() => void handlePick("existing")}
          disabled={busy}
        >
          Open existing vault
        </button>
      </div>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
