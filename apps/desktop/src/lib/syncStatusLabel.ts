import type { SyncStatus } from "./types";

/**
 * One-line summary for the Status Bar. Mirrors the friendly-but-honest
 * wording the Sync panel itself uses; never says "git".
 */
export function describeSyncStatus(
  status: SyncStatus | null,
  notInitialized: boolean,
  nowMs: number = Date.now(),
): string {
  if (notInitialized) return "Sync: off";
  if (status === null) return "Sync: —";
  if (status.dirty) return "Sync: pending";
  if (status.lastSync === null) {
    return status.remoteUrl === null ? "Sync: local only" : "Sync: never";
  }
  return `Sync: ${formatRelative(status.lastSync, nowMs)}`;
}

function formatRelative(unixSeconds: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604_800) return `${Math.floor(diffSec / 86_400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
