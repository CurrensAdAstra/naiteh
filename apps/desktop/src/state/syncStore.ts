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

// Refreshes can overlap (30 s poll + explicit refresh after "Sync now");
// only the newest request may write its result.
let refreshTicket = 0;

export const useSyncStore = create<SyncState>((set) => ({
  status: null,
  notInitialized: false,
  loaded: false,
  refresh: async () => {
    const ticket = ++refreshTicket;
    try {
      const next = await syncStatus();
      if (ticket !== refreshTicket) return;
      set({ status: next, notInitialized: false, loaded: true });
    } catch (e) {
      if (ticket !== refreshTicket) return;
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
  reset: () => {
    refreshTicket += 1;
    set({ status: null, notInitialized: false, loaded: false });
  },
}));
