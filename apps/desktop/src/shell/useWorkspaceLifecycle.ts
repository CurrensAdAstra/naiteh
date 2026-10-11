import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import {
  workspaceGet,
  workspaceSetLastOpened,
} from "../lib/api/workspace";
import { openDocument, type OpenTarget } from "../lib/openDocument";
import type { LastOpened } from "../lib/types";
import { startVaultWatch } from "../lib/vaultWatch";
import { flushPendingSave } from "../state/autosave";
import { useEditorStore } from "../state/editorStore";
import { useSyncStore } from "../state/syncStore";

const SYNC_STATUS_REFRESH_MS = 30_000;

function targetForLastOpened(last: LastOpened): OpenTarget {
  return last.kind === "Note"
    ? { kind: "note", relPath: last.relPath }
    : { kind: "journal", date: last.date };
}

/**
 * Owns the per-vault "workspace" coordination that spans the sync,
 * editor, and workspace stores — kept out of `AppShell` so that
 * component stays purely structural. Mounted once per active vault
 * (AppShell is keyed on the vault root in `App.tsx`), so each of these
 * effects re-runs when the user switches vaults.
 *
 * 1. Sync status: reset + pull on mount, then refresh on a slow
 *    interval so the status bar's "Sync: 5m ago" stays roughly current
 *    without polling git on every keystroke.
 * 2. Restore the last-opened file from `.naiteh/workspace.json`; clear
 *    a stale marker if that file no longer exists.
 * 3. Persist the last-opened file on every fresh open-transition.
 * 4. Flush unsaved edits before the window closes.
 * 5. Follow changes made to the vault outside naiteh (Google Drive sync,
 *    other editors) so lists refetch and the open note reloads or enters
 *    the conflict state (lib/vaultWatch).
 */
export function useWorkspaceLifecycle(): void {
  // 1. Sync status refresh.
  useEffect(() => {
    const refresh = useSyncStore.getState().refresh;
    useSyncStore.getState().reset();
    void refresh();
    const handle = setInterval(() => void refresh(), SYNC_STATUS_REFRESH_MS);
    return () => clearInterval(handle);
  }, []);

  // 2. Restore last-opened.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await workspaceGet();
        const last = state.lastOpened;
        if (last === null || cancelled) return;
        // Don't clobber a note the user already opened during startup.
        // (A click that lands while this read is in flight also wins:
        // openDocument only applies the newest request.)
        if (useEditorStore.getState().open !== null) return;
        try {
          await openDocument(targetForLastOpened(last));
        } catch {
          // Stale entry — file probably deleted. Clear so it doesn't
          // resurface next session.
          await workspaceSetLastOpened(null).catch(() => {});
        }
      } catch {
        // workspace.json unreadable for some reason — non-fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 3. Persist last-opened on open-transitions. Closing a note or
  // switching vaults intentionally leaves the previous vault's
  // workspace.json alone so the user finds the same note on return.
  useEffect(() => {
    let lastKey = useEditorStore.getState().open?.key ?? null;
    const unsubscribe = useEditorStore.subscribe((state) => {
      const open = state.open;
      const key = open?.key ?? null;
      if (key === lastKey) return;
      lastKey = key;
      if (open === null) return;
      const payload: LastOpened =
        open.source.kind === "note"
          ? { kind: "Note", relPath: open.source.relPath }
          : { kind: "Journal", date: open.source.date };
      void workspaceSetLastOpened(payload).catch(() => {});
    });
    return () => unsubscribe();
  }, []);

  // 4. Flush pending autosaves before the window closes. With a JS
  // close-requested listener registered, Tauri defers the close to us;
  // `onCloseRequested` destroys the window once this handler resolves
  // (requires the `core:window:allow-destroy` capability). If destroying
  // fails, the listener is removed so the next close request goes
  // through natively instead of trapping the user.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const win = getCurrentWindow();
        const un = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          await flushPendingSave({ leaving: true });
          try {
            await win.destroy();
          } catch (e) {
            console.error("window destroy failed; close again to exit:", e);
            unlisten?.();
            unlisten = null;
          }
        });
        if (disposed) un();
        else unlisten = un;
      } catch {
        // Not running inside Tauri (tests, plain browser) — nothing to do.
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, []);

  // 5. Watch the vault for changes made outside naiteh. Torn down when the
  // shell unmounts (logout) or remounts for another vault.
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void startVaultWatch()
      .then((s) => {
        if (disposed) s();
        else stop = s;
      })
      .catch((e: unknown) => {
        console.warn("vault watch unavailable:", e);
      });
    return () => {
      disposed = true;
      stop?.();
      stop = null;
    };
  }, []);
}
