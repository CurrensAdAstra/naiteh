import { create } from "zustand";

import {
  backupRun,
  backupTargetsList,
  listenBackupDone,
  listenBackupProgress,
  type BackupProgress,
  type BackupRunResult,
  type BackupTarget,
} from "../lib/api/backup";
import { formatAppError } from "../lib/types";

/**
 * Backup targets + the run in flight. Progress arrives as
 * `backup:progress` events (also for automatic backups the backend
 * starts on its own), so the status bar and the Backup settings section
 * subscribe through {@link subscribeBackupEvents}.
 */
interface BackupState {
  targets: BackupTarget[];
  loaded: boolean;
  loadError: string | null;
  /** Per-target progress of the current run (manual or automatic). */
  progress: Record<string, BackupProgress>;
  /** A manual "Back up now" is awaiting its result. */
  running: boolean;
  lastResults: BackupRunResult[] | null;
  /** Last run's failure summary (status bar error indicator). */
  lastRunError: string | null;
  compareOpen: boolean;
  loadTargets: () => Promise<void>;
  upsertTarget: (target: BackupTarget) => void;
  dropTarget: (id: string) => void;
  /** Back up one target, or every enabled one (`null`). */
  runBackup: (id: string | null) => Promise<BackupRunResult[] | null>;
  applyProgress: (p: BackupProgress) => void;
  applyDone: (result: BackupRunResult) => void;
  setCompareOpen: (open: boolean) => void;
  clearLastRunError: () => void;
}

function failureSummary(
  results: readonly BackupRunResult[],
  targets: readonly BackupTarget[],
): string | null {
  const failed = results.filter((r) => r.error !== null);
  if (failed.length === 0) return null;
  return failed
    .map((r) => {
      const name = targets.find((t) => t.id === r.targetId)?.name ?? r.targetId;
      return `${name}: ${r.error ?? ""}`;
    })
    .join("; ");
}

export const useBackupStore = create<BackupState>((set, get) => ({
  targets: [],
  loaded: false,
  loadError: null,
  progress: {},
  running: false,
  lastResults: null,
  lastRunError: null,
  compareOpen: false,
  loadTargets: async () => {
    try {
      const targets = await backupTargetsList();
      set({ targets, loaded: true, loadError: null });
    } catch (e) {
      set({ loaded: true, loadError: formatAppError(e) });
    }
  },
  upsertTarget: (target) =>
    set((s) => {
      const idx = s.targets.findIndex((t) => t.id === target.id);
      if (idx === -1) return { targets: [...s.targets, target] };
      const next = s.targets.slice();
      next[idx] = target;
      return { targets: next };
    }),
  dropTarget: (id) =>
    set((s) => ({ targets: s.targets.filter((t) => t.id !== id) })),
  runBackup: async (id) => {
    if (get().running) return null;
    set({ running: true, progress: {}, lastRunError: null });
    try {
      const results = await backupRun(id);
      set({
        lastResults: results,
        lastRunError: failureSummary(results, get().targets),
      });
      await get().loadTargets();
      return results;
    } catch (e) {
      set({ lastRunError: formatAppError(e) });
      return null;
    } finally {
      set({ running: false, progress: {} });
    }
  },
  applyProgress: (p) =>
    set((s) => ({ progress: { ...s.progress, [p.targetId]: p } })),
  applyDone: (result) =>
    set((s) => {
      const progress = { ...s.progress };
      delete progress[result.targetId];
      const error =
        result.error === null
          ? s.lastRunError
          : failureSummary([result], s.targets);
      return { progress, lastRunError: error };
    }),
  setCompareOpen: (open) => set({ compareOpen: open }),
  clearLastRunError: () => set({ lastRunError: null }),
}));

let subscribers = 0;
let unlisteners: (() => void)[] = [];

/**
 * Ref-counted subscription to `backup:progress` / `backup:done`. Returns
 * the matching unsubscribe.
 */
export function subscribeBackupEvents(): () => void {
  subscribers += 1;
  if (subscribers === 1) {
    const store = () => useBackupStore.getState();
    const pending = [
      listenBackupProgress((p) => store().applyProgress(p)),
      listenBackupDone((d) => {
        store().applyDone(d.result);
        if (!store().running) void store().loadTargets();
      }),
    ];
    for (const p of pending) {
      void p
        .then((un) => {
          if (subscribers === 0) un();
          else unlisteners.push(un);
        })
        .catch(() => {});
    }
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers -= 1;
    if (subscribers === 0) {
      for (const un of unlisteners) un();
      unlisteners = [];
    }
  };
}
