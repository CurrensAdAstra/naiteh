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
   any vault content is shown, and the backend enforces it with a session
   gate on every non-auth command. A single `admin` account is seeded only
   on the very first run (password equals the username) and must change
   its password right after that first login. Any user can change their
   own password; an admin creates further accounts and enables / disables
   them in the UI. Login mints an opaque session token; the frontend passes
   that token, never a plain username, to the auth IPCs that need to know
   who is asking. The login screen has a "keep me signed in on this device"
   checkbox, checked by default: the token is persisted to the app-config
   dir with a 30-day expiry and restored on the next launch via
   `auth_resume`, so single-user machines aren't re-prompted every start.
   Unchecking it means a restart (which empties the in-memory session
   store) returns to the login screen. Sign-out, signing in with the box
   unchecked, a password change and disabling the account all drop the
   saved token, so a deactivated account can't ride a stale token back in.

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
| AI HTTP client    | **`reqwest` 0.13 (rustls: aws-lc-rs + OS cert store)** — used only by AI Assist |
| Package manager   | **pnpm** 10 (pinned via `packageManager`, Corepack)       |
| Rust toolchain    | `rust-version = "1.90"`; CI pins 1.90.0                   |
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
├── AGENTS.md                  ← pointer to CLAUDE.md for other agents
├── README.md                  ← prerequisites (incl. Windows), setup, checks, installers
├── architecture.md            ← this file — implementation reference
├── Makefile                   ← portable targets; each has a root `pnpm` script twin
├── package.json               ← pnpm workspace root + root scripts (dev, check, test:rust, …)
├── pnpm-workspace.yaml        ← workspace + onlyBuiltDependencies allowlist
├── .github/
│   └── workflows/ci.yml       ← guards, frontend, Rust ×3 OS, debug bundle ×3 OS
├── scripts/
│   ├── dev.ps1                ← Windows: refresh PATH, start `tauri dev`
│   └── ensure-dist.mjs        ← stub apps/desktop/dist for cargo clippy/test
├── vault/                     ← documentation vault (a naiteh-shaped store)
│   ├── journal/
│   ├── note/
│   └── wiki/                  ← LLM wiki: canonical data/facts (see §6)
├── docs/
│   ├── design/                ← design proposals (not implemented)
│   └── sessions/              ← dated work-session summaries
└── apps/
    └── desktop/
        ├── package.json
        ├── vite.config.ts
        ├── vitest.config.ts
        ├── eslint.config.js
        ├── tsconfig.json
        ├── index.html
        ├── src/                       ← React frontend
        │   ├── main.tsx
        │   ├── App.tsx                ← resume / login / admin / first-run / shell
        │   ├── shell/                 ← AppShell (lazy-loads EditorPanel),
        │   │                             ActivityBar, StatusBar, CommandPalette,
        │   │                             useMenuEvents, useWorkspaceLifecycle
        │   ├── features/
        │   │   ├── ai/                 ← AI Assist side panel
        │   │   ├── auth/               ← LoginScreen (incl. forced password
        │   │   │                          change), AdminDashboard, shared
        │   │   │                          AccountList / AuditLogList /
        │   │   │                          ChangePasswordForm / CreateUserForm
        │   │   ├── journal/
        │   │   ├── notes/
        │   │   ├── calendar/
        │   │   ├── search/
        │   │   ├── tags/
        │   │   ├── sync/
        │   │   └── settings/           ← SettingsModal + sections/ (one file
        │   │                              per nav section), FirstRunSetup
        │   ├── lib/
        │   │   ├── api/                ← one wrapper module per IPC area, all via
        │   │   │                          invoke.ts (central error handling)
        │   │   ├── openDocument.ts     ← the one way to open / close / reload
        │   │   ├── journalPath.ts      ← canonical journal rel-path helpers
        │   │   └── types.ts            ← TS mirror of the IPC types
        │   ├── state/                 ← global state (Zustand)
        │   │   ├── editorStore.ts      ← open doc, revision, saveError
        │   │   ├── autosave.ts         ← debounced, serialized per-note saves
        │   │   ├── vaultContentStore.ts← "vault files changed" counter
        │   │   └── …                   ← auth, settings, sync, ui, vault stores
        │   └── styles/
        │       ├── tokens.css         ← VS Code Light Modern tokens
        │       └── reset.css
        └── src-tauri/                 ← Rust backend
            ├── Cargo.toml             ← rust-version 1.90
            ├── tauri.conf.json        ← window, CSP, bundle metadata
            ├── capabilities/          ← Tauri permissions (incl. window destroy)
            └── src/
                ├── main.rs
                ├── lib.rs              ← Tauri builder, managed state, IPC registry
                ├── commands/           ← thin IPC wrappers, one module per area
                │   ├── mod.rs
                │   ├── ai.rs
                │   ├── attachments.rs
                │   ├── auth.rs
                │   ├── evernote.rs
                │   ├── journal.rs
                │   ├── notes.rs
                │   ├── search.rs
                │   ├── settings.rs
                │   ├── sync.rs
                │   ├── tags.rs
                │   ├── vault.rs
                │   └── workspace.rs
                ├── domain/             ← pure domain types + AppError,
                │   │                      grouped by area, re-exported flat
                │   │                      as crate::domain::Foo (mod.rs)
                │   ├── mod.rs
                │   ├── error.rs         ← AppError
                │   ├── attachment.rs    ← AttachmentImport
                │   ├── auth.rs          ← UserRole, AuthUser, AuthSession,
                │   │                      LoginResult, AuditLogEntry
                │   ├── evernote.rs      ← EvernoteImportReport, …Note
                │   ├── journal.rs       ← DayMeta, Journal*Result,
                │   │                      TimelineItem, TimelineDay
                │   ├── note.rs          ← NoteMeta
                │   ├── search.rs        ← SearchHit, TagCount
                │   ├── sync.rs          ← SyncStatus
                │   └── vault.rs         ← VaultInfo
                └── services/           ← side-effectful logic
                    ├── mod.rs
                    ├── attachments.rs
                    ├── auth.rs         ← Argon2 accounts + SessionStore + audit log
                    ├── config.rs       ← AppConfig on disk, AppConfigView over IPC
                    ├── conflicts.rs    ← sync-conflict discovery + resolution
                    ├── evernote/       ← streaming .enex reader, ENML→MD, importer
                    ├── fs.rs           ← atomic writes, run_blocking
                    ├── fs_naming.rs    ← shared sanitize/MIME/label helpers
                    ├── git.rs          ← phased sync: prepare / fetch / integrate / push
                    ├── hooks.rs        ← CLI hooks (on-note-save / on-journal-save / on-sync)
                    ├── index.rs        ← in-memory tag index (generation-checked)
                    ├── notes.rs        ← front matter, slugify, normalize_rel_path,
                    │                     resolve_in_vault
                    ├── session.rs      ← ActiveSession gate, login throttle, expiry
                    ├── sync_state.rs   ← .naiteh/sync-state.json (last sync, pending merge)
                    ├── timeline.rs     ← activity/timeline items from the index
                    ├── vault_lock.rs   ← per-vault write/sync mutex
                    ├── vault_path.rs   ← vault-root validation (no home / system dirs)
                    └── workspace.rs    ← per-vault last-opened state
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

- `admin`/`admin` is seeded only when `auth.json` does not exist (first
  run), flagged `mustChangePassword`; `LoginResult.mustChangePassword`
  makes the UI demand a new password before anything else. Removing
  `admin` from an existing file never resurrects it; a file with no active
  admin makes login fail with a clear `ConfigCorrupt` error instead. The
  admin creates further accounts (`auth_create_user`) and enables /
  disables them (`auth_set_user_active`; the last active admin and the
  admin's own account can't be disabled); every user can change their own
  password (`auth_change_password`, Settings → Account). The forced
  first-login change happens inside `LoginScreen`: the token is held as a
  *pending* password change and the shell isn't shown until it succeeds.
- Passwords are hashed with Argon2id (per-user salt embedded in the PHC
  string). Pre-token installs that still hold SHA-256 hashes are
  upgraded transparently on the next successful login. Argon2 runs on the
  blocking pool (`auth_login` etc. are async) so the UI never stalls.
- Successful login mints a 256-bit hex bearer token held in the Tauri
  process memory (12 h idle / 7-day absolute expiry); with "keep me
  signed in" it is also persisted for `auth_resume` (30-day TTL). Every
  auth IPC that needs an identity takes that token and resolves it via
  the in-process session store.
- **Session gate.** Login also sets the instance's `ActiveSession`
  (`services/session.rs`); every non-auth command calls
  `require_session(&active)?` as its first statement and returns
  `Unauthorized` while nobody is signed in — hiding the UI is no longer
  the only barrier. Only `auth_login`, `auth_resume` and `auth_logout`
  run before sign-in. A unit test in `lib.rs` parses the
  `generate_handler!` list and fails if any command skips the gate. On
  the frontend, every IPC goes through `lib/api/invoke.ts`; an
  `Unauthorized` from a non-`auth_*` command (e.g. after a restart without
  a remembered session) flushes pending saves and signs the user out with
  a "session ended" notice instead of leaving a broken shell.
- Login hardening: unknown usernames still pay one Argon2 verification
  (dummy hash) so timing doesn't reveal which accounts exist; the password
  is checked before the "disabled" flag; 5 failures lock a username for
  5 minutes (in memory). Unknown user and wrong password share one
  message; only the correct password reveals "account is disabled".
- `auth_log_action` accepts only an allowlist of renderer work events, so
  the renderer can't forge `login_success` & co. in the audit log.
- `/admin` does not bypass authentication; after an admin signs in there it
  renders the standalone `AdminDashboard` (accounts, create user, own
  password, audit log) instead of the vault shell. A non-admin at `/admin`
  gets the normal app. The same account / audit components back the
  Settings modal's Accounts and Audit Log sections.
- Failed and successful login attempts are written to the audit log.

Related hardening outside auth (facts in the wiki): the AI API key never
crosses IPC (`AppConfigView.ai.hasApiKey` instead; base URL must be
https or loopback http), and vault roots are validated so path
containment can't be defeated by choosing `~` or `C:\` as the vault
(`services/vault_path.rs`; `.git` paths are refused too).

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
- **Editor Panel**: fills remaining space. Lazy-loaded (`React.lazy`) so
  CodeMirror and its language data stay out of the startup bundle.
- **Status Bar**: optional, 22px tall. Shows vault name, sync status,
  word count, and a save-error indicator when autosave is failing.

#### Editor persistence

Opening, closing and reloading documents all go through
`lib/openDocument.ts`, which flushes pending saves first and applies only
the latest open request. Saves go through `state/autosave.ts`: debounced
(800 ms), keyed per document, serialized, retried with backoff, and flushed
before anything moves the editor off a document — including window close,
which is why the default capability grants `core:window:allow-destroy`.
The precise ordering guarantees are facts and live in the wiki
([concurrency-safety.md](vault/wiki/concurrency-safety.md)).

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
  --color-warning:          #b26a00;
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
left section nav (Vault, Editor, AI Assist, Import from Evernote,
Account, plus an Administration group — Accounts / Audit Log — for
admins) beside a scrolling column of "name + description → control" rows.
Each section is its own component under `features/settings/sections/`;
the modal handles focus trapping / restore (`useDialogFocus`). This
replaced the cramped list-panel settings that shared the 280 px sidebar.

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
- Admin-only account management (create, enable / disable) and audit-log
  review; self-service password change for every user
- 3-column shell with all six ViewModes (+ the Settings modal)
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
- Auth hardening: Argon2id passwords + in-memory session tokens, with a
  persisted "keep me signed in" token (checkbox, on by default; 30-day TTL,
  `auth_resume`)
- Backend session gate on every non-auth IPC; forced first-login password
  change, self-service password change, admin user creation; login
  lockout + timing equalization; token expiry (12 h idle / 7 days);
  allowlisted client audit actions; key-less AI config view + base-URL
  rules; vault-root validation; `.git` paths refused
- In-memory tag index serving tags, search's file list **and**
  timeline/activity; per-vault write/sync mutex; CSP; all read commands off
  the UI thread
- Sync rework: phased sync (network without the vault lock, timeouts,
  bounded credential attempts), persisted pending merge so conflicts
  converge, joining an existing remote from a fresh vault
- Editor: per-document serialized autosave with retry and flush-before-
  switch / close; latest-request-wins document opening; lazy-loaded editor
- Local AI providers (Ollama) — key-free, on-device AI Assist
- Native application menu with global shortcuts (§4.3)
- CLI hooks (`<app-config-dir>/hooks/on-note-save|on-journal-save|on-sync`;
  `.exe` / `.cmd` / `.bat` / `.ps1` on Windows) — the first slice of the v2
  "plugin system" candidate, git-hooks model
- One-click default vault: first run offers `~/Documents/duramen`
- Build / CI: portable Makefile mirrored by root `pnpm` scripts, Windows
  dev script, CI on Linux / macOS / Windows with SHA-pinned actions and a
  pinned Rust 1.90.0

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
- Headless engine daemon + pluggable sync backends (folder watching, web
  clipping, Git / E2EE server sync behind one switch) — **proposal, not
  implemented**: [docs/design/engine-daemon.md](docs/design/engine-daemon.md)

### Release follow-ups (open)

Not yet decided / built: license choice, a real version number (still
`0.0.0`), installer code signing, an auto-updater, and a release workflow
(CI builds debug bundles only).

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
