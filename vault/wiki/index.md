---
title: "naiteh LLM Wiki — Index"
tags: [naiteh-wiki, index]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-11T18:00:00+09:00
pinned: true
---

# naiteh LLM Wiki

This is the **data layer** of naiteh's documentation — the canonical facts an
LLM (or a developer) reasons over: what the system *is* and *contains*. It lives
at the top level of the documentation vault (`vault/wiki/`), a first-class
storage location alongside `journal/` and `note/`.

> **Split of responsibilities**
> - **LLM wiki (this directory)** → *data*: domain model, schemas, IPC command
>   spec, vault layout, config keys, glossary. Single source of truth for facts.
> - **Implementation docs (`architecture.md` and `docs/` in the code repo)** →
>   *how it is built, run, and maintained*: narrative, design rationale, repo
>   layout, roadmap, design proposals, work-session logs. Lives with the code.

## Pages

The wiki is eight pages: this index plus the seven below.

| Page | Contents |
|------|----------|
| [Product Overview](product-overview.md) | What naiteh is, features, non-goals, tech stack |
| [Vault & Data](vault-and-data.md) | Vault layout on disk, where a vault may live, backup (in-app Drive / SFTP targets, compare, restore), rel-path normal form, slug rules, front-matter schema |
| [Domain Model](domain-model.md) | IPC-boundary entity types (journal, notes, timeline, sync, auth, config view, …) |
| [IPC API](ipc-api.md) | Every Tauri command, session gate, threading, `AppError` taxonomy, sync pipeline, Evernote import, AI chat (chatgpt-md port), backup targets, `ai:chat-chunk` / `backup:*` events, menu events |
| [App Config](app-config.md) | App-level + per-vault config schema and paths (incl. appearance, HTML-paste clipping and AI providers / chat settings, legacy AI migration), IPC view vs disk, CLI hooks |
| [Concurrency & Safety](concurrency-safety.md) | Locking, tag-index generations, autosave ordering, atomic writes, path containment, privacy boundary |
| [Glossary](glossary.md) | Term definitions |

## Conventions

- All IPC field names are `camelCase` across the boundary (Rust
  `serde(rename_all = "camelCase")`).
- In the **naiteh app's** own vault model, a "project" is just a user-defined
  folder under `notes/` (no separate `projects/` dir, no metadata file) — see
  [Vault & Data](vault-and-data.md). This documentation vault instead promotes
  the wiki to its own top-level `wiki/` directory.
