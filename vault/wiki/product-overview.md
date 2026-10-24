---
title: "Product Overview"
tags: [naiteh-wiki, product, stack]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-17T12:00:00+09:00
pinned: false
---

# Product Overview

**naiteh** is a desktop note-taking app focused on:

1. **Quick capture + activity overview** — a journal mode that combines fast
   scratchpad writing with a summary of recent work.
2. **Date-focused browsing** — a calendar mode inspired by Agenda (agenda.com),
   with a timeline of notes grouped by day. Its day timeline also shows the
   notes you wrote and your web clippings as markers at their time (front-matter
   `created`, else last modified). These markers are local only: notes and
   clips are never added to your calendars, whose subscriptions stay read-only.
3. **Local-first Markdown notes** — all data lives as plain `.md` files on the
   user's disk.
4. **Sync / Backup**: the vault is a plain folder. Backups are made in-app to
   backup targets (a Google-Drive-synced folder and/or an SFTP server) as
   incremental one-way mirrors (files deleted locally go to the target's
   trash), manually or automatically; a compare view shows where the local
   vault and each copy differ and restores single files (see
   [Vault & Data](vault-and-data.md#backup)). The optional built-in Sync is
   backed by Git under the hood; the UI never says "Git", only "Sync" or
   "Backup".
5. **Tagging** — cross-cutting organization in addition to folders.
6. **AI chat (opt-in)** — chat with an LLM *inside a note*, a port of the
   [chatgpt-md](https://github.com/bramses/chatgpt-md) Obsidian plugin
   (MIT, by Bram Adams) with its document format unchanged. A chat note is
   plain Markdown: messages separated by `<hr class="__chatgpt_plugin">`
   with `role::` headers, settings in front matter (`model:
   provider@model`, `temperature`, `system_commands`, `agent`, …). View ▸
   *Chat* (Cmd+J) sends the conversation — with the bodies of `[[linked]]`
   notes as context — and streams the reply into the note; *New Chat*
   (Cmd+Shift+J), *Select Model…* and *Stop Streaming* complete the set,
   plus title inference. Providers: OpenAI, Anthropic, Gemini, OpenRouter,
   Z.ai (API keys in OS credential storage, only references in app config;
   keys are never returned to the renderer) and Ollama / LM Studio (no key;
   calls stay local with a loopback base URL). A note's `url:` key may only
   restate the base URL set in Settings → AI, so a note can't redirect a key
   or its content to another host. No
   AI network call ever fires without an explicit command. Only the selected
   provider's credentials are resolved for a request.
7. **Single-user access with optional app lock**: fresh installs open without
   an app login. Settings → Security can enable a password-only lock, backed
   by an Argon2id hash in app-config `app-lock.json`. Every non-auth IPC is
   still gated by the backend's `ActiveSession`, even with the lock disabled.
   Sessions and tokens are memory-only, with no expiry timer, remember UI or
   token persistence; an enabled lock requires unlocking after manual lock or
   app restart. Existing `auth.json` without `app-lock.json` requires an
   explicit one-time legacy username/password check and a new 8–1024-character
   app-lock password different from the old password. Conversion enables the
   lock; it never silently disables access control or selects an arbitrary
   account. Old account hashes and audit history are retained but no longer
   determine access, and `remembered-session.json` is deleted without retaining its
   token. There is no admin route or account-management UI. The internal
   `local` / `Admin` session is for audit attribution, not an account role or
   vault isolation. See [IPC API](ipc-api.md#auth--audit).
8. **Appearance & web clipping** — built-in color palettes plus custom
   interface / editor fonts, and configurable conversion of HTML pasted from
   the web into Markdown (see [App Config](app-config.md#appearance)).
9. **Reading view** — notes open rendered (GitHub-flavored Markdown: tables,
   task lists, footnotes; raw HTML sanitized); the Markdown source appears only
   in edit mode (toolbar **Edit** / Cmd+Shift+E). In the reading view, links to
   other notes open them, web links open in the system browser, vault images
   are shown (remote images are not fetched), and task checkboxes can be
   ticked. New notes open straight in edit mode.

## Security Boundary

The optional app lock controls access through this app, **not file encryption**.
Notes, attachments and backup/sync content remain plaintext. Use a private OS
account, screen locking, appropriate vault/app-config permissions and full-disk
encryption for offline disk access or device loss. Disk encryption does not
protect remote copies or against same-user malware in an unlocked OS session.
Private Git repositories and SFTP do not provide end-to-end content encryption;
protect destination access separately.

AI API keys and SFTP passwords/private-key passphrases use OS credential storage.
Store failures are visible, with no plaintext fallback; ordinary metadata reads,
unrelated settings and vault operations do not require that store. Legacy
plaintext is removed only after a secure write and metadata commit, and may
remain in historical backups. Calendar secret feed URLs are outside this
migration's scope. Whole-vault/backup-content encryption remains deferred unless
a concrete content-protection requirement justifies it. See
[App Config](app-config.md#credential-storage) and
[Concurrency & Safety](concurrency-safety.md#validation-status) for migration
details and pending runtime validation.

## Non-goals (v1)

- WYSIWYG editing (editing is source-mode Markdown; the reading view is
  rendered but read-only apart from task checkboxes)
- Backlinks / wiki-links / graph view (deferred to v2.0)
- Plugins / user-authored themes (only the built-in palettes ship)
- Real-time collaboration
- Mobile app (revisited after v1.5)
- Two-way calendar integration. Calendar **subscriptions** are read-only iCal
  feeds (Google "secret address", iCloud public calendar, any `.ics` URL) with
  "Add note" per event; OAuth (Google/Microsoft event editing), native macOS
  EventKit / Reminders, and CalDAV are not implemented
- Implicit AI calls — auto-completion, ghost text, background revision,
  embedding-based search, etc. v1 AI chat is strictly user-initiated.
- Model hosting or a separate chat app/window. Conversations live in
  ordinary notes (chatgpt-md format); there is no conversation database.
- Cloud identity, SSO, multi-user account management or multi-tenant server
  authorization. The optional app lock is single-user app access control.

## Tech Stack

| Layer            | Choice                                                     |
|------------------|------------------------------------------------------------|
| Shell            | **Tauri v2** (latest stable)                               |
| Backend language | **Rust**                                                   |
| Frontend         | **React 18 + TypeScript + Vite**                           |
| Styling          | **CSS Modules**                                            |
| Reading view     | **react-markdown** + `remark-gfm`, raw HTML via `rehype-raw` then `rehype-sanitize` (GitHub schema); external links via `tauri-plugin-opener` (http/https/mailto only) |
| Editor           | **CodeMirror 6** — fenced code blocks get per-language syntax highlighting (100+ grammars via `@codemirror/language-data`, lazy-loaded; exact name/alias match with extension fallback, e.g. ```py) |
| Git integration  | **`git2` crate** (libgit2 bindings)                        |
| AI HTTP client   | **`reqwest` 0.13** with rustls (aws-lc-rs provider, OS certificate store via `rustls-platform-verifier`) — used only by AI chat (SSE / NDJSON streaming read incrementally, no extra crates) |
| Package manager  | **pnpm**                                                   |
| Target OS (v1)   | Windows, macOS, Linux                                      |

> Design rationale ("why these choices") lives in the implementation docs
> (`architecture.md` §2), not here — this page records *what* the stack is.
