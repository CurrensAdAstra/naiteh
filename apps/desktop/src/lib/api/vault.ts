import { invoke } from "@tauri-apps/api/core";

import type { VaultInfo } from "../types";

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return true;
  const maybeWindow = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

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
