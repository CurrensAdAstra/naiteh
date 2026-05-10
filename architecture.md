# naiteh — Architecture

> Local-first, Markdown-based note-taking and journaling app.
> Hybrid of Obsidian (local Markdown vault) and Agenda (date-focused timeline).

This document is the **single source of truth** for naiteh's design.
All implementation tasks reference this file.

---

## 1. Product Overview

**naiteh** is a desktop note-taking app focused on:

1. **Quick capture + activity overview** — a journal mode that combines
   fast scratchpad writing with a summary of recent work.
2. **Date-focused browsing** — a calendar mode inspired by Agenda
   (agenda.com), with a timeline of notes grouped by day.
3. **Local-first Markdown notes** — all data lives as plain `.md` files
   on the user's disk.
4. **Sync / Backup** — backed by Git under the hood; the UI never says
   "Git", only "Sync" or "Backup".
5. **Tagging** — cross-cutting organization in addition to folders.
6. **AI Assist (opt-in)** — a side panel where the user can revise the
   currently selected text using a third-party Chat Completions API
   (default OpenAI). The API key lives in app config; no network call
   ever fires without an explicit click in the panel. naiteh stays
   local-first everywhere else — AI Assist is the one feature that
   knowingly leaves the local trust boundary.

### Non-goals (for v1)

- WYSIWYG editing (source-mode Markdown only)
- Backlinks / wiki-links / graph view (deferred to v2.0)
- Plugins / theming system
- Real-time collaboration
- Mobile app (revisited after v1.5)
- Calendar event integration (system Calendar / Reminders)
- Implicit AI calls — auto-completion, ghost text, background revision,
  embedding-based search, etc. v1 AI Assist is strictly user-initiated.

---

## 2. Tech Stack

| Layer             | Choice                                                    |
|-------------------|-----------------------------------------------------------|
| Shell             | **Tauri v2** (latest stable)                              |
| Backend language  | **Rust**                                                  |
| Frontend          | **React 18 + TypeScript + Vite**                          |
| Styling           | **CSS Modules**                                           |
| Editor            | **CodeMirror 6** (added in a later task)                  |
| Git integration   | **`git2` crate** (libgit2 bindings)                       |
| AI HTTP client    | **`reqwest` (rustls-tls)** — used only by AI Assist (§7.8)|
| Package manager   | **pnpm**                                                  |
| Target OS (v1)    | Windows, macOS, Linux                                     |

### Why these choices

- **Tauri v2**: small binary, Rust backend gives us safe filesystem + Git
  access, and v2 keeps the door open for mobile later.
- **CodeMirror 6** over Monaco: lighter, better Markdown support, mobile-
  friendly when we get there.
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
│       │   │   ├── tags/
│       │   │   ├── sync/
│       │   │   └── settings/
│       │   ├── lib/                   ← API wrappers around Tauri commands
│       │   ├── state/                 ← global state (Zustand)
│       │   └── styles/
│       │       ├── tokens.css         ← VS Code Light Modern tokens
│       │       └── reset.css
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
│               │   ├── search.rs
│               │   ├── tags.rs
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

The `apps/` prefix is used so we can later add `apps/mobile/` without
restructuring.

---

## 4. Vault

### 4.1 What is the vault?

A **vault** is a directory on the user's disk that contains all their notes,
journal entries, and metadata. naiteh never stores notes anywhere else.

### 4.2 Vault location

- **First run**: the app shows a setup screen asking the user to either
  (a) pick an existing folder, or (b) create a new folder.
- The chosen path is stored in app config (see §8).
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
├── notes/                    ← free-form notes; subfolders = "projects"
│   ├── _inbox/               ← quick notes captured in journal mode
│   ├── <project-A>/
│   ├── <project-B>/
│   └── ...
└── attachments/              ← images, PDFs etc. referenced from notes
```

Rules:

- One **journal entry** per calendar day. Filename is the local date in
  `YYYY-MM-DD.md`.
- A **"project"** in naiteh is simply a user-defined folder under `notes/`.
  There is no separate `projects/` directory and no project metadata file.
- `notes/_inbox/` is a reserved folder for quick captures from journal mode.
  The leading underscore keeps it sorted to the top and signals "system".
  Filenames are `YYYY-MM-DDTHH-MM-SS.md`.
- Folders inside `notes/` can be nested freely; naiteh does not impose
  structure beyond `_inbox/`.
- All files are UTF-8 Markdown. Front matter is optional but supported (YAML).

### 4.4 Front matter schema (optional)

```yaml
---
title: "Optional human title"
tags: [work, idea]
created: 2026-05-09T10:30:00+09:00
updated: 2026-05-09T11:00:00+09:00
pinned: false                # used by calendar's "On the Agenda" pin area
---
```

When front matter is absent, `title` falls back to the first H1 or the
filename, and timestamps fall back to filesystem mtime.

A future field `date: YYYY-MM-DD` is reserved for v1.5 to allow assigning
arbitrary notes to specific calendar days (Agenda-style). v1 does not
implement this — only journal entries and notes with `created`/`mtime` on
that date show up on the timeline.

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
- **Status Bar**: optional, 22px tall. Shows vault name, sync status,
  word count.

### 5.2 Theme

naiteh ships with a **light theme** by default, inspired by **VS Code's
"Light Modern"** theme (the default light theme in VS Code 1.80+).

Design tokens live in `apps/desktop/src/styles/tokens.css` as CSS custom
properties:

```css
:root {
  /* Surfaces */
  --color-bg-app:           #ffffff;
  --color-bg-activitybar:   #f8f8f8;
  --color-bg-listpanel:     #f3f3f3;
  --color-bg-editor:        #ffffff;
  --color-bg-statusbar:     #f8f8f8;

  /* Borders */
  --color-border:           #e5e5e5;
  --color-border-strong:    #d4d4d4;

  /* Text */
  --color-text-primary:     #3b3b3b;
  --color-text-secondary:   #616161;
  --color-text-muted:       #8c8c8c;
  --color-text-inverse:     #ffffff;

  /* Accents */
  --color-accent:           #005fb8;     /* VS Code Light Modern blue */
  --color-accent-hover:     #0078d4;
  --color-selection:        #cce4f7;

  /* Activity Bar */
  --color-activitybar-icon:        #424242;
  --color-activitybar-icon-active: #005fb8;
  --color-activitybar-active-bar:  #005fb8; /* left edge active indicator */

  /* States */
  --color-hover:            #ededed;
  --color-active:           #e0e0e0;
  --color-danger:           #c72e0f;
  --color-success:          #1f883d;

  /* Typography */
  --font-ui:    -apple-system, BlinkMacSystemFont, "Segoe UI",
                "Noto Sans KR", sans-serif;
  --font-mono:  "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace;
  --font-size-ui: 13px;
  --font-size-editor: 14px;
}
```

A dark theme may be added later but is **not** part of v1.

### 5.3 ViewMode

```ts
type ViewMode =
  | "journal"    // quick capture + recent activity summary
  | "notes"      // folder tree of notes/ (folders = "projects")
  | "calendar"   // Agenda-style timeline of notes by date
  | "search"     // full-text search
  | "tags"       // tag browser
  | "sync"       // sync/backup status & actions
  | "settings";  // app + vault settings
```

Activity Bar shows seven icons in this order:

```
┌──┐
│📓│ journal
│📁│ notes
│📅│ calendar
│🔍│ search
│🏷│ tags
│🔄│ sync
│⚙ │ settings
└──┘
```

(Icons above are placeholders; final icons use `lucide-react` or similar.)

Behavior:

- Clicking an Activity Bar icon updates `ViewMode`.
- Only the **List Panel** changes contents on mode switch.
- The **Editor Panel** preserves the currently open note across mode
  switches whenever possible.

### 5.4 Per-mode list panel

| ViewMode  | List Panel content                                                  |
|-----------|---------------------------------------------------------------------|
| journal   | Two stacked sections: Quick Capture (top) + Recent Activity (bottom)|
| notes     | Folder tree of `<vault>/notes/`. Top-level folders = "projects"     |
| calendar  | Agenda-style timeline of dated items                                |
| search    | Search input + result list (full-text)                              |
| tags      | Flat tag list with counts; selecting a tag shows its notes          |
| sync      | Last sync time, pending changes, "Sync now" button, log             |
| settings  | Setting categories                                                  |

### 5.5 Journal mode (quick capture + activity summary)

The journal mode is **not** the daily-journal-file editor. Daily journal
entries are reached from the **calendar** mode. Journal mode is the user's
"home base" for fast writing and seeing what they've been working on.

The List Panel for journal mode is split into two vertical sections with
a draggable divider (default 50/50, position persisted):

**Top — Quick Capture**
- A "+ New quick note" button at the top.
- Below: a list of recent quick notes from `notes/_inbox/`, newest first.
- Clicking a quick note opens it in the editor.
- Quick notes are full Markdown notes; they can be moved out of `_inbox/`
  into a project folder later (drag-drop, or from a context menu).

**Bottom — Recent Activity**
- A list of recently modified items from the whole vault, newest first.
- Mixes journal entries and regular notes.
- Each item shows: title, kind (journal/note), relative path, mtime,
  short snippet.
- Capped at ~50 items.

### 5.6 Calendar mode (Agenda-style timeline)

Inspired by agenda.com. The List Panel shows a **vertical timeline**, not
a month grid. The timeline runs newest-to-oldest by default, with a
"Today" marker and a sticky "On the Agenda" pin area at the top.

```
┌─────────────────────────────────┐
│ ★ On the Agenda                 │  ← pinned items (front matter pinned)
│   • Refactor sync flow          │
│   • Vacation packing list       │
├─────────────────────────────────┤
│ ── Today  Sat May 9 ──          │  ← sticky day separator
│   ▸ Daily journal               │     (journal entry for the day)
│   ▸ Standup notes               │     (note with mtime today)
├─────────────────────────────────┤
│ ── Fri May 8 ──                 │
│   ▸ Daily journal               │
├─────────────────────────────────┤
│ ── Thu May 7 ──                 │
│   ▸ Daily journal               │
│   ▸ Design review               │
├─────────────────────────────────┤
│ ...                             │
└─────────────────────────────────┘
```

Behaviors:

- Each day section header is sticky as the user scrolls.
- Days with no items are collapsed to a single "—" line by default;
  clicking expands them and **creates the journal entry on demand**
  if the user starts writing.
- A small toolbar at the top toggles between **Timeline** (default) and
  **Month grid** sub-views. Month grid is a compact alternative for
  date-jumping; clicking a date scrolls the timeline to that date.
- "On the Agenda" pin area lists notes/journal entries with
  `pinned: true` in front matter. Toggling pin is available from the
  editor's status bar.

What goes on a given day in v1:

1. The journal entry file `journal/YYYY/MM/YYYY-MM-DD.md` if it exists.
2. Any note whose filesystem mtime falls on that date.

In v1.5 we plan to add front matter `date: YYYY-MM-DD` to let users
explicitly assign notes to past or future dates (true Agenda-style
"plan-ahead" notes). v1 does not implement this.

---

## 6. Domain Model

All types are defined in Rust (`src-tauri/src/domain/types.rs`) and
mirrored in TypeScript (`src/lib/types.ts`). Field names use `camelCase`
over the IPC boundary (Tauri default with
`serde(rename_all = "camelCase")`).

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
    pub pinned: bool,           // from front matter
}
```

### 6.3 Activity / Timeline items

```rust
/// Used by both the journal mode "Recent Activity" list and the
/// calendar mode timeline.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum TimelineItem {
    JournalEntry {
        date: String,       // "YYYY-MM-DD"
        path: String,
        mtime: i64,
        title: String,
        snippet: String,
    },
    Note {
        rel_path: String,
        title: String,
        mtime: i64,
        snippet: String,
        pinned: bool,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDay {
    pub date: String,           // "YYYY-MM-DD" local
    pub items: Vec<TimelineItem>,
}
```

### 6.4 Vault

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub initialized: bool,      // true if .naiteh/ exists
}
```

### 6.5 Search & Tags

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel_path: String,
    pub title: String,
    pub line: u32,
    pub excerpt: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}
```

### 6.6 Sync

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub remote_url: Option<String>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub last_sync: Option<i64>,
}
```

### 6.7 AI Assist

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub api_key: Option<String>,   // None disables the feature in the UI
    pub model: String,             // e.g. "gpt-4o-mini"
    pub base_url: String,          // OpenAI-compatible base URL
}
```

`AiConfig` is part of the app-level config (§8). The `api_key` is stored
in plaintext under the user's app-config directory; OS-level user-account
permissions are the trust boundary. v1 does not use the system keychain.

---

## 7. Tauri Commands (IPC API)

All commands return `Result<T, AppError>`. `AppError` serializes to a
tagged union for the frontend.

### 7.1 Vault

```rust
vault_pick_folder() -> Result<VaultInfo, AppError>
vault_init(root: String) -> Result<VaultInfo, AppError>
vault_current() -> Result<Option<VaultInfo>, AppError>
vault_set_active(root: String) -> Result<VaultInfo, AppError>
vault_list_known() -> Result<Vec<VaultInfo>, AppError>
```

### 7.2 Journal (daily entry CRUD)

```rust
journal_month_meta(year: u16, month: u8) -> Result<Vec<DayMeta>, AppError>
journal_open(date: String) -> Result<JournalOpenResult, AppError>
journal_save(date: String, content: String) -> Result<JournalSaveResult, AppError>
```

### 7.3 Quick capture (journal mode top section)

```rust
quick_create() -> Result<NoteMeta, AppError>
// Creates an empty note in notes/_inbox/ with timestamp filename.

quick_list(limit: u32) -> Result<Vec<NoteMeta>, AppError>
// Recent items from notes/_inbox/, newest first.
```

### 7.4 Activity & Timeline

```rust
activity_recent(limit: u32) -> Result<Vec<TimelineItem>, AppError>
// For journal mode bottom section. Mixes entries and notes by mtime.

timeline_range(from: String, to: String) -> Result<Vec<TimelineDay>, AppError>
// For calendar mode. "from" and "to" are inclusive "YYYY-MM-DD" dates.
// Returns one TimelineDay per date in range, including empty days.

timeline_pinned() -> Result<Vec<TimelineItem>, AppError>
// For "On the Agenda" pin area.
```

### 7.5 Notes

```rust
notes_list(rel_dir: Option<String>) -> Result<Vec<NoteMeta>, AppError>
notes_read(rel_path: String) -> Result<String, AppError>
notes_write(rel_path: String, content: String) -> Result<NoteMeta, AppError>
notes_create(rel_dir: String, title: String) -> Result<NoteMeta, AppError>
notes_delete(rel_path: String) -> Result<(), AppError>
notes_rename(from: String, to: String) -> Result<NoteMeta, AppError>
notes_set_pinned(rel_path: String, pinned: bool) -> Result<NoteMeta, AppError>
```

### 7.6 Search & Tags

```rust
search_text(query: String, limit: u32) -> Result<Vec<SearchHit>, AppError>
tags_list() -> Result<Vec<TagCount>, AppError>
tags_notes(tag: String) -> Result<Vec<NoteMeta>, AppError>
```

### 7.7 Sync (Git-backed, exposed as Sync/Backup)

```rust
sync_status() -> Result<SyncStatus, AppError>
sync_set_remote(url: String) -> Result<(), AppError>
sync_init() -> Result<(), AppError>
sync_pull() -> Result<SyncStatus, AppError>
sync_push() -> Result<SyncStatus, AppError>
sync_now() -> Result<SyncStatus, AppError>
```

The UI never exposes the words "git", "commit", "rebase", or "remote URL"
to casual users — it shows "Sync now", "Backup destination", etc. Power
users can see Git terms in advanced settings.

### 7.8 AI Assist

```rust
ai_improve(text: String, instruction: String) -> Result<String, AppError>
```

The only naiteh command that issues outbound HTTP outside the Sync
feature. Reads `AiConfig` (§6.7) from app config, calls the configured
Chat Completions endpoint with the user's API key, returns the model's
revised text. Errors when no API key is configured, when `text` or
`instruction` is empty, when the upstream returns a non-2xx status, or
when the request times out (60 s). The system prompt instructs the model
to return revised text only — no preamble or commentary — but third-party
providers are explicitly outside naiteh's trust boundary.

App-config setters live alongside the rest of the settings IPC:

```rust
app_config_get() -> Result<AppConfig, AppError>
app_config_set_editor(font_size: u16, line_wrapping: bool) -> Result<AppConfig, AppError>
app_config_set_ai(api_key: Option<String>, model: String, base_url: Option<String>) -> Result<AppConfig, AppError>
```

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
  "theme": "light",
  "editor": {
    "fontSize": 14,
    "lineWrapping": true
  },
  "calendar": {
    "subView": "timeline"
  },
  "journal": {
    "splitRatio": 0.5
  },
  "ai": {
    "apiKey": null,
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

Per-vault settings live in `<vault>/.naiteh/config.json`.

---

## 9. Concurrency & Safety

- **Atomic writes**: every file write goes via temp-file + rename.
- **No write while syncing**: `sync_now` takes a vault-level lock.
- **Auto-save**: editor debounces saves at 800 ms idle; explicit save on
  Ctrl/Cmd-S.
- **Conflict handling**: if `sync_pull` produces a Git conflict, naiteh
  keeps both versions as `<file>.md` and `<file>.conflict-<timestamp>.md`
  and surfaces a "resolve conflicts" UI in the Sync panel. v1 does not
  auto-merge.
- **Privacy boundary**: Sync (§7.7) sends note bytes to the user's chosen
  Git remote; AI Assist (§7.8) sends the selected passage to the user's
  configured Chat Completions endpoint. These are the only two outbound
  network paths in v1, and both are user-initiated. No telemetry, no
  background calls, no implicit AI rewriting.

---

## 10. Roadmap

### v1.0 (MVP)

- Vault picker + first-run setup
- 3-column shell with all seven ViewModes
- Journal: quick capture + recent activity
- Calendar: Agenda-style timeline (mtime-based) + month grid sub-view
- Notes: list + read + write + create (folders = projects)
- Markdown source editor (CodeMirror 6)
- Tag indexing from front matter
- Pinning via front matter `pinned: true`
- Full-text search (naive grep first; ripgrep-via-Rust later)
- Sync: init, set remote, sync now, basic conflict surfacing
- AI Assist side panel (opt-in; OpenAI Chat Completions by default)
- Light theme (VS Code Light Modern)

### v1.5

- Front matter `date: YYYY-MM-DD` for explicit date assignment
  (true Agenda-style plan-ahead notes on the timeline)
- Better editor UX (preview pane, slash commands)
- Attachment handling (drag-drop images)
- Improved search (indexed)
- Dark theme
- Mobile feasibility study (Tauri v2 mobile target)

### v2.0 (candidates)

- Backlinks & wiki-links
- Graph view
- Plugin system
- Mobile app (if v1.5 study is positive)
- System Calendar / Reminders integration

---

## 11. Glossary

| Term       | Meaning                                                       |
|------------|---------------------------------------------------------------|
| Vault      | The user-chosen root folder containing all notes              |
| Journal entry | A `.md` file in `journal/`; one per local date            |
| Quick note | A note in `notes/_inbox/`, captured from journal mode         |
| Note       | Any Markdown file under `<vault>/notes/`                      |
| Project    | A user-defined folder under `<vault>/notes/`. No separate dir |
| Sync       | User-facing name for Git-backed backup/synchronization        |
| ViewMode   | Which feature the List Panel is showing                       |
| Timeline   | Calendar mode's date-grouped list of notes/entries            |
| On the Agenda | The pinned area at the top of the calendar timeline        |
| AI Assist  | Opt-in side panel that sends selected text to a Chat Completions API and replaces it with the model's revision |
