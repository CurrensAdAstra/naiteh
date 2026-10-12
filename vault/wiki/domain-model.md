---
title: "Domain Model"
tags: [naiteh-wiki, domain, types, ipc]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-12T12:00:00+09:00
pinned: false
---

# Domain Model

IPC-boundary types are defined in Rust under `src-tauri/src/domain/`, one module
per area (`error.rs`, `auth.rs`, `journal.rs`, `note.rs`, `search.rs`, `sync.rs`,
`vault.rs`, `attachment.rs`, `evernote.rs`, `watch.rs`), re-exported flat as
`crate::domain::Foo` via `mod.rs`, and mirrored in TypeScript (`src/lib/types.ts`).
A few types live next to the service that owns their serialized form:
`AppConfig` / `AiConfig` (on disk) and `AppConfigView` / `AiConfigView` (over
IPC) in `services/config.rs`, `LastOpened` / `WorkspaceState` in
`services/workspace.rs`, `ConflictPair` in `services/conflicts.rs`. Field names
are `camelCase` over the IPC boundary (the Rust field names shown below are
snake_case; they serialize camelCase via `#[serde(rename_all = "camelCase")]`).
Two exceptions: the `AppError` error type (incl. `Unauthorized`, returned by the
session gate and by credential / token failures, and `StaleWrite`, returned by
a refused conflict-safe write) is documented in [ipc-api.md](ipc-api.md), and
`UserRole` serializes as the bare PascalCase strings `"Admin"` / `"User"` (no
renaming, no tag — see below).

## Journal

```rust
pub struct DayMeta {
    pub date: String,            // "YYYY-MM-DD" (local date)
    pub has_entry: bool,
    pub path: Option<String>,    // absolute path when has_entry
    pub mtime: Option<i64>,      // unix epoch seconds, UTC
    pub title: Option<String>,
    pub snippet: Option<String>, // first ~200 chars of body, no front matter
}

pub struct JournalOpenResult {
    pub path: String, pub content: String, pub exists: bool,
    pub version: String,         // version of the bytes read; "" when !exists
}
pub struct JournalSaveResult {
    pub path: String, pub mtime: i64,
    pub version: String,         // version of the bytes just written
}
```

## Notes

```rust
pub struct NoteMeta {
    pub path: String,        // absolute path
    pub rel_path: String,    // relative to vault root, forward slashes
    pub title: String,
    pub tags: Vec<String>,
    pub mtime: i64,
    pub size: u64,
    pub pinned: bool,        // from front matter
}

pub struct NoteDocument {    // notes_read
    pub content: String,
    pub version: String,     // version of the bytes read
}

pub struct NoteWriteResult { // notes_write
    pub meta: NoteMeta,
    pub version: String,     // version of the bytes just written
}
```

**Version** — the lowercase hex SHA-256 of a file's bytes on disk (64
characters; `services/notes.rs` `file_version`). It is content-derived, so it
needs no shared state between machines and is identical wherever the same
bytes land (a Drive mirror, the other PC). `notes_read` / `journal_open`
return it, `notes_version` reads it cheaply, and `notes_write` /
`journal_save` take it back as `expected_version` for an optimistic
concurrency check: a mismatch is `AppError::StaleWrite(current_version)`
(`""` when the file no longer exists) and nothing is written. See
[IPC API → Notes](ipc-api.md#notes) and [Concurrency &
Safety](concurrency-safety.md).

## Activity / Timeline

```rust
// Used by both journal-mode "Recent Activity" and calendar-mode timeline.
#[serde(tag = "kind")]
pub enum TimelineItem {
    JournalEntry { date: String, path: String, mtime: i64, title: String, snippet: String,
                   #[serde(flatten)] placement: Placement },
    Note { rel_path: String, title: String, mtime: i64, snippet: String, pinned: bool,
           #[serde(flatten)] placement: Placement },
}

pub enum DocKind { Note, Clip, Journal }   // wire: "note" | "clip" | "journal"

pub struct Placement {                     // flattened, camelCase on the wire
    pub created_at: Option<String>,  // front-matter `created` with a time, RFC 3339 local offset
    pub placed_at: Option<String>,   // created_at, else file mtime (local); None if `created` is date-only
    pub doc_kind: DocKind,           // journal by path; clip (see below); else note
    pub source_host: Option<String>, // host of front-matter `source_url`
}

pub struct TimelineDay { pub date: String, pub items: Vec<TimelineItem> } // date local "YYYY-MM-DD"
```

- **`created`** (front matter) is parsed as RFC 3339 (`2026-05-09T14:30:00+09:00`,
  `…Z`), a naive local `YYYY-MM-DD HH:MM[:SS]` (space or `T`), or a bare
  `YYYY-MM-DD` (a day with no time). Anything else is ignored.
- **Clip** (web clipping): a note whose front matter has `source_url`,
  `clip_type`, or `imported_from: web-clipper`. Evernote imports that carry a
  `source_url` therefore also count as clips.
- `Placement` is local display data for the calendar-mode day timeline. It is
  never written to, or sent to, any calendar: subscriptions are read-only.
- The in-memory index (`services/index.rs` `IndexedDoc`) carries the parsed
  `created`, `doc_kind` and `source_host`, so timeline queries stay disk-free.

## Vault

```rust
pub struct VaultInfo { pub root: String, pub name: String, pub initialized: bool } // initialized = .naiteh/ exists
```

## Vault change events

Payloads of the two events the vault watcher pushes to the frontend
(`domain/watch.rs`; semantics in [IPC API → Events](ipc-api.md#events)):

```rust
#[serde(rename_all = "lowercase")]
pub enum ChangeKind { Created, Modified, Removed }     // "created" | "modified" | "removed"

pub struct VaultChange {
    pub rel_path: String,      // vault-relative, normal form; directories included
    pub kind: ChangeKind,
    pub own: bool,             // naiteh itself caused it (recorded within the 3 s own-change TTL)
}

pub struct VaultChanged {      // event `vault:changed` — one debounced batch
    pub vault_root: String,    // the watched vault (compare with VaultInfo.root)
    pub changes: Vec<VaultChange>,   // at most one entry per rel_path
    pub overflow: bool,        // OS watcher lost events → refresh everything; changes may be empty
}

pub struct VaultWatchError {   // event `vault:watch-error` — live updates unavailable
    pub vault_root: String,
    pub message: String,
}
```

## Search & Tags

```rust
pub struct SearchHit { pub rel_path: String, pub title: String, pub line: u32, pub excerpt: String }
pub struct TagCount { pub tag: String, pub count: u32 }
```

## Sync

```rust
pub struct SyncStatus {
    pub remote_url: Option<String>, pub branch: String,
    pub ahead: u32, pub behind: u32,
    pub dirty: bool,               // uncommitted changes, conflict sidecars excluded
    pub last_sync: Option<i64>,
    pub merge_pending: bool,       // wire: mergePending — a pull is waiting on unresolved
                                   // conflict sidecars; syncing is refused until they're gone
}

// One per `<file>.conflict-<timestamp>.<ext>` sidecar.
pub struct ConflictPair {
    pub rel_path: String,           // the live ("ours") file
    pub conflict_rel_path: String,  // the sidecar holding "theirs"
    pub timestamp: String,
}
```

## AI chat

Chat-in-note, ported from the
[chatgpt-md](https://github.com/bramses/chatgpt-md) Obsidian plugin (MIT).

### Chat note

Any Markdown note can be a chat; New Chat creates one in `ai.chatsFolder`.
The format is chatgpt-md's, byte for byte:

```markdown
---
model: anthropic@claude-sonnet-4
temperature: 0.3
system_commands: ['You are a concise assistant.']
---
What is a monad? See [[Category theory]].

<hr class="__chatgpt_plugin">

### role::assistant<span style="font-size: small;"> (anthropic@claude-sonnet-4)</span>

A monad is …

<hr class="__chatgpt_plugin">

### role::user

```

- **Messages.** The body (after front matter) is split on the separator
  `<hr class="__chatgpt_plugin">`. In each part, the first line containing
  `role::` is the **role header**: the role is whichever of `assistant`,
  `user`, `developer`, `system` appears first after `role::` (anything after
  it on the line, such as the `<span>` model label, is ignored); the content is
  the lines after the header, trimmed. A part with no `role::` line is a
  `user` message. Empty messages are dropped. Text between
  `=begin-chatgpt-md-comment` and `=end-chatgpt-md-comment` is removed
  first (an unterminated start marker stays). The header the editor writes
  is `#`×`ai.headingLevel` + ` role::assistant<span style="font-size: small;"> (<provider@model>)</span>`
  for replies and ` role::user` for the next turn.
- **Links** in user messages — `[[Name]]` (`|alias` / `#heading` ignored;
  matched case-insensitively against file-name stems, `notes/` first then
  the rest of the vault, hidden folders skipped, then against front-matter
  titles under `notes/`; a `[[dir/Name]]` matches that path) and
  `[text](rel.md)` (note-relative, then vault-relative; percent-decoding,
  `.md` targets only) — have the linked note's body (front matter stripped)
  appended to that message as
  `\n\nLink title: <title or file stem>\nLink content: <body>`. At most 10
  per message; duplicates once; missing or out-of-vault targets (checked
  with `resolve_in_vault`, so no symlink escapes) are skipped silently.
  Only the request is expanded — the note itself is never changed.
- **Front-matter keys** (scalar, `[a, b]` or `- item` lists): `model`
  (`provider@model`; a bare model means `openai`), `temperature`,
  `max_tokens`, `top_p`, `presence_penalty`, `frequency_penalty`,
  `system_commands` (string or list → system messages first, in order),
  `agent`, `url` (base-URL override, same rule as settings), `stream`.
  A non-numeric number / non-boolean `stream` is a `Validation` error.
- **Agent.** `agent: <name>` loads `<ai.agentsFolder>/<name>.md`. Its
  front matter is a settings layer below the note's (its `system_commands`
  apply only if the note has none); its body (comments removed, trimmed)
  becomes a system message after the `system_commands`.
- **Priority:** note front matter > agent front matter > global `ai`
  settings (`defaultModel`, `temperature`, `maxTokens`, `stream`).

Request order: `system_commands`, agent body, then the note's messages.

### IPC shapes

```rust
pub struct ChatSendResult {        // ai_chat_send result
    pub model: String,             // "provider@model" actually used
    pub text: String,              // the whole reply
}
// event "ai:chat-chunk" payload: { requestId: String, delta: String }

pub struct AiConfigView {          // ai in AppConfigView (no keys)
    pub default_model: String,     // "openai@gpt-4.1-mini"
    pub temperature: f64,
    pub max_tokens: u32,
    pub stream: bool,
    pub heading_level: u8,         // 1–6
    pub infer_title_language: String,
    pub chats_folder: String,
    pub agents_folder: String,
    pub providers: BTreeMap<String, ProviderView>, // all seven ids
}
pub struct ProviderView { pub has_api_key: bool, pub base_url: String }
```

On disk, `AiConfig` has the same scalars and
`providers: { <id>: { apiKey?, baseUrl } }`. Keys are stored in plaintext
under the app-config directory (OS user permissions are the trust boundary;
v1 does not use the system keychain) and are write-only from the
renderer's point of view.

## Config types

`AppConfig` and its nested `EditorConfig` (`fontSize`, `lineWrapping`),
`CalendarConfig` (`subView`), `JournalConfig` (`splitRatio`),
`AppearanceConfig` (`palette`, `uiFont`, `editorFont`), `ClippingConfig`
(HTML-paste conversion options) and `AiConfig` / `ProviderConfig` (`ai`, above) live in
`services/config.rs` (not `domain/`). Over IPC the `app_config_*` commands
return `AppConfigView` — `AppConfig` with `ai` replaced by `AiConfigView` above —
mirrored in `types.ts`, where the frontend's `AppConfig` / `AiConfig`
interfaces **are** these view shapes (`ai.providers.<id>.hasApiKey`, no `apiKey`). The full schema, defaults, and on-disk paths are in
[app-config.md](app-config.md).

## Auth & Audit

```rust
pub enum UserRole { Admin, User }
pub struct AuthUser   { pub username: String, pub role: UserRole, pub active: bool }
pub struct AuthSession { pub username: String, pub role: UserRole }
pub struct LoginResult {     // returned by auth_login and auth_resume
    pub token: String,
    pub session: AuthSession,
    pub must_change_password: bool,  // wire: mustChangePassword — seeded default still in use
}

pub struct AuditLogEntry {
    pub timestamp: String,       // RFC 3339 UTC
    pub username: String,        // attempted or authenticated username
    pub action: String,          // login_success, login_failure, note_open, ...
    pub detail: Option<String>,  // rel path, target account, failure reason
}
```

The local account store lives in the app-config directory. Passwords are
Argon2id-hashed and never exposed to the frontend; only `AuthUser` records cross
the IPC boundary. Each stored account also carries `mustChangePassword` (see
[IPC API → Auth & Audit](ipc-api.md#auth--audit)). `UserRole` serializes as
`"Admin"` / `"User"` (also the `role` argument of `auth_create_user`). The audit log is append-only JSONL at
`<app-config-dir>/audit-log.jsonl`, rotated to `audit-log.1.jsonl` at 5 MiB.

## Calendar subscriptions

Read-only iCal feeds (see [IPC API](ipc-api.md#calendar-subscriptions)).

```rust
pub struct CalendarSource {      // camelCase on the wire
    pub id: String,
    pub name: String,
    pub kind: String,            // "google" | "apple" | "ics"
    pub color: String,           // orange gray green blue purple red teal pink
    pub enabled: bool,
    pub url_host: String,        // host only; the full URL is a secret
    pub last_synced_at: Option<i64>, // unix seconds of the cached fetch
    pub last_error: Option<String>,  // last fetch failure, cleared on success
}

pub struct CalendarEvent {
    pub id: String,              // "<UID>@<instance key>", stable across fetches
    pub calendar_id: String,
    pub title: String,           // SUMMARY, "(untitled)" when empty
    pub start: String,           // RFC3339 with local offset; "YYYY-MM-DD" when all-day
    pub end: String,             // exclusive; same format as start
    pub all_day: bool,
    pub cancelled: bool,         // STATUS:CANCELLED
    pub location: Option<String>,
    pub description: Option<String>, // <= 2000 chars
    pub note_rel_path: Option<String>, // meeting note with this event_id
}
```

The instance key is the occurrence's original start: `YYYYMMDD` for all-day,
UTC `YYYYMMDDTHHMMSSZ` otherwise (a `RECURRENCE-ID` override keeps the key of
the instance it replaces). A **meeting note** is a note whose front matter has
`event_id: "<CalendarEvent.id>"` (plus `date`, `calendar`, optional `time`);
`calendar_event_note` creates them under `notes/meetings/`.

## Attachments, Workspace, Evernote import

```rust
pub struct AttachmentImport {
    pub rel_path: String,    // vault-relative path of the stored file
    pub file_name: String,
    pub markdown: String,    // snippet inserted at the editor cursor
}

#[serde(tag = "kind")]
pub enum LastOpened {        // machine-local last-opened (.naiteh/workspace.json)
    Note { rel_path: String },
    Journal { date: String },
}
pub struct WorkspaceState { pub last_opened: Option<LastOpened> }

pub struct EvernoteImportReport {
    pub imported_count: u32, pub skipped_count: u32, pub failed_count: u32,
    pub notes: Vec<EvernoteImportedNote>, pub errors: Vec<String>,
}
pub struct EvernoteImportedNote {
    pub source_title: String, pub rel_path: String,
    pub warnings: Vec<String>,  // e.g. dropped ink resources
}
```
