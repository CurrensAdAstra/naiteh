# naiteh — Architecture

This is the **implementation reference** for naiteh: how the app is built,
structured, and evolves. It is the human/developer-facing surface and lives with
the code.

> **The canonical data lives in the LLM wiki, not here.**
> The *facts* an LLM or developer reasons over — domain model, IPC command
> spec, entity schemas, vault layout, config keys, glossary — are maintained as
> a single source of truth in the **LLM wiki** at `vault/wiki/` (start at
> [vault/wiki/index.md](vault/wiki/index.md)). This document does **not**
> duplicate them; see [§6](#6-data--api-reference). When a fact here disagrees
> with the wiki, the wiki wins.
>
> | Surface | Audience | Holds |
> |---------|----------|-------|
> | `architecture.md`, `docs/` | developer | how it's built, run, maintained — narrative, rationale, structure, roadmap |
> | `vault/wiki/` | LLM + developer | data/facts — schemas, IPC spec, config, glossary |

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
7. **Local user access control** — the app opens on a login screen before
   any vault content is shown. A single `admin` account is seeded on first
   run (password equals the username; change it from Settings). The admin
   creates further accounts in the UI. Login mints an opaque session
   token; the frontend passes that token, never a plain username, to
   every IPC that needs to know who is asking. Login offers an opt-in
   "keep me signed in on this device" (default on): the token is persisted
   to the app-config dir with a 30-day expiry and restored on the next
   launch via `auth_resume`, so single-user machines aren't re-prompted
   every start. Sign-out and unchecking the box both drop it; a
   deactivated account can't ride a stale token back in.

The canonical feature list and non-goals are mirrored in the wiki's
[product-overview.md](vault/wiki/product-overview.md).

### Non-goals (for v1)

- WYSIWYG editing (source-mode Markdown only)
- Backlinks / wiki-links / graph view (deferred to v2.0)
- Plugins / theming system
- Real-time collaboration
- Mobile app (revisited after v1.5)
- Calendar event integration (system Calendar / Reminders)
- Implicit AI calls — auto-completion, ghost text, background revision,
  embedding-based search, etc. v1 AI Assist is strictly user-initiated.
- Cloud identity, SSO, or multi-tenant server authorization. v1 auth is
  local app access control backed by the user's OS app-config directory.

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
| AI HTTP client    | **`reqwest` (rustls-tls)** — used only by AI Assist       |
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
├── CLAUDE.md                  ← agent entry point (points to the LLM wiki)
├── architecture.md            ← this file — implementation reference
├── vault/                     ← documentation vault (a naiteh-shaped store)
│   ├── journal/
│   ├── note/
│   └── wiki/                  ← LLM wiki: canonical data/facts (see §6)
├── docs/
│   └── sessions/              ← dated work-session summaries
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
│       │   │   ├── ai/                 ← AI Assist side panel
│       │   │   ├── auth/               ← login screen, admin dashboard
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
│               ├── lib.rs              ← Tauri builder, managed state, IPC registry
│               ├── commands/           ← thin IPC wrappers, one module per area
│               │   ├── mod.rs
│               │   ├── ai.rs
│               │   ├── attachments.rs
│               │   ├── auth.rs
│               │   ├── evernote.rs
│               │   ├── journal.rs
│               │   ├── notes.rs
│               │   ├── search.rs
│               │   ├── settings.rs
│               │   ├── sync.rs
│               │   ├── tags.rs
│               │   ├── vault.rs
│               │   └── workspace.rs
│               ├── domain/             ← pure domain types + AppError,
│               │   │                      grouped by area, re-exported flat
│               │   │                      as crate::domain::Foo (mod.rs)
│               │   ├── mod.rs
│               │   ├── error.rs         ← AppError
│               │   ├── attachment.rs    ← AttachmentImport
│               │   ├── auth.rs          ← UserRole, AuthUser, AuthSession,
│               │   │                      LoginResult, AuditLogEntry
│               │   ├── evernote.rs      ← EvernoteImportReport, …Note
│               │   ├── journal.rs       ← DayMeta, Journal*Result,
│               │   │                      TimelineItem, TimelineDay
│               │   ├── note.rs          ← NoteMeta
│               │   ├── search.rs        ← SearchHit, TagCount
│               │   ├── sync.rs          ← SyncStatus
│               │   └── vault.rs         ← VaultInfo
│               └── services/           ← side-effectful logic
│                   ├── mod.rs
│                   ├── attachments.rs
│                   ├── auth.rs         ← Argon2 accounts + SessionStore + audit log
│                   ├── config.rs
│                   ├── conflicts.rs    ← sync-conflict discovery + resolution
│                   ├── evernote/       ← .enex parser, ENML→MD, importer
│                   ├── fs.rs           ← atomic writes
│                   ├── fs_naming.rs    ← shared sanitize/MIME/label helpers
│                   ├── git.rs
│                   ├── index.rs        ← in-memory tag index (invalidated by writes)
│                   ├── notes.rs        ← front matter, slugify, resolve_in_vault
│                   ├── sync_state.rs
│                   ├── timeline.rs     ← activity/timeline items from the index
│                   ├── vault_lock.rs   ← per-vault write/sync mutex
│                   └── workspace.rs    ← per-vault last-opened state
└── README.md
```

The `apps/` prefix is used so we can later add `apps/mobile/` without
restructuring. The mapping from these `domain/` and `services/` modules to the
types and commands they expose is documented in the wiki
([domain-model.md](vault/wiki/domain-model.md),
[ipc-api.md](vault/wiki/ipc-api.md)).

---

## 4. UI Architecture

### 4.1 Layout (desktop, v1)

#### Authentication gate

The first screen at the dev URL root (`/`) and admin URL (`/admin`) is the
same local login screen. No vault, journal, note, sync, or settings content
is rendered before a successful login.

- `admin` is the only seeded account on first run; the admin creates
  further accounts in the Settings panel.
- Passwords are hashed with Argon2id (per-user salt embedded in the PHC
  string). Pre-token installs that still hold SHA-256 hashes are
  upgraded transparently on the next successful login.
- Successful login mints a 256-bit hex bearer token kept only in the
  Tauri process memory; restart logs everyone out. Every admin IPC
  takes that token and resolves it via the in-process session store.
- `/admin` does not bypass authentication; after a successful admin login it
  opens the Settings panel with the account-management section visible.
- Failed and successful login attempts are written to the audit log.

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

### 4.2 Theme

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

### 4.3 ViewMode

```ts
type ViewMode =
  | "journal"    // quick capture + recent activity summary
  | "notes"      // folder tree of notes/ (folders = "projects")
  | "calendar"   // Agenda-style timeline of notes by date
  | "search"     // full-text search
  | "tags"       // tag browser
  | "sync";      // sync/backup status & actions
```

Settings is intentionally **not** a `ViewMode` — it opens as a
full-screen modal (§4.3 shortcuts table), so it does not occupy a list
panel or an Activity Bar slot in the same way.

Activity Bar shows the six view icons plus a settings gear pinned below:

```
┌──┐
│📓│ journal
│📁│ notes
│📅│ calendar
│🔍│ search
│🏷│ tags
│🔄│ sync
│⚙ │ settings  ← opens the modal, not a ViewMode
└──┘
```

(Icons above are placeholders; final icons use `lucide-react` or similar.)

Behavior:

- Clicking an Activity Bar icon updates `ViewMode`.
- Only the **List Panel** changes contents on mode switch.
- The **Editor Panel** preserves the currently open note across mode
  switches whenever possible.

#### Application menu & keyboard shortcuts

The native menu (`src-tauri` `build_menu`) is the single source of the
global shortcuts. Custom items carry accelerators and emit `menu:*`
events that `shell/useMenuEvents` routes to store actions (the event
payloads are listed in the wiki's
[ipc-api.md](vault/wiki/ipc-api.md#native-menu-events)):

| Menu          | Item                | Shortcut          | Action |
|---------------|---------------------|-------------------|--------|
| naiteh        | Settings…           | Cmd/Ctrl+,        | Open the settings modal |
| File          | New Note            | Cmd/Ctrl+N        | Notes panel new-note prompt |
| File          | New Folder          | Cmd/Ctrl+Shift+N  | Notes panel new-folder prompt |
| File          | Import from Evernote… | —               | Settings modal import flow |
| View          | Journal … Sync      | Cmd/Ctrl+1 … 6    | Switch `ViewMode` |
| View          | Command Palette…    | Cmd/Ctrl+P        | Open the palette |
| View          | Toggle AI Assist    | Cmd/Ctrl+E        | Toggle the AI panel |

Settings is **not** a `ViewMode`; it is a full-screen modal
(`features/settings/SettingsModal`) overlaying the shell, opened from
the app menu (Cmd/Ctrl+,), the Activity Bar gear, the status-bar user
name, or the palette. It mirrors the Obsidian settings layout: a
left section nav (Vault, Editor, AI Assist, Import, plus Accounts /
Audit Log for admins) beside a scrolling column of "name + description →
control" rows. This replaced the cramped list-panel settings that shared
the 280 px sidebar.

The Edit menu uses the standard predefined items (undo/redo/cut/copy/
paste/select-all) with their usual shortcuts. The editor keeps its own
CodeMirror bindings (Cmd/Ctrl+B/I/`/Shift+X for formatting, Cmd/Ctrl+K
for link insertion, Cmd/Ctrl+S for save) — the palette deliberately
lives on Cmd/Ctrl+P so it doesn't collide with the editor's link
shortcut.

### 4.4 Per-mode list panel

| ViewMode  | List Panel content                                                  |
|-----------|---------------------------------------------------------------------|
| journal   | Two stacked sections: Quick Capture (top) + Recent Activity (bottom)|
| notes     | Folder tree of `<vault>/notes/`. Top-level folders = "projects"     |
| calendar  | Agenda-style timeline of dated items                                |
| search    | Search input + result list (full-text)                              |
| tags      | Flat tag list with counts; selecting a tag shows its notes          |
| sync      | Last sync time, pending changes, "Sync now" button, log             |

(Settings is a modal, not a list panel — see §4.3.)

### 4.5 Journal mode (quick capture + activity summary)

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

### 4.6 Calendar mode (Agenda-style timeline)

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

**Wide layout.** Calendar is the one view where the list panel is not
sized by the resizer. `AppShell` gives it `CALENDAR_LIST_RATIO` (0.7) of
the space it shares with the editor — a `calc()` on `--list-panel-width`
that subtracts the fixed activity / resizer / ai columns first, so the
month grid + timeline get ~70 % and the editor ~30 %. The drag handle is
hidden in calendar mode (the width is proportional, not drag-sized), and
`CalendarGrid` cells grow to a 52 px min-height so the month reads as a
real calendar rather than a flat strip.

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

## 5. Roadmap

### v1.0 (MVP)

- Vault picker + first-run setup
- Local login screen with a single seeded `admin` account
- Admin-only account management and audit-log review
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

### Shipped since v1.0

- Markdown editor keymap + read-only toggle + inline tag editor
- Attachment handling: file picker, clipboard paste, drag-and-drop
  (50 MiB cap), stored under `attachments/`
- Evernote `.enex` import (notebook → folder, ENML → Markdown) with
  per-note progress events, reachable from File ▸ Import
- Notes folder management (create / rename / delete, empty dirs shown)
- Sync conflict-resolution UI (keep mine / keep theirs)
- Auth hardening: Argon2id passwords + in-memory session tokens, with an
  opt-in persisted "keep me signed in" token (30-day TTL, `auth_resume`)
- In-memory tag index serving tags **and** timeline/activity;
  per-vault write/sync mutex; CSP
- Local AI providers (Ollama) — key-free, on-device AI Assist
- Native application menu with global shortcuts (§4.3)
- CLI hooks (`<app-config-dir>/hooks/on-note-save|on-journal-save|on-sync`)
  — the first slice of the v2 "plugin system" candidate, git-hooks model
- One-click default vault: first run offers `~/Documents/duramen`

### v1.5

- Front matter `date: YYYY-MM-DD` for explicit date assignment
  (true Agenda-style plan-ahead notes on the timeline)
- Better editor UX (preview pane, slash commands)
- Improved search (indexed — extend `services/index.rs` beyond tags)
- Dark theme
- Mobile feasibility study (Tauri v2 mobile target)

### v2.0 (candidates)

- Backlinks & wiki-links
- Graph view
- Plugin system beyond CLI hooks (in-webview JS API, Obsidian-style,
  and/or MCP server exposure of the vault)
- Mobile app (if v1.5 study is positive)
- System Calendar / Reminders integration

---

## 6. Data & API Reference

The canonical, machine-readable description of naiteh's data and API — the
*facts* an LLM or developer reasons over — lives in the **LLM wiki**, a
first-class storage location in the documentation vault at `vault/wiki/`. This
implementation doc deliberately does not duplicate them; when a fact below
disagrees with the wiki, the wiki wins.

| Topic | Wiki page |
|-------|-----------|
| Vault layout on disk, front-matter schema | [vault-and-data.md](vault/wiki/vault-and-data.md) |
| Domain / IPC-boundary entity types (journal, notes, timeline, sync, auth, …) | [domain-model.md](vault/wiki/domain-model.md) |
| Tauri command (IPC) spec, `AppError` taxonomy, menu events | [ipc-api.md](vault/wiki/ipc-api.md) |
| App-level + per-vault config schema and paths | [app-config.md](vault/wiki/app-config.md) |
| Concurrency, atomic writes, path containment, privacy boundary | [concurrency-safety.md](vault/wiki/concurrency-safety.md) |
| Product features & non-goals (canonical) | [product-overview.md](vault/wiki/product-overview.md) |
| Glossary | [glossary.md](vault/wiki/glossary.md) |

Start at the wiki index: **[vault/wiki/index.md](vault/wiki/index.md)**.
