---
title: "Concurrency & Safety"
tags: [naiteh-wiki, safety, concurrency, privacy]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-11T12:00:00+09:00
pinned: false
---

# Concurrency & Safety

- **Atomic writes** — every file write goes via temp-file + rename.
- **No write while syncing** — every IPC that mutates the vault (the `notes_*`
  writers, `journal_save` / `quick_create`, `attachments_import` /
  `attachments_import_bytes`, `evernote_import`, the mutating `sync_*` commands
  `init` / `set_remote` / `pull` / `push` / `now`, and the conflict-resolution
  commands) acquires a `tokio::sync::Mutex` keyed on the canonical vault root
  (`services/vault_lock.rs`) before doing any work. `evernote_import` is the
  one writer that takes it **per note** (from its blocking thread via
  `blocking_lock`, held only while that note's files are written) rather than
  for the whole run, so autosave keeps working during a long import. Read-only commands
  (`notes_read` / `notes_list`, `journal_open`, `tags_*`, `search_text`,
  `attachments_read_image`, `sync_status`, `sync_list_conflicts`) do not lock; atomic-write semantics mean
  they may observe the previous version, never a torn write. Machine-local
  `.naiteh/` state that never syncs — e.g. `workspace_set_last_opened` writing
  `workspace.json` — is written without the lock by design.
- **Sync never holds the lock over the network** — sync commands are serialized
  by a process-wide sync gate; the vault lock is taken only for the local phases
  (commit, merge / checkout, sync-state writes). Fetch and push run unlocked,
  with a 300 s per-operation deadline and libgit2 connect / read timeouts. All
  sync commands (including `sync_status` / `sync_list_conflicts`) run their
  blocking work via `spawn_blocking`.
- **Tag index** — write commands invalidate the in-memory tag index
  (`services/index.rs`) on success, so `tags_*`, `search_text`'s file list and
  the timeline / activity commands reflect the latest content without
  re-scanning per read. Rebuilds run without the vault lock, so a write can
  land mid-scan: each vault's slot carries a **generation counter** that
  `invalidate` bumps, and a rebuild installs its snapshot only if the
  generation it started from is still current. Otherwise it rescans (up to 3
  attempts) and, if writes keep racing, serves its last scan uncached — a stale
  snapshot is never cached. `notes_list` (for `notes/` and `journal/`) reads
  the same snapshot. `search_text`'s in-memory content cache needs no
  invalidation: entries are keyed by file mtime + size and re-read when
  either changes (a same-size rewrite within the filesystem's mtime
  resolution is the one blind spot).
- **Read commands off the UI thread** — read / walk commands are `async` and do
  their I/O on the blocking pool, so a large vault never freezes the window
  (see [IPC API → Threading](ipc-api.md#threading)).
- **Backup targets**: `backup_run`, auto backup and `backup_compare` read the
  vault **without the vault lock** (like other read-only paths: atomic renames
  mean a reader sees the old or the new file, never a torn one). Each file is
  read once and hashed from the same bytes that are uploaded, so the target
  manifest always describes what was copied; a file changed mid-run is picked
  up next run. One run per target at a time (`Conflict`). Target writes are
  temp + rename; nothing on a target is deleted (it moves to the target's
  trash). `backup_restore_file` fetches from the backup first, then takes the
  vault lock for a version-checked, own-change-tagged write. Read-modify-write
  of `backup-targets.json` is serialized by an in-process mutex never held
  across network I/O. The scheduler's "vault changed" signal is bumped by every
  vault-watcher batch (own or external).
- **External change detection** — the vault folder is usually mirrored by
  Google Drive for desktop (and may be synced to a second PC), so files change
  on disk while the app runs. A Tauri-managed `VaultWatcher`
  (`services/watcher.rs`, built on the `notify` crate) watches the active vault
  root recursively from its own OS thread — started at app setup, replaced by
  `vault_set_active` / `vault_create_default`. Raw OS events are debounced
  into ~400 ms batches, mapped to vault-relative paths in canonical space (so
  Windows' case / 8.3 spellings strip cleanly; paths that can't be placed under
  the root are dropped), filtered (`.naiteh/`, `.git/`, naiteh's temp files,
  Drive / OS junk — list in [IPC API → Events](ipc-api.md#events)), collapsed
  to one entry per path, and emitted as `vault:changed`. Each batch with a
  non-own change (or an overflow) also invalidates the tag index. If the
  native watcher can't start, `notify`'s polling watcher (2 s) takes over;
  only when both fail — or the running watcher dies — is `vault:watch-error`
  emitted and the frontend falls back to focus-time `notes_version` checks.
  The watcher **never takes the vault lock** (it only reads the own-change
  registry and bumps the index generation), so it cannot deadlock with
  writers; emission goes through the `AppHandle`.
- **Own-change tagging** — so the frontend can tell an external edit from the
  echo of its own save, every mutation `services/fs.rs` performs (`atomic_write`
  target and any directories it creates, `ensure_dir`, `rename_entry` — both
  ends, and a renamed directory's subtree — `remove_file`, `remove_dir_all` —
  the whole tree) is recorded in a process-wide registry
  (`services/own_changes.rs`: canonical-form path key, case-folded on Windows →
  `Instant`, **3 s TTL**, pruned on every access, one short `std::sync::Mutex`).
  Backend code therefore never removes or renames through `std::fs` directly
  (`notes_delete`, `notes_delete_dir`, conflict resolution and the Evernote
  rollback all go through the `fsx` helpers). The watcher marks a change
  `own: true` when its path was recorded within the TTL; it does not consume
  the record, because one save surfaces as several raw events. Known gap:
  files libgit2 checks out during a pull are reported as external (harmless —
  the frontend reloads after a pull anyway).
- **Optimistic version check** — a **version** is the lowercase hex SHA-256 of
  a file's bytes (`services/notes.rs` `file_version`), returned by
  `notes_read` / `journal_open` (and cheaply by `notes_version`). `notes_write`
  / `journal_save` accept `expected_version`: with `Some(v)` the write happens
  only if the on-disk version is still `v`, otherwise nothing is written and
  `AppError::StaleWrite(current)` comes back (`current` = the on-disk version,
  `""` if the file is gone) so the UI can re-read and let the user reconcile;
  `None` writes unconditionally (new file / legacy). The compare and the
  atomic write run **under the per-vault lock**, so they are atomic with
  respect to every other app write; an external writer landing between the
  check and the rename is caught by the watcher's next batch and by the
  version the frontend holds afterwards. This is the safety net under the
  watcher: even if an own-tagged event hides an external edit within the TTL,
  the next autosave refuses to overwrite it.
- **Path containment** — note paths are resolved with `notes::resolve_in_vault`,
  which canonicalizes the deepest existing ancestor and refuses anything escaping
  the vault, including via a symlink committed by a malicious synced remote. It
  also refuses any `.git` path component (case-insensitive; `GIT~N` on Windows).
  Containment is only meaningful because the vault **root** is itself validated
  when chosen — never a filesystem root, the home folder, or a system / app-data
  location (see [Vault & Data](vault-and-data.md#where-a-vault-may-live)).
- **Session gate** — every non-auth IPC refuses to run (`Unauthorized`) unless a
  user is signed in to this app instance; see [IPC API](ipc-api.md#session-gate).
- **Pull refuses dirty trees** — `sync_pull` errors with `AppError::Conflict` if
  the working tree has uncommitted changes, conflict sidecars aside (the
  fast-forward / merge checkout would otherwise clobber them). Use `sync_now` (commits first)
  when there are local edits.
- **Auto-save (frontend, `src/state/autosave.ts`)** — the editor debounces
  saves at 800 ms idle; explicit save on Ctrl/Cmd-S. Saves pass the version
  the editor last read or wrote as `expected_version`, so a copy that arrived
  on disk from outside (Drive, another PC) is never silently overwritten — a
  `StaleWrite` keeps the edit dirty and surfaces the conflict. Each pending save is keyed
  **per document** and captures its target (note path or journal date) and
  vault when the edit happens, so a timer firing after the user switched notes
  still writes the original file — and is dropped if the active vault changed.
  Writes are **serialized** (one `notes_write` / `journal_save` at a time);
  after a write lands only the text actually written is marked saved, so
  keystrokes typed during an in-flight write stay dirty and go out next. A
  failed save is shown in the editor / status bar (`saveError`) and retried
  with backoff (2 s doubling to 60 s); edits are never discarded.
- **Flush before switching** — everything that moves the editor off a document
  awaits `flushPendingSave()` first: opening another note or journal day
  (`lib/openDocument.ts`, which also applies only the **latest** open request
  so out-of-order reads can't show a stale selection), closing, sync,
  logout / session loss, vault switch, and window close (the close-requested
  handler flushes, then destroys the window — needs the
  `core:window:allow-destroy` capability). A rename flushes, then suspends
  timer-driven saves for its duration; when a note is deleted (or vanishes in
  a sync), its pending save is discarded rather than written, so it can't be
  resurrected.
- **Conflict handling** — `sync_pull` performs a real three-way merge: remote
  and local edits that don't collide are **auto-merged** into a `naiteh: sync
  merge` commit (`services/git.rs`). Only edits that collide produce a conflict;
  naiteh then keeps both versions as `<file>.md` and
  `<file>.conflict-<timestamp>.md` (a `-N` is inserted before the extension if
  that name is already taken) and surfaces them in the Sync panel's Conflicts
  section, where the user picks "Keep mine" (`sync_resolve_keep_ours`) or "Keep
  theirs" (`sync_resolve_keep_theirs`). naiteh never auto-resolves a *colliding*
  edit. Non-colliding remote changes from the same pull are already applied to
  the working tree. The pull is persisted as a *pending merge* in
  `.naiteh/sync-state.json`; syncing is refused until its sidecars are gone,
  then a merge commit (parents: local head + that remote commit, content: the
  working tree) is recorded and the next sync uploads it — so conflicts always
  converge. Sidecars are never committed. A fresh vault whose history is only
  naiteh's own unsynced commits can join an existing destination (unrelated
  history); see [IPC API → Sync](ipc-api.md).
- **Sync path safety** — sidecar targets and the conflict-resolution commands
  reject absolute paths, `..`, any `.git` component, anything resolving outside
  the vault, and any symlink along the path (a remote can commit symlinks).
- **Privacy boundary** — v1 has exactly three outbound network paths, all
  user-initiated: (1) Sync sends note bytes to the user's chosen Git remote;
  (2) AI chat (`ai_chat_send` / `ai_infer_title`) sends a chat note's messages
  (plus the bodies of notes it links to) to the provider its model names;
  (3) the model picker (`ai_list_models`) lists that provider's models. With a
  local provider (Ollama, LM Studio), paths (2) and (3) stay on the machine.
  Every AI base URL must be `https`, or `http` only on loopback, checked before
  every request; an API key never leaves the backend except in that request's
  auth header. No telemetry, no background calls, no implicit
  AI rewriting.
- **Audit trail** — login attempts and selected work events are recorded in
  append-only local JSONL, visible to admin users from Settings.
