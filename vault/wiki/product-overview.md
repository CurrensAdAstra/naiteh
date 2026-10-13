---
title: "Product Overview"
tags: [naiteh-wiki, product, stack]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-12T12:00:00+09:00
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
   Z.ai (API keys stored in app config, never sent to the renderer) and
   local Ollama / LM Studio (no key; nothing leaves the machine). No
   network call ever fires without an explicit command. naiteh stays
   local-first everywhere else — AI chat is the one feature that knowingly
   leaves the local trust boundary.
7. **Local user access control** — the app opens on a login screen before any
   vault content is shown, and the backend enforces it: every non-auth command
   refuses to run until someone is signed in (session gate). A single `admin`
   account (password `admin`) is seeded only on the very first run, and the app
   forces a password change right after that first login. Account management
   is real: any user can change their own password; an admin can create
   accounts (Admin or User role) and enable / disable them. Login mints an
   opaque session token (12 h idle / 7-day expiry); the frontend passes that
   token, never a plain username, to the auth IPCs. Repeated wrong passwords
   lock a username for 5 minutes. The AI API key is write-only from the UI —
   the renderer only learns whether one is set.
8. **Appearance & web clipping** — built-in color palettes plus custom
   interface / editor fonts, and configurable conversion of HTML pasted from
   the web into Markdown (see [App Config](app-config.md#appearance)).
9. **Reading view** — notes open rendered (GitHub-flavored Markdown: tables,
   task lists, footnotes; raw HTML sanitized); the Markdown source appears only
   in edit mode (toolbar **Edit** / Cmd+Shift+E). In the reading view, links to
   other notes open them, web links open in the system browser, vault images
   are shown (remote images are not fetched), and task checkboxes can be
   ticked. New notes open straight in edit mode.

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
- Cloud identity, SSO, or multi-tenant server authorization. v1 auth is local
  app access control backed by the OS app-config directory.

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
