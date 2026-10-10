import type { VaultInfo } from "./types";
import { discardPendingSave } from "../state/autosave";
import { useEditorStore } from "../state/editorStore";
import { useVaultStore } from "../state/vaultStore";

/**
 * Make `next` the active vault. The editor's open file points into the
 * *previous* vault, so it's closed as part of the switch — callers get
 * the editor-reset for free and never have to remember to pair it with
 * `setActive` themselves.
 *
 * Unsaved edits: by the time this runs the backend has already switched
 * (`vault_set_active` resolved), so a pending autosave can no longer be
 * written safely — it would land in the *new* vault. Callers must
 * `await flushPendingSave()` (state/autosave) **before** calling
 * `vault_set_active`; anything still pending here is dropped, and any
 * in-flight open request is cancelled.
 *
 * The IPC call (`vault_set_active`) and any audit logging stay with the
 * caller; this only owns the cross-store state transition.
 */
export function activateVault(next: VaultInfo): void {
  discardPendingSave();
  useEditorStore.getState().resetEditor();
  useVaultStore.getState().setActive(next);
}
