import { create } from "zustand";

import { syncStatus } from "../lib/api/sync";
import { isAppError, type SyncStatus } from "../lib/types";

interface SyncState {
  status: SyncStatus | null;
  /** True if the active vault is not yet sync-initialised (NotFound from sync_status). */
  notInitialized: boolean;
  /** Last attempted refresh — used by the UI to avoid showing "loading…" forever. */
  loaded: boolean;
  refresh: () => Promise<void>;
  reset: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: null,
  notInitialized: false,
  loaded: false,
  refresh: async () => {
    try {
      const next = await syncStatus();
      set({ status: next, notInitialized: false, loaded: true });
    } catch (e) {
      if (
        isAppError(e) &&
        e.kind === "NotFound" &&
        e.message.toLowerCase().includes("repository")
      ) {
        set({ status: null, notInitialized: true, loaded: true });
      } else {
        // Keep last known status; just mark loaded so the UI stops spinning.
        set({ loaded: true });
      }
    }
  },
  reset: () => set({ status: null, notInitialized: false, loaded: false }),
}));
