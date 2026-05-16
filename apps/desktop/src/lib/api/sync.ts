import { invoke } from "@tauri-apps/api/core";

import type { ConflictPair, SyncStatus } from "../types";

export function syncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_status");
}

export function syncInit(): Promise<void> {
  return invoke<void>("sync_init");
}

export function syncSetRemote(url: string): Promise<void> {
  return invoke<void>("sync_set_remote", { url });
}

export function syncPull(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_pull");
}

export function syncPush(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_push");
}

export function syncNow(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_now");
}

export function syncListConflicts(): Promise<ConflictPair[]> {
  return invoke<ConflictPair[]>("sync_list_conflicts");
}

export function syncResolveKeepOurs(
  conflictRelPath: string,
): Promise<void> {
  return invoke<void>("sync_resolve_keep_ours", { conflictRelPath });
}

export function syncResolveKeepTheirs(
  conflictRelPath: string,
  relPath: string,
): Promise<void> {
  return invoke<void>("sync_resolve_keep_theirs", {
    conflictRelPath,
    relPath,
  });
}
