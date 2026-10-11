---
title: "Domain Model"
tags: [naiteh-wiki, domain, types, ipc]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-11T12:00:00+09:00
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
    JournalEntry { date: String, path: String, mtime: i64, title: String, snippet: String },
    Note { rel_path: String, title: String, mtime: i64, snippet: String, pinned: bool },
}

pub struct TimelineDay { pub date: String, pub items: Vec<TimelineItem> } // date local "YYYY-MM-DD"
```

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

## AI Assist

```rust
pub struct AiConfig {              // on disk (config.json) — never sent over IPC
    pub api_key: Option<String>,   // optional — local providers need none
    pub model: String,             // e.g. "gpt-4o-mini" or "llama3.2"
    pub base_url: String,          // OpenAI-compatible base URL (https, or http on loopback)
}

pub struct AiConfigView {          // what the app_config_* commands return
    pub has_api_key: bool,         // wire: hasApiKey
    pub model: String,
    pub base_url: String,          // wire: baseUrl
}
```

The endpoint can be a hosted API (OpenAI, key required) or a local
OpenAI-compatible server such as **Ollama** (`http://localhost:11434/v1`), in
which case no key is needed and no note text leaves the machine. The feature is
"ready" when a model is set and either a key is configured (`hasApiKey`) or the
endpoint is local. `AiConfig` is part of app config; `api_key` is stored in
plaintext under the app-config directory (OS user permissions are the trust
boundary; v1 does not use the system keychain) and is write-only from the
renderer's point of view.

## Config types

`AppConfig` and its nested `EditorConfig` (`fontSize`, `lineWrapping`),
`CalendarConfig` (`subView`), `JournalConfig` (`splitRatio`),
`AppearanceConfig` (`palette`, `uiFont`, `editorFont`) and `ClippingConfig`
(HTML-paste conversion options) live in `services/config.rs` (not `domain/`). Over IPC the `app_config_*` commands
return `AppConfigView` — `AppConfig` with `ai` replaced by `AiConfigView` above —
mirrored in `types.ts`, where the frontend's `AppConfig` / `AiConfig`
interfaces **are** these view shapes (`ai.hasApiKey`, no `apiKey`). The full schema, defaults, and on-disk paths are in
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
