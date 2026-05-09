import { invoke } from "@tauri-apps/api/core";

import type { VaultInfo } from "../types";

export function vaultPickFolder(): Promise<VaultInfo> {
  return invoke<VaultInfo>("vault_pick_folder");
}

export function vaultInit(root: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("vault_init", { root });
}

export function vaultCurrent(): Promise<VaultInfo | null> {
  return invoke<VaultInfo | null>("vault_current");
}

export function vaultSetActive(root: string): Promise<VaultInfo> {
  return invoke<VaultInfo>("vault_set_active", { root });
}

export function vaultListKnown(): Promise<VaultInfo[]> {
  return invoke<VaultInfo[]>("vault_list_known");
}
