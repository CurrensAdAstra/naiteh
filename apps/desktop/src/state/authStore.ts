import { create } from "zustand";

import {
  authChangePassword,
  authLogAction,
  authLogout,
} from "../lib/api/auth";
import { setUnauthorizedHandler } from "../lib/api/invoke";
import { takePasswordChangeRequired } from "../lib/api/passwordChangeFlags";
import type { AuthSession } from "../lib/types";
import { flushPendingSave } from "./autosave";
import { useEditorStore } from "./editorStore";
import { useUIStore } from "./uiStore";

/**
 * A login/resume the backend flagged `mustChangePassword`. The session
 * is *not* exposed as `session` until the password is changed, so the
 * app keeps showing the login screen (which renders the change step).
 */
export interface PendingPasswordChange {
  token: string;
  session: AuthSession;
}

interface AuthState {
  /** Bearer token issued by `auth_login`. Always passed alongside `session`. */
  token: string | null;
  /** Signed-in session; `null` shows the login screen. */
  session: AuthSession | null;
  pendingPasswordChange: PendingPasswordChange | null;
  /** Why the user was signed out without asking (shown on the login screen). */
  signedOutReason: string | null;
  /**
   * Sign in. When the backend flagged this login for a forced password
   * change (`mustChangePassword`, passed here or recorded by
   * `authLogin`/`authResume`), the session is held as pending instead.
   */
  setSession: (
    token: string,
    session: AuthSession,
    mustChangePassword?: boolean,
  ) => void;
  /** Finish a forced change; signs in on success, rejects with the AppError. */
  completePasswordChange: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  /** Signed-in user changes their own password; rejects with the AppError. */
  changePassword: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  /**
   * Log out: flush the open note's unsaved edits, close it (so the next
   * user never sees the previous user's document), then forget the
   * session. Concurrent calls share one in-flight logout. Resolves
   * `false` (still signed in) when edits held by a conflict could not be
   * preserved as a `.local-` copy, unless `force` (dead session).
   */
  clearSession: (opts?: { force?: boolean }) => Promise<boolean>;
  /** Logs an audit event; no-op (resolved) when not signed in. */
  logAction: (action: string, detail?: string | null) => Promise<void>;
}

let clearing: Promise<boolean> | null = null;

export const SESSION_ENDED_MESSAGE =
  "Your session ended. Sign in again to continue.";

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  session: null,
  pendingPasswordChange: null,
  signedOutReason: null,
  setSession: (token, session, mustChangePassword = false) => {
    // Always consume the recorded flag so it can't leak to a later call.
    const flagged = takePasswordChangeRequired(token);
    if (flagged || mustChangePassword) {
      set({
        token: null,
        session: null,
        pendingPasswordChange: { token, session },
        signedOutReason: null,
      });
      return;
    }
    set({
      token,
      session,
      pendingPasswordChange: null,
      signedOutReason: null,
    });
  },
  completePasswordChange: async (currentPassword, newPassword) => {
    const pending = get().pendingPasswordChange;
    if (pending === null) return;
    await authChangePassword(pending.token, currentPassword, newPassword);
    // Ignore a stale completion if the user signed out meanwhile.
    if (get().pendingPasswordChange !== pending) return;
    set({
      token: pending.token,
      session: pending.session,
      pendingPasswordChange: null,
    });
  },
  changePassword: async (currentPassword, newPassword) => {
    const { token } = get();
    if (token === null) {
      throw { kind: "Unauthorized", message: "Not signed in." };
    }
    await authChangePassword(token, currentPassword, newPassword);
  },
  clearSession: (opts = {}) => {
    if (clearing !== null) return clearing;
    clearing = (async () => {
      try {
        // Persist first, while the session is still valid for audit
        // logging. `leaving`: logout moves the editor off the document,
        // so edits held by a conflict go to a `.local-` copy instead of
        // being abandoned. An ordinary write that fails keeps retrying in
        // the background (same file, same vault), so logout proceeds.
        const { preserved } = await flushPendingSave({ leaving: true });
        if (!preserved && opts.force !== true) {
          // The held edits exist only in memory and in the open editor.
          // Signing out would clear the editor and hand the app to the
          // next user while the copy is still failing, so stay signed in
          // and let the user see/fix the problem (the copy keeps
          // retrying). A dead session (`handleUnauthorized`) forces the
          // logout: the backend refuses every write anyway.
          useUIStore
            .getState()
            .setNotice(
              "Not signed out: unsaved edits couldn't be kept as a copy. Still retrying — fix the problem and try again.",
            );
          return false;
        }
        useEditorStore.getState().resetEditor();
        const { token, pendingPasswordChange } = get();
        for (const t of [token, pendingPasswordChange?.token ?? null]) {
          if (t === null) continue;
          // Fire-and-forget; even if the backend is gone we still want
          // the frontend to forget the session.
          void authLogout(t).catch(() => {});
        }
        set({ token: null, session: null, pendingPasswordChange: null });
        return true;
      } finally {
        clearing = null;
      }
    })();
    return clearing;
  },
  logAction: async (action, detail = null) => {
    const { token } = get();
    if (token === null) return;
    await authLogAction(token, action, detail);
  },
}));

/**
 * The backend refused a gated command because no session is active
 * (restart, revoked token, account disabled). Sign out through the same
 * path as an explicit logout so unsaved edits are flushed and the editor
 * is cleared, then let the login screen explain what happened.
 */
export async function handleUnauthorized(): Promise<void> {
  const state = useAuthStore.getState();
  if (state.token === null && state.pendingPasswordChange === null) return;
  await state.clearSession({ force: true });
  useAuthStore.setState({ signedOutReason: SESSION_ENDED_MESSAGE });
}

setUnauthorizedHandler(() => {
  void handleUnauthorized();
});
