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

/** Note / web clipping / journal entry — the day timeline marker icon. */
export type DocKind = "note" | "clip" | "journal";

/**
 * Where a timeline item sits on the day timeline (vault/wiki/ipc-api.md,
 * "timeline_range"). Local display data only — never sent to a calendar.
 */
export interface TimelinePlacement {
  /** Front-matter `created` with a time (RFC 3339, local offset). */
  createdAt: string | null;
  /** `createdAt`, else the file mtime; `null` for a date-only `created`. */
  placedAt: string | null;
  docKind: DocKind;
  /** Host of a clip's `source_url`. */
  sourceHost: string | null;
}

export type TimelineItem =
  | ({
      kind: "JournalEntry";
      date: string;
      path: string;
      mtime: number;
      title: string;
      snippet: string;
    } & TimelinePlacement)
  | ({
      kind: "Note";
      relPath: string;
      title: string;
      mtime: number;
      snippet: string;
      pinned: boolean;
    } & TimelinePlacement);

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

/**
 * A note's text plus its version token: the hex SHA-256 of the file bytes
 * as read. Writes send it back as `expectedVersion` so a file that changed
 * on disk meanwhile (Google Drive sync, another editor) is never silently
 * overwritten — see `AppError` kind `StaleWrite`.
 */
export interface NoteDocument {
  content: string;
  version: string;
}

export interface NoteWriteResult {
  meta: NoteMeta;
  /** Version token of the bytes just written. */
  version: string;
}

export interface JournalOpenResult {
  path: string;
  content: string;
  exists: boolean;
  /** Version token of the entry on disk; `""` when it doesn't exist yet. */
  version: string;
}

export interface JournalSaveResult {
  path: string;
  mtime: number;
  version: string;
}

// ── vault watcher events (lib/vaultWatch) ───────────────────────────────

export type VaultChangeKind = "created" | "modified" | "removed";

export interface VaultChange {
  /** Vault-relative, forward slashes. Renames arrive as removed + created. */
  relPath: string;
  kind: VaultChangeKind;
  /** True when naiteh itself caused the change (autosave, create, delete…). */
  own: boolean;
}

/** Payload of the `vault:changed` Tauri event. */
export interface VaultChangedPayload {
  vaultRoot: string;
  changes: VaultChange[];
  /** The watcher lost events: treat everything as possibly changed. */
  overflow: boolean;
}

/** Payload of the `vault:watch-error` Tauri event. */
export interface VaultWatchErrorPayload {
  vaultRoot: string;
  message: string;
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
  /** Uncommitted changes, ignoring `.conflict-…` sidecars. */
  dirty: boolean;
  lastSync: number | null;
  /**
   * A pull left conflicts behind: true until every conflict sidecar is
   * resolved. The backend refuses to sync while this is set.
   */
  mergePending: boolean;
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

/** Chat providers (wiki: app-config). `ollama` / `lmstudio` need no key. */
export const AI_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "zai",
  "ollama",
  "lmstudio",
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** Per-provider settings. The API key is write-only: only its presence crosses IPC. */
export interface AiProviderConfig {
  hasApiKey: boolean;
  baseUrl: string;
}

/** Chat-in-a-note settings (port of chatgpt-md). */
export interface AiSettings {
  /** `provider@model`, e.g. `openai@gpt-4.1-mini`. */
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  stream: boolean;
  /** Heading level (1–6) of the `role::` lines written into chat notes. */
  headingLevel: number;
  inferTitleLanguage: string;
  chatsFolder: string;
  agentsFolder: string;
}

export interface AiConfig extends AiSettings {
  providers: Record<AiProviderId, AiProviderConfig>;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  defaultModel: "openai@gpt-4.1-mini",
  temperature: 1,
  maxTokens: 400,
  stream: true,
  headingLevel: 3,
  inferTitleLanguage: "English",
  chatsFolder: "notes/chats",
  agentsFolder: "notes/agents",
};

const DEFAULT_BASE_URLS: Record<AiProviderId, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  openrouter: "https://openrouter.ai/api/v1",
  zai: "https://api.z.ai/api/paas/v4",
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
};

/** Config defaults (also the plain-browser fallback and test fixture). */
export function defaultAiConfig(): AiConfig {
  const providers = {} as Record<AiProviderId, AiProviderConfig>;
  for (const id of AI_PROVIDERS) {
    providers[id] = { hasApiKey: false, baseUrl: DEFAULT_BASE_URLS[id] };
  }
  return { ...DEFAULT_AI_SETTINGS, providers };
}

export type UserRole = "Admin" | "User";

export const USER_ROLES: readonly UserRole[] = ["User", "Admin"];

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
  /** The account must set a new password before using the app. */
  mustChangePassword: boolean;
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
  appearance: AppearanceConfig;
  clipping: ClippingConfig;
}

/** Palette ids — keep in sync with `PALETTES` in services/config.rs. */
export const PALETTE_IDS = [
  "default",
  "ocean",
  "forest",
  "sunset",
  "lavender",
  "rose",
  "nord",
  "midnight",
] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

/** Empty font strings mean "use the built-in default stack". */
export interface AppearanceConfig {
  palette: string;
  uiFont: string;
  editorFont: string;
}

export const FONT_FAMILY_MAX_LEN = 200;

/** How pasted / clipped HTML becomes Markdown (wiki app-config.md, Clipping). */
export interface ClippingConfig {
  htmlPaste: "markdown" | "plain" | "html";
  headingStyle: "atx" | "setext";
  bulletMarker: "-" | "*" | "+";
  codeBlockStyle: "fenced" | "indented";
  emphasis: "_" | "*";
  strong: "**" | "__";
  linkStyle: "inline" | "reference";
  images: "keep" | "drop";
  tables: "gfm" | "html" | "text";
}

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  palette: "default",
  uiFont: "",
  editorFont: "",
};

export const DEFAULT_CLIPPING: ClippingConfig = {
  htmlPaste: "markdown",
  headingStyle: "atx",
  bulletMarker: "-",
  codeBlockStyle: "fenced",
  emphasis: "_",
  strong: "**",
  linkStyle: "inline",
  images: "keep",
  tables: "gfm",
};

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
  /**
   * Bad credentials / not permitted — and, for every non-auth command,
   * "no active session" (the backend session gate; see lib/api/invoke).
   */
  | { kind: "Unauthorized"; message: string }
  | { kind: "Validation"; message: string }
  | { kind: "Network"; message: string }
  | { kind: "Upstream"; message: string }
  /**
   * A write with `expectedVersion` was refused because the file on disk
   * has a different version (or is gone). `message` carries the current
   * on-disk version token — `""` when the file no longer exists.
   */
  | { kind: "StaleWrite"; message: string }
  | { kind: "Cancelled" };

export function isAppError(err: unknown): err is AppError {
  if (typeof err !== "object" || err === null) return false;
  if (!("kind" in err)) return false;
  const kind = (err as { kind: unknown }).kind;
  return typeof kind === "string";
}

/** The optimistic-concurrency refusal; `message` is the on-disk version. */
export function isStaleWrite(
  err: unknown,
): err is { kind: "StaleWrite"; message: string } {
  return isAppError(err) && err.kind === "StaleWrite";
}

export function formatAppError(err: unknown): string {
  if (isAppError(err)) {
    if (err.kind === "Cancelled") return "Operation cancelled";
    if (err.kind === "Network") return `Network error — ${err.message}`;
    if (err.kind === "Upstream") return `Service error — ${err.message}`;
    if (err.kind === "StaleWrite") return "The file changed on disk";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Calendar subscriptions (ICS feeds; wiki: ipc-commands, calendar_*)
// ---------------------------------------------------------------------------

export type CalendarKind = "google" | "apple" | "ics";

export const CALENDAR_COLORS = [
  "orange",
  "gray",
  "green",
  "blue",
  "purple",
  "red",
  "teal",
  "pink",
] as const;

export type CalendarColor = (typeof CALENDAR_COLORS)[number];

export interface CalendarSource {
  id: string;
  name: string;
  kind: CalendarKind;
  color: CalendarColor;
  enabled: boolean;
  /** Host of the feed URL (the secret URL itself never reaches the UI). */
  urlHost: string;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  /** RFC3339 with offset, or `YYYY-MM-DD` when `allDay`. */
  start: string;
  /** Exclusive end; same format as `start`. */
  end: string;
  allDay: boolean;
  cancelled: boolean;
  location: string | null;
  description: string | null;
  /** Vault-relative path of the linked meeting note, if one exists. */
  noteRelPath: string | null;
}
