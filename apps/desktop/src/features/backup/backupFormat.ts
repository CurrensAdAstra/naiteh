/** Pure helpers for the backup UI (kept apart for fast refresh). */

import type { CompareRow } from "../../lib/api/backup";

export type CompareFilter = "all" | "missing" | "changed" | "identical";

export const LOCAL_ID = "local";

export function filterRows(
  rows: readonly CompareRow[],
  filter: CompareFilter,
  query: string,
): CompareRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q !== "" && !r.relPath.toLowerCase().includes(q)) return false;
    switch (filter) {
      case "all":
        return r.status !== "same";
      case "missing":
        return r.status === "missing";
      case "changed":
        return r.status === "differs";
      case "identical":
        return true;
    }
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Epoch seconds or milliseconds → local date/time text. */
export function formatBackupTime(at: number): string {
  const ms = at < 1e12 ? at * 1000 : at;
  return new Date(ms).toLocaleString();
}

/** `<folder>/naiteh-backup/<vault>` with the folder's own separator. */
export function driveDestination(folder: string, vaultName: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  const base = folder.replace(/[\\/]+$/, "");
  return `${base}${sep}naiteh-backup${sep}${vaultName}`;
}

