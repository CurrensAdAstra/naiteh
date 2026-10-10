import { create } from "zustand";

/**
 * A change counter for "files in the vault changed outside this panel"
 * (sync pull, conflict resolution, note create/rename/delete). List
 * panels subscribe to `version` and refetch when it moves, so they don't
 * only refresh on mount.
 */
interface VaultContentState {
  version: number;
}

export const useVaultContentStore = create<VaultContentState>(() => ({
  version: 0,
}));

/** Announce that vault files changed; returns the new version. */
export function notifyVaultContentChanged(): number {
  const next = useVaultContentStore.getState().version + 1;
  useVaultContentStore.setState({ version: next });
  return next;
}
