import { useEffect, useState } from "react";

import { LoginScreen } from "./features/auth/LoginScreen";
import { FirstRunSetup } from "./features/settings/FirstRunSetup";
import { vaultCurrent } from "./lib/api/vault";
import { applyAppearance } from "./lib/applyAppearance";
import { DEFAULT_APPEARANCE, formatAppError } from "./lib/types";
import { AppShell } from "./shell/AppShell";
import { useMenuEvents } from "./shell/useMenuEvents";
import { useDraftCloseGuard } from "./shell/useDraftCloseGuard";
import { useAuthStore } from "./state/authStore";
import { hasPendingSave, onSaved } from "./state/autosave";
import { useSettingsStore } from "./state/settingsStore";
import { useVaultStore } from "./state/vaultStore";
import styles from "./App.module.css";

export function App() {
  const [loading, setLoading] = useState(true);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const session = useAuthStore((s) => s.session);
  const ready = useAuthStore((s) => s.ready);
  const busy = useAuthStore((s) => s.busy);
  const draftRecovery = useAuthStore((s) => s.draftRecovery);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const hasAccess = ready && session !== null && draftRecovery === null && busy !== "unlock" && busy !== "migrate";
  const active = useVaultStore((s) => s.active);
  const setActive = useVaultStore((s) => s.setActive);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const appearance = useSettingsStore((s) => s.config?.appearance);
  const closeNotice = useDraftCloseGuard(hasAccess && workspaceReady && !loading && error === null && active !== null && busy === null);
  useMenuEvents();

  // Palette + fonts follow the settings store (Settings > Appearance).
  useEffect(() => {
    applyAppearance(appearance ?? DEFAULT_APPEARANCE);
  }, [appearance]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // Keep save logging active during recovery, before the editor remounts.
  useEffect(() => onSaved((source) => {
    void useAuthStore.getState().logAction(
      source.kind === "note" ? "note_save" : "journal_save",
      source.kind === "note" ? source.relPath : source.date,
    ).catch(() => {});
  }), []);

  useEffect(() => {
    if (!hasAccess) {
      setWorkspaceReady(false);
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    setWorkspaceReady(false);
    setError(null);
    Promise.all([
      vaultCurrent().then((vault) => {
        if (mounted && useAuthStore.getState().checkDraftVault(vault)) setActive(vault);
      }),
      refreshSettings(),
    ])
      .catch((e: unknown) => {
        if (!mounted) return;
        if (hasPendingSave()) {
          useAuthStore.getState().holdDraftRecovery(`Workspace could not be checked: ${formatAppError(e)}. Drafts remain paused and only in memory.`);
        } else {
          setError(formatAppError(e));
        }
      })
      .finally(() => {
        if (mounted) {
          setWorkspaceReady(true);
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [hasAccess, setActive, refreshSettings, loadAttempt]);

  let content;
  if (!hasAccess) content = <LoginScreen />;
  else if (loading || !workspaceReady) content = <div className={styles.center}>Loading…</div>;
  else if (error !== null) {
    content = (
      <div className={styles.error} role="alert">
        {error}
        <button type="button" onClick={() => setLoadAttempt(loadAttempt + 1)}>Retry workspace</button>
      </div>
    );
  } else if (!active) content = <FirstRunSetup />;
  // Re-mount the shell only when the active vault changes.
  else content = <AppShell key={active.root} />;
  return (
    <>
      {closeNotice !== null && <div className={styles.closeNotice} role="status">{closeNotice}</div>}
      {content}
    </>
  );
}
