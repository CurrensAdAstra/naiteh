import { useEffect, useState } from "react";

import { AdminDashboard } from "./features/auth/AdminDashboard";
import { LoginScreen } from "./features/auth/LoginScreen";
import { FirstRunSetup } from "./features/settings/FirstRunSetup";
import { vaultCurrent } from "./lib/api/vault";
import { formatAppError } from "./lib/types";
import { AppShell } from "./shell/AppShell";
import { useAuthStore } from "./state/authStore";
import { useSettingsStore } from "./state/settingsStore";
import { useVaultStore } from "./state/vaultStore";
import styles from "./App.module.css";

function isAdminPath(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.pathname.replace(/\/+$/, "") === "/admin";
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const session = useAuthStore((s) => s.session);
  const setSession = useAuthStore((s) => s.setSession);
  const active = useVaultStore((s) => s.active);
  const setActive = useVaultStore((s) => s.setActive);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const adminPath = isAdminPath();

  useEffect(() => {
    if (session === null) {
      setLoadedFor(null);
      setLoading(false);
      return;
    }
    if (adminPath && session.role === "Admin") {
      setLoadedFor(session.username);
      setError(null);
      setLoading(false);
      return;
    }
    let mounted = true;
    setLoading(true);
    setLoadedFor(null);
    setError(null);
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
        if (mounted) {
          setLoadedFor(session.username);
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [adminPath, session, setActive, refreshSettings]);

  if (session === null) {
    return <LoginScreen onLogin={setSession} />;
  }
  if (adminPath && session.role === "Admin") {
    return <AdminDashboard />;
  }
  if (loading) {
    return <div className={styles.center}>Loading…</div>;
  }
  if (loadedFor !== session.username) {
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
