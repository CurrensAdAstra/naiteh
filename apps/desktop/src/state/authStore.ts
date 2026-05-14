import { create } from "zustand";

import { authLogAction } from "../lib/api/auth";
import type { AuthSession } from "../lib/types";

interface AuthState {
  session: AuthSession | null;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
  logAction: (action: string, detail?: string | null) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  setSession: (session) => set({ session }),
  clearSession: () => set({ session: null }),
  logAction: async (action, detail = null) => {
    const session = get().session;
    if (session === null) return;
    await authLogAction(session.username, action, detail);
  },
}));
