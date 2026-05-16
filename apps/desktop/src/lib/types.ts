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

export interface ConflictPair {
  relPath: string;
  conflictRelPath: string;
  timestamp: string;
}

export interface AttachmentImport {
  relPath: string;
  fileName: string;
  markdown: string;
}

export interface EvernoteImportedNote {
  sourceTitle: string;
  relPath: string;
  warnings: string[];
}

export interface EvernoteImportReport {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  notes: EvernoteImportedNote[];
  errors: string[];
}

export interface EditorConfig {
  fontSize: number;
  lineWrapping: boolean;
}

export interface CalendarConfig {
  subView: string;
}

export interface JournalConfig {
  splitRatio: number;
}

export interface AiConfig {
  apiKey: string | null;
  model: string;
  baseUrl: string;
}

export type UserRole = "Admin" | "User";

export interface AuthUser {
  username: string;
  role: UserRole;
  active: boolean;
}

export interface AuthSession {
  username: string;
  role: UserRole;
}

export interface LoginResult {
  token: string;
  session: AuthSession;
}

export interface AuditLogEntry {
  timestamp: string;
  username: string;
  action: string;
  detail: string | null;
}

export interface AppConfig {
  activeVault: string | null;
  knownVaults: string[];
  theme: string;
  editor: EditorConfig;
  calendar: CalendarConfig;
  journal: JournalConfig;
  ai: AiConfig;
}

export const EDITOR_FONT_MIN = 8;
export const EDITOR_FONT_MAX = 32;
export const EDITOR_FONT_DEFAULT = 14;

export type LastOpened =
  | { kind: "Note"; relPath: string }
  | { kind: "Journal"; date: string };

export interface WorkspaceState {
  lastOpened: LastOpened | null;
}

export type AppError =
  | { kind: "Io"; message: string }
  | { kind: "NotFound"; message: string }
  | { kind: "InvalidPath"; message: string }
  | { kind: "AlreadyInitialized"; message: string }
  | { kind: "Conflict"; message: string }
  | { kind: "ConfigCorrupt"; message: string }
  | { kind: "Unauthorized"; message: string }
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
