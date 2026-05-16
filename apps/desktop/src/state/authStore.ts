import { create } from "zustand";

import { authLogAction, authLogout } from "../lib/api/auth";
import type { AuthSession } from "../lib/types";

interface AuthState {
  /** Bearer token issued by `auth_login`. Always passed alongside `session`. */
  token: string | null;
  session: AuthSession | null;
  setSession: (token: string, session: AuthSession) => void;
  clearSession: () => Promise<void>;
  /** Logs an audit event; no-op (resolved) when not signed in. */
  logAction: (action: string, detail?: string | null) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  session: null,
  setSession: (token, session) => set({ token, session }),
  clearSession: async () => {
    const token = get().token;
    if (token !== null) {
      // Fire-and-forget; even if the backend is gone we still want
      // the frontend to forget the session.
      void authLogout(token).catch(() => {});
    }
    set({ token: null, session: null });
  },
  logAction: async (action, detail = null) => {
    const { token } = get();
    if (token === null) return;
    await authLogAction(token, action, detail);
  },
}));
