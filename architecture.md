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
6. **AI chat in notes (opt-in)** — a port of the Obsidian plugin
   chatgpt-md (MIT). A note is the conversation: messages are separated by
   `<hr class="__chatgpt_plugin">` and headed `### role::assistant` /
   `### role::user`. *Chat* (Cmd/Ctrl+J) sends the note to the model and
   streams the reply into the note (`ai_chat_send` + `ai:chat-chunk`), then
   adds the next user header. Front matter (`model: provider@model`,
   `temperature`, `max_tokens`, `system_commands`, `agent`, …) overrides
   agent notes, which override Settings → AI. Providers: OpenAI,
   Anthropic, Gemini, OpenRouter, Z.AI, Ollama, LM Studio; keys use OS
   credential storage, with references in app config, and never reach the
   renderer. Linked notes are sent as context. No AI network call fires
   without an explicit command.
7. **Single-user access with optional app lock**: fresh installs open without
   app login or seeded accounts. An optional password-only lock uses an
   Argon2id hash in app-config `app-lock.json`; every non-auth IPC checks
   `ActiveSession` whether the lock is enabled or disabled. Sessions/tokens
   are memory-only with no expiry timer, remember UI or token persistence.
   An enabled lock requires unlocking after manual lock or app restart.
   Existing accounts require explicit one-time conversion to the app lock
   (§4.1), not silent removal of protection. There is no admin route or
   account-management UI; the internal `local` / `Admin` session is only
   audit attribution, not an account role or vault isolation.

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
- Cloud identity, SSO, multi-user account management or multi-tenant server
  authorization. The optional app lock is single-user app access control.

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
| AI HTTP client    | **`reqwest` 0.13 (rustls: aws-lc-rs + OS cert store)** — used only by AI chat |
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
        │   ├── App.tsx                ← access bootstrap / unlock / conversion / first-run / shell
        │   ├── shell/                 ← AppShell (lazy-loads EditorPanel),
        │   │                             MarkdownViewer (view mode),
        │   │                             ActivityBar, StatusBar, CommandPalette,
        │   │                             useMenuEvents, useWorkspaceLifecycle,
        │   │                             useDraftCloseGuard (mounted by App)
        │   ├── features/
        │   │   ├── chat/               ← ModelPicker (AI chat in notes; flow in lib/chatMd/)
        │   │   ├── auth/               ← LoginScreen (unlock / legacy conversion),
        │   │   │                          AuditLogList, app-lock password rules
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
        │   │   ├── htmlToMarkdown.ts   ← dependency-free HTML → Markdown
        │   │   │                          converter for editor paste
        │   │   └── types.ts            ← TS mirror of the IPC types
        │   ├── state/                 ← global state (Zustand)
        │   │   ├── editorStore.ts      ← open doc, revision, saveError
        │   │   ├── autosave.ts         ← debounced, serialized per-note saves
        │   │   ├── vaultContentStore.ts← "vault files changed" counter
        │   │   └── …                   ← auth, settings, sync, ui, vault stores
        │   └── styles/
        │       ├── tokens.css         ← VS Code Light Modern tokens
        │       ├── palettes.ts        ← built-in palette overrides (Appearance)
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
                │   ├── auth.rs          ← AuthAccess, AuthSession, LoginResult,
                │   │                      AuditLogEntry (audit-only role shape)
                │   ├── evernote.rs      ← EvernoteImportReport, …Note
                │   ├── journal.rs       ← DayMeta, Journal*Result,
                │   │                      TimelineItem, TimelineDay
                │   ├── note.rs          ← NoteMeta
                │   ├── search.rs        ← SearchHit, TagCount
                │   ├── sync.rs          ← SyncStatus
                │   └── vault.rs         ← VaultInfo
                └── services/           ← side-effectful logic
                    ├── mod.rs
                    ├── app_lock.rs     ← optional Argon2id app lock + legacy conversion
                    ├── attachments.rs
                    ├── auth.rs         ← legacy account verification + audit log
                    ├── config.rs       ← AppConfig on disk, AppConfigView over IPC
                    ├── conflicts.rs    ← sync-conflict discovery + resolution
                    ├── credentials.rs  ← OS credential references + safe migration
                    ├── evernote/       ← streaming .enex reader, ENML→MD, importer
                    ├── fs.rs           ← atomic writes, run_blocking
                    ├── fs_naming.rs    ← shared sanitize/MIME/label helpers
                    ├── git.rs          ← phased sync: prepare / fetch / integrate / push
                    ├── hooks.rs        ← CLI hooks (on-note-save / on-journal-save / on-sync)
                    ├── index.rs        ← in-memory tag index (generation-checked)
                    ├── notes.rs        ← front matter, slugify, normalize_rel_path,
                    │                     resolve_in_vault
                    ├── session.rs      ← ActiveSession gate, memory-only access (no expiry)
                    ├── sync_state.rs   ← .naiteh/sync-state.json (last sync, pending merge)
                    ├── timeline.rs     ← activity/timeline items from the index
                    ├── vault_lock.rs   ← per-vault mutex + originating-root check
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

The app is single-user. `App.tsx` starts with `auth_bootstrap` and withholds
vault/settings IPC and the workspace until the backend reports access ready.
Fresh installs proceed without app login; optional locking is configured in
Settings → Security. Startup errors remain visible with retry and fail closed,
never assuming that an unreadable lock configuration means locking is disabled.

- The password-only app lock stores an Argon2id hash in app-config
  `app-lock.json`; new passwords are 8–1024 characters. `auth_unlock` opens
  access with that password. Sessions and tokens live only in memory with no
  idle/absolute expiry, remember UI or persistence. An enabled lock is reapplied
  only on manual lock or app restart, not on a timer.
- Existing `auth.json` without `app-lock.json` requires explicit one-time
  `auth_migrate(username, password, newPassword)`: validate the supplied legacy
  credentials and require a new 8–1024-character app-lock password different
  from the old password. Conversion enables the lock; it never silently
  disables protection or chooses an arbitrary account. Old account hashes and
  audit history remain but no longer determine access. Legacy
  `remembered-session.json` is deleted without retaining its token.
- **Backend gate.** Every non-auth command checks `ActiveSession`
  (`services/session.rs`), including when the optional lock is disabled.
  `auth_bootstrap`, `auth_unlock` and `auth_migrate` establish access;
  `auth_set_lock`, `auth_lock`, `auth_migrate_secrets` and the retained audit
  commands validate the active token. The exact contract lives in the wiki's
  [IPC API](vault/wiki/ipc-api.md#auth--audit).
- **Manual lock.** `authStore.lock` first flushes saves/preserves held edits
  with `flushPendingSave({ leaving: true })`. Any failure refuses locking;
  otherwise it waits for `auth_lock` acknowledgement before clearing local
  access. Failed backend acknowledgement is not presented as a successful lock.
- **Unexpected access loss.** `lib/api/invoke.ts` immediately hides the workspace
  on `Unauthorized` from any non-auth command or `auth_lock`,
  `auth_list_audit_logs`, `auth_log_action`, or `auth_migrate_secrets`, preserving
  drafts and pending save/retry entries in memory with autosave access paused.
  Wrong-password errors from `auth_unlock`, `auth_migrate` and `auth_set_lock`
  remain form errors rather than triggering access loss.
- **Draft recovery.** After backend access is restored, recovery checks the
  backend vault against the originating draft vault before flushing, and checks
  again during workspace loading before replacing the local active vault.
  A mismatch/read/save error keeps drafts paused and the workspace withheld.
  The UI offers **Retry draft recovery** and **Return to draft vault**; the
  latter explicitly restores the original vault without editor reset or queue
  discard. The notice warns to keep the window open: edits are not confirmed
  saved and retaining them in memory does not make them survive app exit.
- The internal `AuthSession` is `local` / `Admin` for audit attribution only,
  not an account role or isolation boundary. There is no admin route or account
  management. `auth_list_audit_logs` and allowlisted `auth_log_action` remain
  active-token validated. Old login/resume/logout, account password-change,
  create/list-user and set-active IPCs have been removed.

Related hardening outside auth (facts in the wiki): the AI API key never
crosses IPC (`AppConfigView.ai.hasApiKey` instead; base URL must be
https or loopback http), and vault roots are validated so path
containment can't be defeated by choosing `~` or `C:\` as the vault
(`services/vault_path.rs`; `.git` paths are refused too).

AI/SFTP secret storage uses `services/credentials.rs` with `keyring` 3.6.3:
macOS Keychain, Windows Credential Manager and persistent Linux Secret Service
over session D-Bus. JSON stores references; secret use/update or the manual
`auth_migrate_secrets(token)` retry stages unique entries before atomic metadata
commit, with best-effort superseded/orphan cleanup. Unrelated reads/settings and
vault operations do not require the store or discard unmigrated secrets.
Requests resolve only selected-provider credentials; SFTP resolves after the
host-key check. Store errors are visible with no plaintext fallback. Calendar
secret feed URLs are outside this migration; historical copies may retain old
plaintext. Schema and failure details belong in
[App Config](vault/wiki/app-config.md#credential-storage). Unit tests use a
memory store; native OS runtime validation remains pending as of 2026-10-17.

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
  CodeMirror, its language data and the Markdown renderer stay out of the
  startup bundle. It has two modes (`uiStore.editorMode`): **view** (the
  default) renders the note with `shell/MarkdownViewer`; **edit** shows the
  CodeMirror source. The CodeMirror view stays mounted (hidden, read-only)
  in view mode, so pin / tag / task-checkbox changes and AI replacements
  still flow through the one document and autosave. Opening a different
  document returns to view; new notes and quick notes open in edit
  (`openDocument(target, { edit: true })`).
- **Status Bar**: optional, 22px tall. Shows vault name, sync status,
  word count, and a save-error indicator when autosave is failing.

#### Editor persistence

Opening, closing and reloading documents all go through
`lib/openDocument.ts`, which flushes pending saves first and applies only
the latest open request. Saves go through `state/autosave.ts`: debounced
(800 ms), keyed per document, serialized, retried with backoff, and bound to the
originating vault captured with the edit. A vault mismatch parks drafts rather
than silently dropping them. `notes_write` / `journal_save` require that root
as `expectedVaultRoot`: a canonical mismatch returns `Conflict` without writing;
a missing root cannot save. After validation, the command keeps the captured
canonical root for the write even if the active setting changes later.

`App.tsx` mounts `useDraftCloseGuard` across locked, loading, error, recovery and
shell states. It prevents window close while unsaved or in-flight writes cannot
be flushed safely, including when access is paused; only a successful
flush/preservation with access still ready permits window destruction. This is
why the default capability grants `core:window:allow-destroy`.
The precise ordering guarantees are facts and live in the wiki
([concurrency-safety.md](vault/wiki/concurrency-safety.md)).

#### External file changes

The vault is backed up and possibly shared between machines by a folder
sync service (Google Drive, see README), so files change on disk while
the app runs. Two mechanisms cover that:

- **Vault watcher** (`services/watcher.rs`, `notify` crate, own thread,
  polling fallback). It emits the `vault:changed` event with coalesced,
  vault-relative changes; the app's own writes are tagged `own: true`
  via a short-lived registry fed by `services/fs.rs`
  (`services/own_changes.rs`), and `.naiteh/`, `.git/`, temp and sync
  junk files are filtered out. `lib/vaultWatch.ts` listens: non-own
  batches refresh every list and re-check the open document; a window
  focus re-check (throttled) is the safety net when the watcher misses
  events; a watcher failure surfaces as "Live updates off" in the status
  bar (`vault:watch-error`).
- **Version tokens** (optimistic concurrency). `notes_read` /
  `journal_open` return a `version` (SHA-256 of the file bytes), the
  editor keeps it as `savedVersion`, and every autosave sends it as
  `expectedVersion`. If the disk moved on, the backend refuses with
  `StaleWrite` instead of overwriting. The editor then shows the
  external-change banner: *Load disk version*, *Keep mine* (conditional
  write against the newer version), or *Save mine as copy*
  (`<stem>.local-<timestamp>.md`). A clean document is simply reloaded;
  a deleted one is closed (or, if dirty, offered re-save / copy). Held
  edits are never dropped silently: leaving the document writes them to a
  `.local-` copy. Shapes and rules are in the wiki
  ([ipc-api.md](vault/wiki/ipc-api.md) "Events",
  [concurrency-safety.md](vault/wiki/concurrency-safety.md)).

#### Backup targets and copy comparison

Settings → Backup manages in-app backup targets (`features/backup/`,
`state/backupStore.ts`, `lib/api/backup.ts`; backend `services/backup.rs`,
`services/backup_sftp.rs`, `commands/backup.rs`): a **Google Drive** target
is a folder inside the Google Drive for desktop sync folder; an **SFTP**
target is a remote directory reached with password or key auth, its host key
pinned on first use. Runs are one-way incremental mirrors driven by a
per-target manifest; files deleted locally move to the target's
`.naiteh-backup/trash/` instead of being deleted; SFTP secrets use OS credential
storage, with references in app-config JSON. An auto-backup scheduler runs due
targets while backend access is ready.
The **Compare copies** view (AppShell-level modal above Settings; palette
"Backup: Compare copies") lines up the vault, the Drive copy and the SFTP
copy per path (same / differs / missing), shows a line diff
(`lib/lineDiff.ts`) for text files and restores another copy into the
vault as a copy or, after confirmation, as a version-checked overwrite. The
status bar shows run progress. Facts: [ipc-api.md](vault/wiki/ipc-api.md)
"Backup targets", [vault-and-data.md](vault/wiki/vault-and-data.md) "Backup".

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

These values are the `default` palette. Settings → Appearance lets the user
pick one of the other built-in palettes (two of them, `nord` and `midnight`,
are dark schemes) and custom interface / editor font families. The renderer
applies the choice by overriding the color tokens, `--font-ui` and
`--font-editor` on the document root; an empty font keeps the stack above.
The palette ids live in `styles/palettes.ts`, mirrored by the backend's
`PALETTES` list. Keys, values and validation rules:
[app-config.md](vault/wiki/app-config.md#appearance). A full dark theme that
follows the OS setting is still not part of v1.

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
| View          | Chat                | Cmd/Ctrl+J        | Send the open note to the model; stream the reply into it |
| View          | New Chat            | Cmd/Ctrl+Shift+J  | Create a chat note in the chats folder |
| View          | Select Model…       | —                 | Set the note's `model:` (or the default) |
| View          | Stop Streaming      | —                 | Abort the running chat request |
| View          | Toggle Edit Mode    | Cmd/Ctrl+Shift+E  | Switch the note between rendered view and source editor |

Settings is **not** a `ViewMode`; it is a full-screen modal
(`features/settings/SettingsModal`) overlaying the shell, opened from
the app menu (Cmd/Ctrl+,), the Activity Bar gear, the status-bar settings
control, or the palette. It mirrors the Obsidian settings layout: a
left section nav (Vault, Backup, Appearance, Editor, Web Clipping, AI,
Import from Evernote, Security and Audit Log; no Administration group)
beside a scrolling column of "name + description →
control" rows. Backup is explanatory: it walks through backing the vault up
with Google Drive for desktop (showing the vault path with a copy button),
says what the backup does not include, and lists the optional in-app Sync's
limits; the Sync panel links back to it (`uiStore.requestBackupSettings`). Appearance has palette picker cards and interface / editor
font presets (with a Custom… entry and a preview); Web Clipping chooses how
HTML pasted into the editor is handled (convert to Markdown, plain text, or
raw HTML) and the Markdown conversion options, with a live preview and a
reset-to-defaults button. The conversion itself is `lib/htmlToMarkdown.ts`
(DOMParser-based, no dependencies), hooked into CodeMirror's paste handling;
image pastes still go through attachments. Both sections persist through
`app_config_set_appearance` / `app_config_set_clipping`
([app-config.md](vault/wiki/app-config.md#clipping)).
Each section is its own component under `features/settings/sections/`;
the modal handles focus trapping / restore (`useDialogFocus`). This
replaced the cramped list-panel settings that shared the 280 px sidebar.

The Edit menu uses the standard predefined items (undo/redo/cut/copy/
paste/select-all) with their usual shortcuts. The editor keeps its own
CodeMirror bindings (Cmd/Ctrl+B/I/`/Shift+X for formatting, Cmd/Ctrl+K
for link insertion, Cmd/Ctrl+S for save) — the palette deliberately
lives on Cmd/Ctrl+P so it doesn't collide with the editor's link
shortcut.

#### Calendar mode layout

Calendar mode reads left to right **month | day timeline | note**; every
other mode keeps the usual list panel | editor layout. The list panel
holds a mini month grid (selected day = accent pill, today outlined, dots
for days with events or notes, Today button), the **Agenda** tab (the note
timeline) and **My calendars** (toggle, rename, colour, remove, add,
refresh). The selected day lives in `state/calendarStore.ts` and drives the
**day timeline** pane (`features/calendar/DayTimeline*`), which sits inside
the editor cell before the editor: 380 px by default (280–560, own
resizer; shrinks first and collapses to a toggle when the window is narrow).
It shows an all-day strip (all-day events, the day's notes as chips), an
hour grid with a live current-time line, and events as calendar-coloured
blocks laid out side by side when they overlap; each block has *Add note* /
*Open note* (creates or opens a meeting note linked by front-matter
`event_id`; it opens in the editor on the right). Subscriptions are
read-only iCal feeds (Google "secret address", iCloud public calendar)
wrapped by `lib/api/calendar.ts`; colours come from the `--color-cal-*`
tokens defined in every palette. The day's notes, journal entries and web
clips also appear on the hour grid as neutral, outlined markers at their
placement time (front-matter `created`, else file mtime; a note belongs to
the day of `created`, else its mtime) — date-only items stay as all-day
chips — toggled by "Show notes & clips". These markers are local only:
the calendar integration is read-only (GET), and notes never reach any
`calendar_*` command. Facts: [ipc-api.md](vault/wiki/ipc-api.md)
"Calendar subscriptions" and the timeline item fields. `calendar.subView` in app config is no longer used.

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

Historical scope: the account/login milestones below are superseded by the
2026-10-17 single-user app-lock implementation (§4.1).

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
- AI Assist side panel (opt-in; OpenAI Chat Completions by default) — replaced by AI chat in notes
- Light theme (VS Code Light Modern)

### Shipped since v1.0

- Markdown editor keymap + inline tag editor
- Reading view: notes render as Markdown by default; the source editor
  appears only in edit mode (replaced the earlier read-only toggle)
- Attachment handling: file picker, clipboard paste, drag-and-drop
  (50 MiB cap), stored under `attachments/`
- Evernote `.enex` import (notebook → folder, ENML → Markdown) with
  per-note progress events, reachable from File ▸ Import
- Notes folder management (create / rename / delete, empty dirs shown)
- Sync conflict-resolution UI (keep mine / keep theirs)
- Historical auth hardening (superseded by §4.1): Argon2id passwords + in-memory
  session tokens, with a persisted "keep me signed in" token (checkbox, on by
  default; 30-day TTL, `auth_resume`)
- Historical auth milestone (account flows/expiry superseded by §4.1): backend
  session gate on every non-auth IPC; forced first-login password
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
- External file-change detection: vault watcher + `vault:changed` events,
  version-checked writes (`StaleWrite`), conflict banner with keep / load /
  save-as-copy, focus re-check (§4.1 "External file changes")
- Local AI providers (Ollama) — key-free, on-device AI Assist
- Calendar subscriptions (read-only Google / iCloud / iCal feeds) in
  Calendar mode: month | day timeline | note, Add note per event, My calendars
- Backup targets: Google Drive folder + SFTP (host-key TOFU), incremental
  mirror with remote trash, auto backup, 3-way Compare copies with diff and
  restore
- AI chat in notes (port of chatgpt-md, MIT): chat-note format, Cmd/Ctrl+J
  streaming into the note, new chat / select model / infer title / clear /
  stop, agents, linked-note context, seven providers; replaced the AI
  panel, the browser chat window and the clipboard capability
- Native application menu with global shortcuts (§4.3)
- CLI hooks (`<app-config-dir>/hooks/on-note-save|on-journal-save|on-sync`;
  `.exe` / `.cmd` / `.bat` / `.ps1` on Windows) — the first slice of the v2
  "plugin system" candidate, git-hooks model
- One-click default vault: first run offers `~/Documents/duramen`
- Appearance settings (built-in color palettes incl. two dark ones, custom
  UI / editor fonts) and web clipping (configurable HTML → Markdown
  conversion on paste)
- Build / CI: portable Makefile mirrored by root `pnpm` scripts, Windows
  dev script, CI on Linux / macOS / Windows with SHA-pinned actions and a
  pinned Rust 1.90.0

### v1.5

- Front matter `date: YYYY-MM-DD` for explicit date assignment
  (true Agenda-style plan-ahead notes on the timeline)
- Better editor UX (preview pane, slash commands)
- Improved search (indexed — extend `services/index.rs` beyond tags)
- Dark theme that follows the OS setting (dark palettes already ship)
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

### Single-user security requirements (implementation status)

Updated 2026-10-17 from the initial requirements-only note. Checked items record
implemented/documented portions, **not native GUI/OS-store validation** or a
release commitment. Integrated `pnpm check` and `pnpm build` passed; the build
retains the existing CodeMirror chunk-size warning. Local Rust checks used
1.97.1, not the CI-pinned 1.90 toolchain. Results and the six resolved review
findings are recorded in the [dated addendum](docs/fix-plan-F1-F5.md).
Credential unit tests use a memory store. No native GUI or real OS credential
store was tested on any OS, and macOS/Windows runtime verification remains
outstanding.

- [x] Preserve the single-user, local-first workflow and ordinary, externally
  readable/editable Markdown notes. Moving notes into a database is not a
  security requirement and does not by itself provide encryption.
- [x] Document the baseline security boundary: a private OS account, screen
  locking, appropriate vault/app-config file permissions, and full-disk
  encryption for device loss or offline disk access. These controls do not
  protect an unlocked OS session from malicious software running as that user.
- [x] Implement OS credential-store protection for AI API keys, SFTP passwords
  and private-key passphrases (extends review finding L4), using references in
  JSON. Safe idempotent migration removes legacy plaintext only after secure
  write and metadata commit; failures are visible with no plaintext fallback.
  Unrelated metadata/settings/vault operations preserve unmigrated values and
  need no store. Superseded/orphan cleanup is best effort; old backups may
  retain plaintext. Calendar secret feed URLs are not migrated. Remembered
  tokens are deleted, not retained. Native runtime verification is pending;
  the OS store is not a guarantee against same-user malware.
- [x] Simplify multi-user IDs, admin roles and account-management UI into a
  single-user mode with an optional app lock. When enabled, enforce that lock
  in the backend IPC path, not just the UI; retain path validation and other
  command safety checks regardless of lock settings. Preserve existing vaults
  and unsaved-edit protection during manual lock/access loss. Existing accounts
  require explicit credential validation and a new password to enable the app
  lock; there is no silent disable or arbitrary account selection.
- [x] Clearly label the optional app lock as app access control, **not vault
  encryption**: someone able to read the vault files can still read notes
  directly. Do not imply that separate app accounts isolate vault contents.
- [x] Document backup/sync copies as a separate security boundary: restrict
  destination sharing/access, retain secure transport and SFTP host-key checks,
  and disclose that private Git repositories or SFTP do not provide
  client-side content encryption. Local full-disk encryption does not protect
  remote copies.
- [ ] Application-level vault/backup-content encryption remains deferred unless
  sensitive content or a requirement to protect copied files or hide content
  from the backup provider justifies it. Before implementing it, define key
  recovery, attachment handling and treatment of existing plaintext backups/Git history;
  do not present the future E2EE sync proposal as current vault encryption.

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
