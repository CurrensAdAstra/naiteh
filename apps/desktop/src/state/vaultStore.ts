import { create } from "zustand";

import type { VaultInfo } from "../lib/types";

interface VaultState {
  active: VaultInfo | null;
  setActive: (vault: VaultInfo | null) => void;
}

export const useVaultStore = create<VaultState>((set) => ({
  active: null,
  setActive: (vault) => set({ active: vault }),
}));
