import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { checkOpenDocument } from "./externalChange";
import type {
  VaultChange,
  VaultChangedPayload,
  VaultWatchErrorPayload,
} from "./types";
import { useEditorStore } from "../state/editorStore";
import { useUIStore } from "../state/uiStore";
import { notifyVaultContentChanged } from "../state/vaultContentStore";

/**
 * Follows changes made to the vault outside naiteh (Google Drive sync,
 * other editors) via the backend's file watcher:
 *
 * - `vault:changed` batches that contain at least one change naiteh did
 *   not make itself (`own: false`) — or that overflowed — bump the
 *   vault-content version after a short debounce so Notes / Journal /
 *   Calendar / Tags / Search refetch, and re-check the open document when
 *   a change touched its path (lib/externalChange `checkOpenDocument`).
 * - `vault:watch-error` flips `uiStore.liveUpdatesUnavailable`, shown in
 *   the status bar.
 * - Window focus / tab visibility re-check the open document (throttled)
 *   as a safety net for events the watcher missed.
 *
 * Started once per active vault by shell/useWorkspaceLifecycle; the
 * returned function tears everything down.
 */

export const VAULT_CHANGE_DEBOUNCE_MS = 300;
export const FOCUS_RECHECK_THROTTLE_MS = 2_000;

/** Does `change` affect the file at `relPath` (itself or a removed parent)? */
export function changeTouches(change: VaultChange, relPath: string): boolean {
  if (change.relPath === relPath) return true;
  return change.kind === "removed" && relPath.startsWith(`${change.relPath}/`);
}

/** `listen` that fails as a rejection rather than a throw (no Tauri runtime). */
async function subscribe<T>(
  name: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(name, (e) => handler(e.payload));
}

export async function startVaultWatch(): Promise<() => void> {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let openTouched = false;
  let lastFocusCheck = Number.NEGATIVE_INFINITY;

  useUIStore.getState().setLiveUpdatesUnavailable(null);

  function flush(): void {
    timer = null;
    const recheck = openTouched;
    openTouched = false;
    notifyVaultContentChanged();
    if (recheck) void checkOpenDocument();
  }

  function onChanged(payload: VaultChangedPayload): void {
    if (disposed) return;
    const external = payload.changes.filter((c) => !c.own);
    if (!payload.overflow && external.length === 0) return;
    const open = useEditorStore.getState().open;
    if (
      open !== null &&
      (payload.overflow ||
        external.some((c) => changeTouches(c, open.source.relPath)))
    ) {
      openTouched = true;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, VAULT_CHANGE_DEBOUNCE_MS);
  }

  function onWatchError(payload: VaultWatchErrorPayload): void {
    if (disposed) return;
    useUIStore.getState().setLiveUpdatesUnavailable(payload.message);
  }

  function onFocusLike(): void {
    if (disposed || document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - lastFocusCheck < FOCUS_RECHECK_THROTTLE_MS) return;
    lastFocusCheck = now;
    void checkOpenDocument();
  }

  window.addEventListener("focus", onFocusLike);
  document.addEventListener("visibilitychange", onFocusLike);

  // Outside the Tauri runtime (vite in a browser, tests) `listen` fails:
  // live updates are simply unavailable there; focus re-checks still run.
  const unlisteners: UnlistenFn[] = [];
  const results = await Promise.allSettled([
    subscribe<VaultChangedPayload>("vault:changed", onChanged),
    subscribe<VaultWatchErrorPayload>("vault:watch-error", onWatchError),
  ]);
  for (const result of results) {
    if (result.status === "fulfilled") unlisteners.push(result.value);
  }

  return () => {
    disposed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    window.removeEventListener("focus", onFocusLike);
    document.removeEventListener("visibilitychange", onFocusLike);
    for (const unlisten of unlisteners) unlisten();
  };
}
