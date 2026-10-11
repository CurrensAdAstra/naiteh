---
title: "Glossary"
tags: [naiteh-wiki, glossary]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-11T18:00:00+09:00
pinned: false
---

# Glossary

| Term | Meaning |
|------|---------|
| Vault | The user-chosen root folder containing all notes |
| Journal entry | A `.md` file in `journal/`; one per local date |
| Quick note | A note in `notes/_inbox/`, captured from journal mode |
| Note | Any Markdown file under `<vault>/notes/` |
| Project | A user-defined folder under `<vault>/notes/`. No separate dir |
| Sync | User-facing name for Git-backed backup/synchronization |
| ViewMode | Which feature the List Panel is showing |
| Timeline | Calendar mode's date-grouped list of notes/entries |
| On the Agenda | The pinned area at the top of the calendar timeline |
| AI chat | naiteh's opt-in AI feature: chat inside a note, ported from the chatgpt-md Obsidian plugin (MIT). View ▸ Chat (Cmd+J) sends the note's conversation to the model and appends the reply. See [Domain Model](domain-model.md#chat-note) |
| Chat note | A Markdown note holding a conversation in chatgpt-md format: messages separated by `<hr class="__chatgpt_plugin">`, each starting with a role header; settings in front matter (`model`, `temperature`, `system_commands`, `agent`, …) |
| Role header | The line that opens a message, e.g. `### role::assistant<span style="font-size: small;"> (openai@gpt-4.1-mini)</span>`; the role (`assistant` / `user` / `developer` / `system`) follows `role::`. A part without one is a user message |
| Model string | `provider@model`, e.g. `anthropic@claude-sonnet-4`, `ollama@llama3.2`; a bare model means `openai` |
| Agent | A note in `ai.agentsFolder` named by a chat's `agent:` key: its front matter is a settings layer under the chat's, its body a system prompt |
| Admin | Local account role that can create / enable / disable users and inspect logs |
| Audit log | Local JSONL history of login and selected work events |
| Session gate | Backend check (`require_session`) that makes every non-auth IPC fail with `Unauthorized` unless someone is signed in to this app instance |
| Session token | Opaque 256-bit hex bearer token minted at login; passed only to the `auth_*` commands that need an identity. Expires after 12 h idle / 7 days |
| Remembered session | Opt-out "keep me signed in on this device" record (`remembered-session.json`, 30-day TTL) that `auth_resume` restores at startup |
| `mustChangePassword` | Account / `LoginResult` flag: the seeded default password is still in use, so the UI demands a new one before showing the app |
| Lockout | 5 failed sign-ins lock a username for 5 minutes (in memory) |
| Conflict sidecar | `<file>.conflict-<timestamp>.<ext>` holding the remote ("theirs") version of a file that collided during sync |
| Pending merge | A pull stopped on conflicts, recorded in `.naiteh/sync-state.json` (`SyncStatus.mergePending`); finished as a merge commit once every sidecar is resolved |
| Hook | User-installed executable in `<app-config-dir>/hooks/` run after a note save, journal save, or sync |
| Palette | One of the built-in color schemes (`appearance.palette`, e.g. `ocean`, `nord`) applied as CSS color tokens — see [App Config](app-config.md#appearance) |
| View mode / Edit mode | How the editor panel shows the open note (`uiStore.editorMode`). **View** (default) renders the Markdown read-only — links, images, task checkboxes work; **Edit** shows the CodeMirror source. Opening a different note returns to view; new notes open in edit |
| Web clipping | Converting `text/html` pasted into the editor to Markdown according to the `clipping` settings — see [App Config](app-config.md#clipping) |
| `AppConfigView` | The IPC shape of app config: the on-disk `AppConfig` with the AI key replaced by `ai.hasApiKey` |
| Normal form (rel path) | The only accepted spelling of a vault-relative path: `/`-separated, no `.`/`..`/empty segments, no `.git` — see [Vault & Data](vault-and-data.md#vault-relative-paths) |
| Version | Lowercase hex SHA-256 of a file's bytes on disk (64 chars). Returned by `notes_read` / `journal_open` / `notes_version`, passed back to `notes_write` / `journal_save` as `expectedVersion` — see [Domain Model → Notes](domain-model.md#notes) |
| Stale write | `AppError::StaleWrite(current)`: a save with an `expectedVersion` found a different version on disk (or no file — `current` is `""`), so nothing was written; the UI re-reads and reconciles |
| Own change | A filesystem change naiteh itself made (recorded by `services/fs.rs` in `services/own_changes.rs`, 3 s TTL); the vault watcher tags it `own: true` in `vault:changed` so the frontend can tell it from an external edit |
| Vault watcher | The `notify`-based recursive watcher on the active vault root (`services/watcher.rs`) that emits debounced `vault:changed` batches and `vault:watch-error` — see [IPC API → Events](ipc-api.md#events) |
