import { useEffect } from "react";

import {
  workspaceGet,
  workspaceSetLastOpened,
} from "../lib/api/workspace";
import { openByRelPath } from "../lib/openByRelPath";
import type { LastOpened } from "../lib/types";
import { useEditorStore } from "../state/editorStore";
import { useSyncStore } from "../state/syncStore";

const SYNC_STATUS_REFRESH_MS = 30_000;

function journalRelPathFor(date: string): string {
  return `journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
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
        if (useEditorStore.getState().open !== null) return;
        const relPath =
          last.kind === "Note" ? last.relPath : journalRelPathFor(last.date);
        try {
          await openByRelPath(relPath);
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
}
