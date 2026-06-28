---
title: "Concurrency & Safety"
tags: [naiteh-wiki, safety, concurrency, privacy]
created: 2026-06-28T00:00:00+09:00
updated: 2026-06-28T00:00:00+09:00
pinned: false
---

# Concurrency & Safety

- **Atomic writes** — every file write goes via temp-file + rename.
- **No write while syncing** — every IPC that mutates the vault (the `notes_*`
  writers, `journal_save` / `quick_create`, `attachments_import` /
  `attachments_import_bytes`, `evernote_import`, the mutating `sync_*` commands
  `init` / `set_remote` / `pull` / `push` / `now`, and the conflict-resolution
  commands) acquires a `tokio::sync::Mutex` keyed on the canonical vault root
  (`services/vault_lock.rs`) before doing any work. Read-only commands
  (`notes_read` / `notes_list`, `journal_open`, `tags_*`, `search_text`,
  `sync_status`, `sync_list_conflicts`) do not lock; atomic-write semantics mean
  they may observe the previous version, never a torn write. Machine-local
  `.naiteh/` state that never syncs — e.g. `workspace_set_last_opened` writing
  `workspace.json` — is written without the lock by design.
- **Tag index** — write commands invalidate the in-memory tag index
  (`services/index.rs`) on success, so `tags_*` reflects the latest content
  without re-scanning per read.
- **Path containment** — note paths are resolved with `notes::resolve_in_vault`,
  which canonicalizes the deepest existing ancestor and refuses anything escaping
  the vault, including via a symlink committed by a malicious synced remote.
- **Pull refuses dirty trees** — `sync_pull` errors with `AppError::Conflict` if
  the working tree has uncommitted changes (the underlying fast-forward
  force-checkout would otherwise clobber them). Use `sync_now` (commits first)
  when there are local edits.
- **Auto-save** — editor debounces saves at 800 ms idle; explicit save on
  Ctrl/Cmd-S.
- **Conflict handling** — `sync_pull` performs a real three-way merge: remote
  and local edits that don't collide are **auto-merged** into a `naiteh: sync
  merge` commit (`services/git.rs`). Only edits that collide produce a conflict;
  naiteh then keeps both versions as `<file>.md` and
  `<file>.conflict-<timestamp>.md` (a `-N` is inserted before the extension if
  that name is already taken) and surfaces them in the Sync panel's Conflicts
  section, where the user picks "Keep mine" (`sync_resolve_keep_ours`) or "Keep
  theirs" (`sync_resolve_keep_theirs`). naiteh never auto-resolves a *colliding*
  edit.
- **Privacy boundary** — v1 has exactly three outbound network paths, all
  user-initiated: (1) Sync sends note bytes to the user's chosen Git remote;
  (2) AI Assist (`ai_improve`) sends the selected passage to the configured Chat
  Completions endpoint; (3) the model picker (`ai_list_models`) does a
  `GET {baseUrl}/models`. If the AI endpoint is a local provider (Ollama), paths
  (2) and (3) stay on the machine. No telemetry, no background calls, no implicit
  AI rewriting.
- **Audit trail** — login attempts and selected work events are recorded in
  append-only local JSONL, visible to admin users from Settings.
