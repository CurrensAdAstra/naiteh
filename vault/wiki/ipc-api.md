---
title: "IPC API (Tauri Commands)"
tags: [naiteh-wiki, ipc, api, commands]
created: 2026-06-28T00:00:00+09:00
updated: 2026-06-29T09:00:00+09:00
pinned: false
---

# IPC API (Tauri Commands)

All commands return `Result<T, AppError>`. `AppError` serializes to the frontend
as a tagged union (`{ kind, message }`):

```rust
pub enum AppError {
    Io(String),                 // filesystem / process I/O
    NotFound(String),
    InvalidPath(String),        // lexical path-traversal / shape rejection
    AlreadyInitialized(String), // vault init re-run on an existing vault
    Conflict(String),           // dirty-tree pull, sync conflict, etc.
    ConfigCorrupt(String),
    Unauthorized(String),       // auth / session-token failures
    Validation(String),         // semantic input check (empty field, …)
    Network(String),            // transport didn't reach the remote
    Upstream(String),           // remote replied with error / bad body
    Cancelled,                  // user dismissed a picker / dialog
}
```

The frontend's `formatAppError` (`src/lib/types.ts`) prefixes the ambiguous
categories — `Network` ("Network error — …"), `Upstream` ("Service error — …"),
`Cancelled` ("Operation cancelled") — and shows the backend's message verbatim
for the rest. A network failure is never mislabelled as I/O.

## Vault

```rust
vault_pick_folder() -> Result<VaultInfo, AppError>
vault_init(root: String) -> Result<VaultInfo, AppError>
vault_current() -> Result<Option<VaultInfo>, AppError>
vault_set_active(root: String) -> Result<VaultInfo, AppError>
vault_list_known() -> Result<Vec<VaultInfo>, AppError>

// One-click first-run setup: create ~/Documents/duramen (deduped
// with -2, -3, … if taken), initialize it, make it active.
vault_create_default() -> Result<VaultInfo, AppError>
```

## Journal

```rust
journal_month_meta(year: u16, month: u8) -> Result<Vec<DayMeta>, AppError>
journal_open(date: String) -> Result<JournalOpenResult, AppError>
journal_save(date: String, content: String) -> Result<JournalSaveResult, AppError>
```

## Quick capture

```rust
quick_create() -> Result<NoteMeta, AppError>   // empty note in notes/_inbox/, timestamp filename
quick_list(limit: u32) -> Result<Vec<NoteMeta>, AppError>  // recent _inbox items, newest first
```

## Activity & Timeline

```rust
activity_recent(limit: u32) -> Result<Vec<TimelineItem>, AppError>  // journal mode; mixes entries+notes by mtime
timeline_range(from: String, to: String) -> Result<Vec<TimelineDay>, AppError>  // inclusive YYYY-MM-DD; one day per date, incl. empty
timeline_pinned() -> Result<Vec<TimelineItem>, AppError>  // "On the Agenda"
```

All three read the in-memory index snapshot (`services/index.rs` →
`services/timeline.rs`) rather than re-scanning per call.

## Notes

```rust
notes_list(rel_dir: Option<String>) -> Result<Vec<NoteMeta>, AppError>
notes_read(rel_path: String) -> Result<String, AppError>
notes_write(rel_path: String, content: String) -> Result<NoteMeta, AppError>
notes_create(rel_dir: String, title: String) -> Result<NoteMeta, AppError>
notes_delete(rel_path: String) -> Result<(), AppError>
notes_rename(from: String, to: String) -> Result<NoteMeta, AppError>
notes_set_pinned(rel_path: String, pinned: bool) -> Result<NoteMeta, AppError>

// Folder management. Vault-relative, must live strictly under notes/, symlink-safe
// via resolve_in_vault. The reserved notes/_inbox cannot be renamed or deleted.
notes_list_dirs() -> Result<Vec<String>, AppError>      // includes empty dirs
notes_create_dir(rel_dir: String) -> Result<(), AppError>
notes_delete_dir(rel_dir: String) -> Result<(), AppError>   // recursive
notes_rename_dir(from: String, to: String) -> Result<(), AppError>
```

## Search & Tags

```rust
search_text(query: String, limit: u32) -> Result<Vec<SearchHit>, AppError>
tags_list() -> Result<Vec<TagCount>, AppError>
tags_notes(tag: String) -> Result<Vec<NoteMeta>, AppError>
```

`tags_*` read the in-memory tag index (built lazily, invalidated by every write).
`search_text` still scans the vault per call (future index extension).

## Sync (Git-backed, exposed as Sync/Backup)

```rust
sync_status() -> Result<SyncStatus, AppError>
sync_set_remote(url: String) -> Result<(), AppError>
sync_init() -> Result<(), AppError>
sync_pull() -> Result<SyncStatus, AppError>
sync_push() -> Result<SyncStatus, AppError>
sync_now() -> Result<SyncStatus, AppError>

// Conflict resolution. keep_theirs derives the original path from the sidecar name.
sync_list_conflicts() -> Result<Vec<ConflictPair>, AppError>
sync_resolve_keep_ours(conflict_rel_path: String) -> Result<(), AppError>
sync_resolve_keep_theirs(conflict_rel_path: String) -> Result<(), AppError>
```

The UI never exposes "git", "commit", "rebase", or "remote URL" to casual users
— it shows "Sync now", "Backup destination", etc. Power users see Git terms in
advanced settings.

## AI Assist

```rust
ai_improve(text: String, instruction: String) -> Result<String, AppError>
ai_list_models() -> Result<Vec<String>, AppError>
```

`ai_improve` reads `AiConfig`, calls the configured Chat Completions endpoint,
returns the revised text. API key attached only when configured (local providers
send none). Errors when `text`/`instruction` is empty, upstream returns non-2xx,
or the request times out (60 s). `ai_list_models` queries `GET {base_url}/models`.

App-config setters:

```rust
app_config_get() -> Result<AppConfig, AppError>
app_config_set_editor(font_size: u16, line_wrapping: bool) -> Result<AppConfig, AppError>
app_config_set_ai(api_key: Option<String>, model: String, base_url: Option<String>) -> Result<AppConfig, AppError>
```

## Auth & Audit

```rust
auth_login(username: String, password: String, remember: bool) -> Result<LoginResult, AppError>
auth_resume() -> Result<Option<LoginResult>, AppError>
auth_logout(token: String)
auth_list_users(token: String) -> Result<Vec<AuthUser>, AppError>
auth_set_user_active(token: String, username: String, active: bool) -> Result<Vec<AuthUser>, AppError>
auth_list_audit_logs(token: String, limit: u32) -> Result<Vec<AuditLogEntry>, AppError>
auth_log_action(token: String, action: String, detail: Option<String>) -> Result<(), AppError>
```

`auth_login` returns `{ token, session }`; the token is a 256-bit hex string the
frontend stores in memory and passes to every subsequent auth IPC. The backend
resolves it via an in-process session map (`services::auth::SessionStore`) — no
path lets the frontend impersonate a user by passing a name string.
Account-management and audit reads require an **admin** token; `auth_log_action`
accepts any live token. `auth_set_user_active` refuses to deactivate `admin`.

**Remember me.** When `auth_login` is called with `remember: true`, the backend
persists `{ token, username, expiresAt }` to `remembered-session.json` in the
app-config dir (30-day TTL). On startup the frontend calls `auth_resume`, which
re-installs that token into the `SessionStore` and returns the session —
skipping the login screen — but only after re-checking the account is still
present and active (a role change or deactivation between runs is honoured; a
stale record is pruned). `remember: false` and `auth_logout` both delete the
file. The file sits in the same trust boundary as `auth.json` and the AI key:
only the local OS user can read it.

## Attachments

```rust
attachments_import() -> Result<AttachmentImport, AppError>  // native picker → copies into attachments/
attachments_import_bytes(bytes: Vec<u8>, suggested_name: String, mime: Option<String>) -> Result<AttachmentImport, AppError>
// clipboard paste / drag-drop. Empty suggested_name → synthesized paste-<timestamp>.<ext>
```

Both enforce a 50 MiB ceiling.

## Workspace (machine-local last-opened)

```rust
workspace_get() -> Result<WorkspaceState, AppError>
workspace_set_last_opened(last_opened: Option<LastOpened>) -> Result<WorkspaceState, AppError>
```

Persisted to gitignored `.naiteh/workspace.json` so each machine reopens its last
file in that vault.

## Evernote import

```rust
evernote_import() -> Result<EvernoteImportReport, AppError>
// native multi-file .enex picker → notes/<notebook>/<slug>/index.md with attachments alongside
```

Emits per-note progress on the `evernote-import-progress` event channel
(throttled to ~100 events/file):

```rust
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    file_index: usize, total_files: usize, file_name: String,
    note_done: usize, note_total: usize,
}
```

On the wire the frontend receives camelCase keys: `fileIndex`, `totalFiles`,
`fileName`, `noteDone`, `noteTotal`.

## Native menu events

Custom native-menu items emit `menu:*` events that `shell/useMenuEvents` routes
to store actions (not direct IPC):

| Event | Action |
|---|---|
| `menu:view` (payload: ViewMode) | Switch panel (Cmd+1..6) |
| `menu:command-palette` | Open the palette (Cmd+P) |
| `menu:toggle-ai` | Toggle AI Assist panel (Cmd+E) |
| `menu:settings` | Open the settings modal (Cmd+,) |
| `menu:new-note` | Notes panel new-note prompt (Cmd+N) |
| `menu:new-folder` | Notes panel new-folder prompt (Cmd+Shift+N) |
| `menu:import-evernote` | Settings modal Evernote import flow |

`ViewMode` is one of journal/notes/calendar/search/tags/sync. Settings
is **not** a view — it is a full-screen modal opened by `menu:settings`,
the Activity Bar gear, the status-bar user name, or the palette.

## Concurrency note

Every IPC that mutates the vault — the `notes_*` writers, `journal_save`,
`quick_create`, `attachments_*`, `evernote_import`, the `sync_*` commands, and
the conflict-resolution commands — acquires the per-vault mutex
(`services/vault_lock.rs`) before touching files and invalidates the tag index on
success. See [Concurrency & Safety](concurrency-safety.md).
