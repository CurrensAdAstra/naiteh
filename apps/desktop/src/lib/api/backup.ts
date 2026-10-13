import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { hasTauriRuntime, invoke } from "./invoke";

/**
 * Backup targets (Google Drive folder / SFTP server) and the 3-way
 * compare between the local vault and every target. Outside the Tauri
 * webview (plain vite dev) the read-only calls return empty results.
 */

export type BackupTargetKind = "drive" | "sftp";
export type SftpAuthMethod = "password" | "key";

export interface DriveTargetConfig {
  folder: string;
}

export interface SftpTargetConfig {
  host: string;
  port: number;
  username: string;
  authMethod: SftpAuthMethod;
  keyPath: string | null;
  /** A password is stored (the value itself never reaches the UI). */
  hasPassword: boolean;
  hasPassphrase: boolean;
  remoteDir: string;
  /** SHA-256 host key the user trusted; `null` until confirmed. */
  hostKeyFingerprint: string | null;
}

export interface BackupTarget {
  id: string;
  kind: BackupTargetKind;
  name: string;
  enabled: boolean;
  autoBackup: boolean;
  intervalMinutes: number;
  lastBackupAt: number | null;
  lastError: string | null;
  drive?: DriveTargetConfig;
  sftp?: SftpTargetConfig;
}

export interface BackupRunResult {
  targetId: string;
  uploaded: number;
  trashed: number;
  unchanged: number;
  bytes: number;
  durationMs: number;
  error: string | null;
}

export interface BackupProgress {
  targetId: string;
  done: number;
  total: number;
  relPath: string;
}

export interface BackupDone {
  targetId: string;
  result: BackupRunResult;
}

export interface CompareSource {
  id: string;
  name: string;
  kind: "local" | BackupTargetKind;
  ok: boolean;
  error: string | null;
  fileCount: number;
}

export interface CompareEntry {
  size: number;
  hash: string;
  mtime: number;
}

export type CompareStatus = "same" | "differs" | "missing";

export interface CompareRow {
  relPath: string;
  entries: Record<string, CompareEntry | null>;
  status: CompareStatus;
}

export interface CompareReport {
  generatedAt: number;
  sources: CompareSource[];
  rows: CompareRow[];
}

export interface BackupFileContent {
  content: string | null;
  size: number;
  hash: string;
  binary: boolean;
}

export interface AddSftpArgs {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SftpAuthMethod;
  password: string | null;
  keyPath: string | null;
  passphrase: string | null;
  remoteDir: string;
}

export interface UpdateTargetArgs {
  id: string;
  name?: string;
  enabled?: boolean;
  autoBackup?: boolean;
  intervalMinutes?: number;
  folder?: string;
  remoteDir?: string;
  password?: string;
  passphrase?: string;
  keyPath?: string;
}

export function backupTargetsList(): Promise<BackupTarget[]> {
  if (!hasTauriRuntime()) return Promise.resolve([]);
  return invoke<BackupTarget[]>("backup_targets_list");
}

export function backupDriveCandidates(): Promise<string[]> {
  if (!hasTauriRuntime()) return Promise.resolve([]);
  return invoke<string[]>("backup_drive_candidates");
}

export function backupTargetAddDrive(
  name: string,
  folder: string,
): Promise<BackupTarget> {
  return invoke<BackupTarget>("backup_target_add_drive", { name, folder });
}

export function backupTargetAddSftp(
  args: AddSftpArgs,
): Promise<{ target: BackupTarget; fingerprint: string }> {
  return invoke("backup_target_add_sftp", { ...args });
}

export function backupTargetConfirmHostKey(
  id: string,
  fingerprint: string,
): Promise<BackupTarget> {
  return invoke<BackupTarget>("backup_target_confirm_host_key", {
    id,
    fingerprint,
  });
}

export function backupTargetUpdate(
  args: UpdateTargetArgs,
): Promise<BackupTarget> {
  return invoke<BackupTarget>("backup_target_update", { ...args });
}

/** Forget a target. Data already on the Drive folder / server stays. */
export function backupTargetRemove(id: string): Promise<void> {
  return invoke<void>("backup_target_remove", { id });
}

export function backupTest(id: string): Promise<void> {
  return invoke<void>("backup_test", { id });
}

/** Back up one target, or every enabled target when `id` is `null`. */
export function backupRun(id: string | null): Promise<BackupRunResult[]> {
  if (!hasTauriRuntime()) return Promise.resolve([]);
  return invoke<BackupRunResult[]>("backup_run", { id });
}

export function backupCompare(
  deep: boolean,
  includeSame: boolean,
): Promise<CompareReport> {
  if (!hasTauriRuntime()) {
    return Promise.resolve({ generatedAt: Date.now(), sources: [], rows: [] });
  }
  return invoke<CompareReport>("backup_compare", { deep, includeSame });
}

export function backupReadFile(
  sourceId: string,
  relPath: string,
): Promise<BackupFileContent> {
  return invoke<BackupFileContent>("backup_read_file", { sourceId, relPath });
}

export function backupRestoreFile(
  sourceId: string,
  relPath: string,
  mode: "copy" | "overwrite",
  expectedVersion: string | null,
): Promise<{ relPath: string }> {
  return invoke("backup_restore_file", {
    sourceId,
    relPath,
    mode,
    expectedVersion,
  });
}

export function listenBackupProgress(
  handler: (progress: BackupProgress) => void,
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) return Promise.resolve(() => {});
  return listen<BackupProgress>("backup:progress", (e) => handler(e.payload));
}

export function listenBackupDone(
  handler: (done: BackupDone) => void,
): Promise<UnlistenFn> {
  if (!hasTauriRuntime()) return Promise.resolve(() => {});
  return listen<BackupDone>("backup:done", (e) => handler(e.payload));
}
