// Mirrors src-tauri/src/domain/types.rs and error.rs.
// Field names match Rust serde camelCase output.

export interface VaultInfo {
  root: string;
  name: string;
  initialized: boolean;
}

export interface NoteMeta {
  path: string;
  relPath: string;
  title: string;
  tags: string[];
  mtime: number;
  size: number;
  pinned: boolean;
}

export type TimelineItem =
  | {
      kind: "JournalEntry";
      date: string;
      path: string;
      mtime: number;
      title: string;
      snippet: string;
    }
  | {
      kind: "Note";
      relPath: string;
      title: string;
      mtime: number;
      snippet: string;
      pinned: boolean;
    };

export interface TimelineDay {
  date: string;
  items: TimelineItem[];
}

export interface DayMeta {
  date: string;
  hasEntry: boolean;
  path: string | null;
  mtime: number | null;
  title: string | null;
  snippet: string | null;
}

export interface JournalOpenResult {
  path: string;
  content: string;
  exists: boolean;
}

export interface JournalSaveResult {
  path: string;
  mtime: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

export interface SearchHit {
  relPath: string;
  title: string;
  line: number;
  excerpt: string;
}

export interface SyncStatus {
  remoteUrl: string | null;
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  lastSync: number | null;
}

export type AppError =
  | { kind: "Io"; message: string }
  | { kind: "NotFound"; message: string }
  | { kind: "InvalidPath"; message: string }
  | { kind: "AlreadyInitialized"; message: string }
  | { kind: "Conflict"; message: string }
  | { kind: "ConfigCorrupt"; message: string }
  | { kind: "Cancelled" };

export function isAppError(err: unknown): err is AppError {
  if (typeof err !== "object" || err === null) return false;
  if (!("kind" in err)) return false;
  const kind = (err as { kind: unknown }).kind;
  return typeof kind === "string";
}

export function formatAppError(err: unknown): string {
  if (isAppError(err)) {
    if (err.kind === "Cancelled") return "Operation cancelled";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
