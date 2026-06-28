---
title: "Domain Model"
tags: [naiteh-wiki, domain, types, ipc]
created: 2026-06-28T00:00:00+09:00
updated: 2026-06-28T00:00:00+09:00
pinned: false
---

# Domain Model

IPC-boundary types are defined in Rust under `src-tauri/src/domain/`, one module
per area (`error.rs`, `auth.rs`, `journal.rs`, `note.rs`, `search.rs`, `sync.rs`,
`vault.rs`, `attachment.rs`, `evernote.rs`), re-exported flat as
`crate::domain::Foo` via `mod.rs`, and mirrored in TypeScript (`src/lib/types.ts`).
A few types live next to the service that owns their serialized form: `AiConfig`
in `services/config.rs`, `LastOpened` / `WorkspaceState` in
`services/workspace.rs`, `ConflictPair` in `services/conflicts.rs`. Field names
are `camelCase` over the IPC boundary (the Rust field names shown below are
snake_case; they serialize camelCase via `#[serde(rename_all = "camelCase")]`).
Two exceptions: the `AppError` error type is documented in
[ipc-api.md](ipc-api.md), and `UserRole` serializes as the bare PascalCase
strings `"Admin"` / `"User"` (no renaming, no tag — see below).

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

pub struct JournalOpenResult { pub path: String, pub content: String, pub exists: bool }
pub struct JournalSaveResult { pub path: String, pub mtime: i64 }
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
```

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

## Search & Tags

```rust
pub struct SearchHit { pub rel_path: String, pub title: String, pub line: u32, pub excerpt: String }
pub struct TagCount { pub tag: String, pub count: u32 }
```

## Sync

```rust
pub struct SyncStatus {
    pub remote_url: Option<String>, pub branch: String,
    pub ahead: u32, pub behind: u32, pub dirty: bool, pub last_sync: Option<i64>,
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
pub struct AiConfig {
    pub api_key: Option<String>,   // optional — local providers need none
    pub model: String,             // e.g. "gpt-4o-mini" or "llama3.2"
    pub base_url: String,          // OpenAI-compatible base URL
}
```

The endpoint can be a hosted API (OpenAI, key required) or a local
OpenAI-compatible server such as **Ollama** (`http://localhost:11434/v1`), in
which case no key is needed and no note text leaves the machine. The feature is
"ready" when a model is set and either a key is configured or the endpoint is
local. `AiConfig` is part of app config; `api_key` is stored in plaintext under
the app-config directory (OS user permissions are the trust boundary; v1 does
not use the system keychain).

## Config types

`AppConfig` and its nested `EditorConfig` (`fontSize`, `lineWrapping`),
`CalendarConfig` (`subView`), and `JournalConfig` (`splitRatio`) — plus `AiConfig`
above — cross the IPC boundary via the `app_config_*` commands. They live in
`services/config.rs` (not `domain/`) and are mirrored in `types.ts`. The full
schema, defaults, and on-disk paths are in [app-config.md](app-config.md).

## Auth & Audit

```rust
pub enum UserRole { Admin, User }
pub struct AuthUser   { pub username: String, pub role: UserRole, pub active: bool }
pub struct AuthSession { pub username: String, pub role: UserRole }
pub struct LoginResult { pub token: String, pub session: AuthSession } // returned by auth_login

pub struct AuditLogEntry {
    pub timestamp: String,       // RFC 3339 UTC
    pub username: String,        // attempted or authenticated username
    pub action: String,          // login_success, login_failure, note_open, ...
    pub detail: Option<String>,  // rel path, target account, failure reason
}
```

The local account store lives in the app-config directory. Passwords are
Argon2id-hashed and never exposed to the frontend; only `AuthUser` records cross
the IPC boundary. The audit log is append-only JSONL at
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
