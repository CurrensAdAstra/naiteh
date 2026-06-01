import type { VaultInfo } from "./types";
import { useEditorStore } from "../state/editorStore";
import { useVaultStore } from "../state/vaultStore";

/**
 * Make `next` the active vault. The editor's open file points into the
 * *previous* vault, so it's closed as part of the switch — callers get
 * the editor-reset for free and never have to remember to pair it with
 * `setActive` themselves.
 *
 * The IPC call (`vault_set_active`) and any audit logging stay with the
 * caller; this only owns the cross-store state transition.
 */
export function activateVault(next: VaultInfo): void {
  useEditorStore.getState().closeNote();
  useVaultStore.getState().setActive(next);
}
