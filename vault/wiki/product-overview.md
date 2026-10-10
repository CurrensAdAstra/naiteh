---
title: "Product Overview"
tags: [naiteh-wiki, product, stack]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-10T18:00:00+09:00
pinned: false
---

# Product Overview

**naiteh** is a desktop note-taking app focused on:

1. **Quick capture + activity overview** — a journal mode that combines fast
   scratchpad writing with a summary of recent work.
2. **Date-focused browsing** — a calendar mode inspired by Agenda (agenda.com),
   with a timeline of notes grouped by day.
3. **Local-first Markdown notes** — all data lives as plain `.md` files on the
   user's disk.
4. **Sync / Backup** — backed by Git under the hood; the UI never says "Git",
   only "Sync" or "Backup".
5. **Tagging** — cross-cutting organization in addition to folders.
6. **AI Assist (opt-in)** — a side panel where the user can revise the currently
   selected text using a third-party Chat Completions API (default OpenAI). The
   API key lives in app config; no network call ever fires without an explicit
   click in the panel. naiteh stays local-first everywhere else — AI Assist is
   the one feature that knowingly leaves the local trust boundary.
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

## Non-goals (v1)

- WYSIWYG editing (source-mode Markdown only)
- Backlinks / wiki-links / graph view (deferred to v2.0)
- Plugins / theming system
- Real-time collaboration
- Mobile app (revisited after v1.5)
- Calendar event integration (system Calendar / Reminders)
- Implicit AI calls — auto-completion, ghost text, background revision,
  embedding-based search, etc. v1 AI Assist is strictly user-initiated.
- Cloud identity, SSO, or multi-tenant server authorization. v1 auth is local
  app access control backed by the OS app-config directory.

## Tech Stack

| Layer            | Choice                                                     |
|------------------|------------------------------------------------------------|
| Shell            | **Tauri v2** (latest stable)                               |
| Backend language | **Rust**                                                   |
| Frontend         | **React 18 + TypeScript + Vite**                           |
| Styling          | **CSS Modules**                                            |
| Editor           | **CodeMirror 6** — fenced code blocks get per-language syntax highlighting (100+ grammars via `@codemirror/language-data`, lazy-loaded; exact name/alias match with extension fallback, e.g. ```py) |
| Git integration  | **`git2` crate** (libgit2 bindings)                        |
| AI HTTP client   | **`reqwest` 0.13** with rustls (aws-lc-rs provider, OS certificate store via `rustls-platform-verifier`) — used only by AI Assist |
| Package manager  | **pnpm**                                                   |
| Target OS (v1)   | Windows, macOS, Linux                                      |

> Design rationale ("why these choices") lives in the implementation docs
> (`architecture.md` §2), not here — this page records *what* the stack is.
