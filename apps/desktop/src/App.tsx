import { useEffect, useState } from "react";

import { FirstRunSetup } from "./features/settings/FirstRunSetup";
import { vaultCurrent } from "./lib/api/vault";
import { formatAppError } from "./lib/types";
import { AppShell } from "./shell/AppShell";
import { useSettingsStore } from "./state/settingsStore";
import { useVaultStore } from "./state/vaultStore";
import styles from "./App.module.css";

export function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useVaultStore((s) => s.active);
  const setActive = useVaultStore((s) => s.setActive);
  const refreshSettings = useSettingsStore((s) => s.refresh);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      vaultCurrent().then((vault) => {
        if (mounted) setActive(vault);
      }),
      refreshSettings(),
    ])
      .catch((e: unknown) => {
        if (mounted) setError(formatAppError(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [setActive, refreshSettings]);

  if (loading) {
    return <div className={styles.center}>Loading…</div>;
  }
  if (error !== null) {
    return (
      <div className={styles.error} role="alert">
        {error}
      </div>
    );
  }
  if (!active) {
    return <FirstRunSetup />;
  }
  // Re-mount the shell when the active vault changes so each panel's
  // useEffect-driven refresh fires against the new vault.
  return <AppShell key={active.root} />;
}
