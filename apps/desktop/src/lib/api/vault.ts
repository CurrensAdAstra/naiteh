import type { VaultInfo } from "../types";
import { hasTauriRuntime, invoke } from "./invoke";

function desktopRequired(): Promise<never> {
  return Promise.reject({
    kind: "NotFound",
    message: "Desktop runtime is required for vault access.",
  });
}

export function vaultPickFolder(): Promise<VaultInfo> {
  if (!hasTauriRuntime()) return desktopRequired();
  return invoke<VaultInfo>("vault_pick_folder");
}

export function vaultInit(root: string): Promise<VaultInfo> {
  if (!hasTauriRuntime()) return desktopRequired();
  return invoke<VaultInfo>("vault_init", { root });
}

export function vaultCurrent(): Promise<VaultInfo | null> {
  if (!hasTauriRuntime()) return Promise.resolve(null);
  return invoke<VaultInfo | null>("vault_current");
}

export function vaultSetActive(root: string): Promise<VaultInfo> {
  if (!hasTauriRuntime()) return desktopRequired();
  return invoke<VaultInfo>("vault_set_active", { root });
}

export function vaultListKnown(): Promise<VaultInfo[]> {
  if (!hasTauriRuntime()) return Promise.resolve([]);
  return invoke<VaultInfo[]>("vault_list_known");
}

/**
 * One-click first-run setup: creates `~/Documents/duramen` (deduped
 * with `-2`, `-3`, … if taken), initializes it, and makes it active.
 */
export function vaultCreateDefault(): Promise<VaultInfo> {
  if (!hasTauriRuntime()) return desktopRequired();
  return invoke<VaultInfo>("vault_create_default");
}
