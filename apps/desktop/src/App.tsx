import { useEffect, useState } from "react";

import { FirstRunSetup } from "./features/settings/FirstRunSetup";
import { vaultCurrent } from "./lib/api/vault";
import { formatAppError } from "./lib/types";
import { AppShell } from "./shell/AppShell";
import { useVaultStore } from "./state/vaultStore";
import styles from "./App.module.css";

export function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useVaultStore((s) => s.active);
  const setActive = useVaultStore((s) => s.setActive);

  useEffect(() => {
    let mounted = true;
    vaultCurrent()
      .then((vault) => {
        if (mounted) setActive(vault);
      })
      .catch((e: unknown) => {
        if (mounted) setError(formatAppError(e));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [setActive]);

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
  return <AppShell />;
}
