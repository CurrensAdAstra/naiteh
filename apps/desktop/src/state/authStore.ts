import { create } from "zustand";

import {
  authBootstrap, authLock, authLogAction, authMigrate, authSetLock, authUnlock,
} from "../lib/api/auth";
import { setUnauthorizedHandler } from "../lib/api/invoke";
import { vaultCurrent, vaultSetActive } from "../lib/api/vault";
import { formatAppError, type AuthAccess, type AuthSession, type VaultInfo } from "../lib/types";
import { flushPendingSave, hasPendingSave, pendingSaveVaultRoot, setAutosaveAccessPaused } from "./autosave";
import { cancelPendingOpens, useEditorStore } from "./editorStore";
import { useUIStore } from "./uiStore";
import { useVaultStore } from "./vaultStore";

type AccessOperation = "bootstrap" | "unlock" | "migrate" | "configure" | "lock" | "recover";

interface AuthState {
  token: string | null;
  /** Internal local session, never an identity to display in the UI. */
  session: AuthSession | null;
  /** Null until a successful bootstrap, not an assumed disabled lock. */
  lockEnabled: boolean | null;
  migrationRequired: boolean;
  ready: boolean;
  busy: AccessOperation | null;
  error: string | null;
  accessNotice: string | null;
  /** Backend access may be unlocked, but drafts must be recovered before mounting a workspace. */
  draftRecovery: { vaultRoot: string | null } | null;
  bootstrap: () => Promise<boolean>;
  unlock: (password: string) => Promise<boolean>;
  migrate: (username: string, password: string, newPassword: string) => Promise<boolean>;
  setLock: (enabled: boolean, currentPassword: string | null, newPassword: string | null) => Promise<boolean>;
  lock: () => Promise<boolean>;
  returnToDraftVault: () => Promise<boolean>;
  holdDraftRecovery: (message: string) => void;
  checkDraftVault: (vault: VaultInfo | null) => boolean;
  logAction: (action: string, detail?: string | null) => Promise<void>;
}

let generation = 0;
let bootstrapRequest: Promise<boolean> | null = null;
let lockRequest: Promise<boolean> | null = null;

export const ACCESS_ENDED_MESSAGE =
  "App access ended. Unlock or retry access to continue. Unsaved edits are kept only in memory, not confirmed saved. Keep this window open to recover them.";

function checkAccess(access: AuthAccess, requireLogin: boolean): void {
  if (
    !access || typeof access.lockEnabled !== "boolean" ||
    typeof access.migrationRequired !== "boolean" ||
    (access.login !== null && (
      !access.login || typeof access.login.token !== "string" || access.login.token === "" ||
      !access.login.session || typeof access.login.session.username !== "string" ||
      access.login.session.role !== "Admin" || access.login.mustChangePassword !== false
    )) ||
    (access.migrationRequired && access.login !== null) ||
    (!access.lockEnabled && !access.migrationRequired && access.login === null) ||
    (requireLogin && access.login === null)
  ) {
    throw new Error("Invalid app access response. Retry access; the app has not been unlocked.");
  }
}

export const useAuthStore = create<AuthState>((set, get) => {
  function holdDraftRecovery(message: string): void {
    setAutosaveAccessPaused(true);
    cancelPendingOpens();
    set({
      session: null,
      draftRecovery: get().draftRecovery ?? { vaultRoot: pendingSaveVaultRoot() },
      error: message,
    });
  }

  function checkDraftVault(vault: VaultInfo | null): boolean {
    if (!hasPendingSave()) return true;
    const recovery = get().draftRecovery;
    const root = recovery === null ? pendingSaveVaultRoot() : recovery.vaultRoot;
    if (root !== null && vault?.root === root && useVaultStore.getState().active?.root === root) return true;
    holdDraftRecovery("The active vault does not match the draft vault. Drafts remain only in memory and have not been saved. Return to the draft vault to recover them.");
    return false;
  }

  async function requestAccess(
    operation: Exclude<AccessOperation, "lock">,
    request: () => Promise<AuthAccess>,
  ): Promise<boolean> {
    if (get().busy !== null) return false;
    const ticket = ++generation;
    set({ busy: operation, error: null });
    try {
      const access = await request();
      if (ticket !== generation) return false;
      checkAccess(access, operation !== "bootstrap" && operation !== "recover");
      if (access.login !== null) {
        set({
          token: access.login.token,
          lockEnabled: access.lockEnabled,
          migrationRequired: access.migrationRequired,
          ready: true,
        });
        if (operation !== "configure") {
          if (hasPendingSave()) {
            setAutosaveAccessPaused(true);
            set({ draftRecovery: get().draftRecovery ?? { vaultRoot: pendingSaveVaultRoot() } });
            const vault = await vaultCurrent();
            if (ticket !== generation) return false;
            if (!checkDraftVault(vault)) return false;
          }
          setAutosaveAccessPaused(false);
          const result = await flushPendingSave();
          if (ticket !== generation) return false;
          if (result.failedKeys.length > 0 || !result.preserved) {
            holdDraftRecovery(`Draft recovery could not save all edits: ${useEditorStore.getState().saveError?.message ?? "save failed"}. Drafts remain only in memory. Fix the problem and retry recovery.`);
            return false;
          }
        }
      } else {
        setAutosaveAccessPaused(true);
      }
      set({
        token: access.login?.token ?? null,
        session: access.login?.session ?? null,
        lockEnabled: access.lockEnabled,
        migrationRequired: access.migrationRequired,
        ready: true,
        accessNotice: null,
        draftRecovery: access.login === null ? get().draftRecovery : null,
      });
      return true;
    } catch (error) {
      if (ticket === generation) {
        if (get().draftRecovery !== null) setAutosaveAccessPaused(true);
        set({ error: formatAppError(error) });
      }
      return false;
    } finally {
      if (ticket === generation) set({ busy: null });
    }
  }

  return {
    token: null,
    session: null,
    lockEnabled: null,
    migrationRequired: false,
    ready: false,
    busy: null,
    error: null,
    accessNotice: null,
    draftRecovery: null,
    holdDraftRecovery,
    checkDraftVault,
    bootstrap: () => {
      if (bootstrapRequest !== null) return bootstrapRequest;
      if (get().ready && get().draftRecovery === null) return Promise.resolve(true);
      const request = requestAccess("bootstrap", authBootstrap);
      bootstrapRequest = request;
      void request.finally(() => {
        if (bootstrapRequest === request) bootstrapRequest = null;
      });
      return request;
    },
    unlock: (password) => requestAccess("unlock", () => authUnlock(password)),
    migrate: (username, password, newPassword) =>
      requestAccess("migrate", () => authMigrate(username, password, newPassword)),
    returnToDraftVault: () => {
      const root = get().draftRecovery?.vaultRoot;
      if (root == null || get().token === null) return Promise.resolve(false);
      return requestAccess("recover", async () => {
        const vault = await vaultSetActive(root);
        if (vault.root !== root) throw new Error("The backend did not return the draft vault. Drafts remain paused.");
        // Explicitly restore the originating vault without activateVault's
        // editor reset or queue discard, then recheck access and the root.
        useVaultStore.getState().setActive(vault);
        return authBootstrap();
      });
    },
    setLock: (enabled, currentPassword, newPassword) => {
      const { token, session } = get();
      if (token === null || session === null) return Promise.resolve(false);
      return requestAccess("configure", () => authSetLock(token, enabled, currentPassword, newPassword));
    },
    lock: () => {
      if (lockRequest !== null) return lockRequest;
      const { token, session, lockEnabled, busy } = get();
      if (token === null || session === null || lockEnabled !== true || busy !== null) {
        return Promise.resolve(false);
      }
      const ticket = ++generation;
      cancelPendingOpens();
      set({ busy: "lock", error: null });
      lockRequest = (async () => {
        try {
          const { failedKeys, preserved } = await flushPendingSave({ leaving: true });
          if (ticket !== generation) return false;
          if (failedKeys.length > 0 || !preserved) {
            throw new Error("Not locked: some edits could not be saved or preserved as a copy. Your edits remain available; fix the save error and try again.");
          }
          const flushed = useEditorStore.getState().open;
          await authLock(token);
          if (ticket !== generation) return false;
          setAutosaveAccessPaused(true);
          // A late async editor mutation must survive even an acknowledged lock.
          const current = useEditorStore.getState().open;
          if (current?.key === flushed?.key && current?.content === flushed?.content) {
            useEditorStore.getState().resetEditor();
          }
          set({ token: null, session: null, accessNotice: null });
          return true;
        } catch (error) {
          if (ticket === generation) set({ error: formatAppError(error) });
          return false;
        } finally {
          if (ticket === generation) set({ busy: null });
          lockRequest = null;
        }
      })();
      return lockRequest;
    },
    logAction: async (action, detail = null) => {
      const { token } = get();
      if (token !== null) await authLogAction(token, action, detail);
    },
  };
});

/** Hide access immediately, but keep both the editor draft and its save queue. */
export function handleUnauthorized(): void {
  const { token, session, lockEnabled } = useAuthStore.getState();
  if (token === null && session === null) return;
  generation += 1;
  bootstrapRequest = null;
  cancelPendingOpens();
  setAutosaveAccessPaused(true);
  useUIStore.setState({ commandPaletteOpen: false, modelPickerOpen: false, pendingAction: null });
  useAuthStore.setState({
    token: null, session: null, busy: null, error: null,
    ready: lockEnabled === true,
    accessNotice: ACCESS_ENDED_MESSAGE,
  });
}

setUnauthorizedHandler(handleUnauthorized);
