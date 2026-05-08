# naiteh — Architecture

> Local-first, Markdown-based note-taking and journaling app.
> Hybrid of Obsidian (local Markdown vault, plain files) and a daily journal app.

This document is the **single source of truth** for naiteh's design.
All implementation tasks reference this file.

---

## 1. Product Overview

**naiteh** is a desktop note-taking app focused on:

1. **Daily journaling** — one Markdown file per day, browsable via a calendar.
2. **Local-first Markdown notes** — all data lives as plain `.md` files on the user's disk.
3. **Sync / Backup** — backed by Git under the hood; the UI never says "Git",
   only "Sync" or "Backup".
4. **Tagging** — cross-cutting organization in addition to folders.

### Non-goals (for v1)

- WYSIWYG editing (source-mode Markdown only in v1)
- Backlinks / wiki-links / graph view (deferred)
- Plugins / theming system
- Real-time collaboration
- Mobile app (revisited after v1.5)

---

## 2. Tech Stack

| Layer            | Choice                                  |
|------------------|-----------------------------------------|
| Shell            | **Tauri v2** (latest stable)            |
| Backend language | **Rust**                                |
| Frontend         | **React 18 + TypeScript + Vite**        |
| Styling          | **CSS Modules** (no Tailwind in v1)     |
| Editor           | **CodeMirror 6** (added in a later task)|
| Git integration  | **`git2` crate** (libgit2 bindings)     |
| Package manager  | **pnpm**                                |
| Target OS (v1)   | Windows, macOS, Linux                   |

### Why these choices

- **Tauri v2**: small binary, Rust backend gives us safe filesystem + Git access,
  and v2 keeps the door open for mobile later.
- **CodeMirror 6** over Monaco: lighter, better Markdown support, mobile-friendly
  when we get there.
- **CSS Modules**: zero runtime, no extra build complexity, scoped styles.
- **pnpm**: fast, disk-efficient, good monorepo support if we expand.

---

## 3. Repository Layout

```
naiteh/
├── architecture.md            ← this file (do not edit during tasks)
├── package.json               ← pnpm workspace root
├── pnpm-workspace.yaml
├── apps/
│   └── desktop/
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── index.html
│       ├── src/                       ← React frontend
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── shell/                 ← AppShell, ActivityBar, panels
│       │   ├── features/
│       │   │   ├── journal/
│       │   │   ├── notes/
│       │   │   ├── calendar/
│       │   │   ├── search/
│       │   │   ├── sync/
│       │   │   └── settings/
│       │   ├── lib/                   ← API wrappers around Tauri commands
│       │   ├── state/                 ← global state (Zustand or similar)
│       │   └── styles/
│       └── src-tauri/                 ← Rust backend
│           ├── Cargo.toml
│           ├── tauri.conf.json
│           └── src/
│               ├── main.rs
│               ├── lib.rs
│               ├── commands/
│               │   ├── mod.rs
│               │   ├── journal.rs
│               │   ├── notes.rs
│               │   ├── vault.rs
│               │   └── sync.rs
│               ├── domain/             ← pure domain types
│               │   ├── mod.rs
│               │   └── types.rs
│               └── services/           ← filesystem, git, etc.
│                   ├── mod.rs
│                   ├── fs.rs
│                   └── git.rs
└── README.md
```

The `apps/` prefix is used so we can later add `apps/mobile/` without restructuring.

---

## 4. Vault

### 4.1 What is the vault?

A **vault** is a directory on the user's disk that contains all their notes,
journal entries, and metadata. naiteh never stores notes anywhere else.

### 4.2 Vault location

- **First run**: the app shows a setup screen asking the user to either
  (a) pick an existing folder, or (b) create a new folder.
- The chosen path is stored in app config (see §7).
- The user can change the active vault from Settings later.
- naiteh can remember **multiple vaults**, but only one is active at a time.

### 4.3 Vault layout

```
<vault-root>/
├── .naiteh/                  ← app metadata (committed to Git)
│   ├── config.json           ← per-vault settings
│   └── tags.json             ← tag index (rebuildable cache)
├── .git/                     ← managed by Sync feature, hidden from UI
├── journal/
│   └── YYYY/
│       └── MM/
│           └── YYYY-MM-DD.md
├── notes/                    ← free-form notes (folders allowed)
│   └── ...
└── attachments/              ← images, PDFs etc. referenced from notes
    └── ...
```

Rules:

- One journal entry per calendar day. Filename is the local date in
  `YYYY-MM-DD.md`.
- Folders inside `notes/` are user-defined; naiteh does not impose structure.
- All files are UTF-8 Markdown. Front matter is optional but supported (YAML).

### 4.4 Front matter schema (optional)

```yaml
---
title: "Optional human title"
tags: [work, idea]
created: 2026-05-09T10:30:00+09:00
updated: 2026-05-09T11:00:00+09:00
---
```

When front matter is absent, `title` falls back to the first H1 or the filename,
and timestamps fall back to filesystem mtime.

---

## 5. UI Architecture

### 5.1 Layout (desktop, v1)

VS Code-like 3-column shell:

```
┌──┬─────────────┬──────────────────────────────┐
│A │ List Panel  │ Editor Panel                 │
│c │             │                              │
│t │ (varies by  │ (markdown source editor      │
│  │  view mode) │  for the currently open note)│
│B │             │                              │
│a │             │                              │
│r │             │                              │
└──┴─────────────┴──────────────────────────────┘
                  Status Bar (optional)
```

- **Activity Bar**: fixed width 48px. One icon per `ViewMode`.
- **List Panel**: resizable width (default 280px, min 200px, max 480px).
- **Editor Panel**: fills remaining space.
- **Status Bar**: optional, 22px tall. Shows vault name, sync status, word count.

Theme: dark-mode VS Code-ish. Exact tokens in `src/styles/tokens.css`.

### 5.2 ViewMode

```ts
type ViewMode =
  | "journal"    // calendar + daily entries
  | "notes"      // free-form notes browser
  | "search"     // full-text search
  | "tags"       // tag browser
  | "sync"       // sync/backup status & actions
  | "settings";  // app + vault settings
```

Behavior:

- Clicking an Activity Bar icon updates `ViewMode`.
- Only the **List Panel** changes contents on mode switch.
- The **Editor Panel** preserves the currently open note across mode switches
  whenever possible.

### 5.3 Per-mode list panel

| ViewMode  | List Panel content                                              |
|-----------|-----------------------------------------------------------------|
| journal   | Calendar (month view) + recent-entries list                     |
| notes     | Folder tree of `<vault>/notes/`                                 |
| search    | Search input + result list                                      |
| tags      | Flat tag list with counts; selecting a tag shows its notes      |
| sync      | Last sync time, pending changes, "Sync now" button, log         |
| settings  | Setting categories                                              |

---

## 6. Domain Model

All types are defined in Rust (`src-tauri/src/domain/types.rs`) and mirrored
in TypeScript (`src/lib/types.ts`). Field names use `camelCase` over the IPC
boundary (Tauri default with `serde(rename_all = "camelCase")`).

### 6.1 Journal

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayMeta {
    pub date: String,           // "YYYY-MM-DD" (local date)
    pub has_entry: bool,
    pub path: Option<String>,   // absolute path when has_entry is true
    pub mtime: Option<i64>,     // unix epoch seconds, UTC
    pub title: Option<String>,
    pub snippet: Option<String>,// first ~200 chars of body, no front matter
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOpenResult {
    pub path: String,
    pub content: String,
    pub exists: bool,           // false when the file was just created
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSaveResult {
    pub path: String,
    pub mtime: i64,             // unix epoch seconds, UTC
}
```

### 6.2 Notes

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,           // absolute path
    pub rel_path: String,       // relative to vault root, forward slashes
    pub title: String,
    pub tags: Vec<String>,
    pub mtime: i64,
    pub size: u64,
}
```

### 6.3 Vault

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,           // folder name by default
    pub initialized: bool,      // true if .naiteh/ exists
}
```

### 6.4 Sync

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub remote_url: Option<String>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,            // uncommitted changes exist
    pub last_sync: Option<i64>, // unix epoch seconds
}
```

---

## 7. Tauri Commands (IPC API)

All commands return `Result<T, AppError>`. `AppError` serializes to a tagged
union for the frontend.

### 7.1 Vault

```rust
vault_pick_folder() -> Result<VaultInfo, AppError>
// Opens native folder picker, validates the chosen path.

vault_init(root: String) -> Result<VaultInfo, AppError>
// Creates .naiteh/ and base subfolders if missing.

vault_current() -> Result<Option<VaultInfo>, AppError>
// Returns the active vault, if any.

vault_set_active(root: String) -> Result<VaultInfo, AppError>
// Switches the active vault and updates app config.

vault_list_known() -> Result<Vec<VaultInfo>, AppError>
// All vaults the app has seen before.
```

### 7.2 Journal

```rust
journal_month_meta(year: u16, month: u8) -> Result<Vec<DayMeta>, AppError>
// One entry per day in the given month. has_entry=false for empty days.

journal_open(date: String) -> Result<JournalOpenResult, AppError>
// Opens (or creates) the entry for "YYYY-MM-DD". Does NOT save anything.

journal_save(date: String, content: String) -> Result<JournalSaveResult, AppError>
// Writes the file atomically (write-temp-then-rename).
```

### 7.3 Notes

```rust
notes_list(rel_dir: Option<String>) -> Result<Vec<NoteMeta>, AppError>
notes_read(rel_path: String) -> Result<String, AppError>
notes_write(rel_path: String, content: String) -> Result<NoteMeta, AppError>
notes_create(rel_dir: String, title: String) -> Result<NoteMeta, AppError>
notes_delete(rel_path: String) -> Result<(), AppError>
notes_rename(from: String, to: String) -> Result<NoteMeta, AppError>
```

### 7.4 Search & Tags

```rust
search_text(query: String, limit: u32) -> Result<Vec<SearchHit>, AppError>
tags_list() -> Result<Vec<TagCount>, AppError>
tags_notes(tag: String) -> Result<Vec<NoteMeta>, AppError>
```

### 7.5 Sync (Git-backed, exposed as Sync/Backup)

```rust
sync_status() -> Result<SyncStatus, AppError>
sync_set_remote(url: String) -> Result<(), AppError>
sync_init() -> Result<(), AppError>           // git init + first commit
sync_pull() -> Result<SyncStatus, AppError>
sync_push() -> Result<SyncStatus, AppError>
sync_now() -> Result<SyncStatus, AppError>    // commit + pull --rebase + push
```

The UI never exposes the words "git", "commit", "rebase", or "remote URL"
directly to casual users — it shows "Sync now", "Backup destination", etc.
Power users can see Git terms in advanced settings.

---

## 8. App Config

App-level config (not per-vault) lives in the OS app-config directory:

| OS      | Path                                                        |
|---------|-------------------------------------------------------------|
| Windows | `%APPDATA%\naiteh\config.json`                              |
| macOS   | `~/Library/Application Support/naiteh/config.json`          |
| Linux   | `~/.config/naiteh/config.json`                              |

Schema:

```json
{
  "activeVault": "/Users/me/Documents/MyVault",
  "knownVaults": [
    "/Users/me/Documents/MyVault",
    "/Users/me/Documents/Work"
  ],
  "theme": "dark",
  "editor": {
    "fontSize": 14,
    "lineWrapping": true
  }
}
```

Per-vault settings live in `<vault>/.naiteh/config.json`.

---

## 9. Concurrency & Safety

- **Atomic writes**: every file write goes via temp-file + rename.
- **No write while syncing**: `sync_now` takes a vault-level lock.
- **Auto-save**: editor debounces saves at 800 ms idle; explicit save on Ctrl/Cmd-S.
- **Conflict handling**: if `sync_pull` produces a Git conflict, naiteh keeps
  both versions as `<file>.md` and `<file>.conflict-<timestamp>.md` and surfaces
  a "resolve conflicts" UI in the Sync panel. v1 does not auto-merge.

---

## 10. Roadmap

### v1.0 (MVP)

- Vault picker + first-run setup
- 3-column shell with all six ViewModes
- Journal: calendar + daily file open/save
- Notes: list + read + write + create
- Markdown source editor (CodeMirror 6)
- Tag indexing from front matter
- Full-text search (naive grep first; ripgrep-via-Rust later)
- Sync: init, set remote, sync now, basic conflict surfacing

### v1.5

- Better editor UX (preview pane, slash commands)
- Attachment handling (drag-drop images)
- Improved search (indexed)
- Mobile feasibility study (Tauri v2 mobile target)

### v2.0 (candidates)

- Backlinks & wiki-links
- Graph view
- Plugin system
- Mobile app (if v1.5 study is positive)

---

## 11. Glossary

| Term       | Meaning                                                       |
|------------|---------------------------------------------------------------|
| Vault      | The user-chosen root folder containing all notes              |
| Journal    | The dated-entry feature; one `.md` file per local date        |
| Note       | Any Markdown file under `<vault>/notes/`                      |
| Sync       | User-facing name for Git-backed backup/synchronization        |
| ViewMode   | Which feature the List Panel is showing                       |
