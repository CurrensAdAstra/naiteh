# naiteh — agent context

naiteh is a local-first Markdown note-taking desktop app (Tauri v2 + Rust +
React 18/TS). See `architecture.md` for the full implementation reference.

## Two documentation surfaces

Documentation is split by audience, deliberately:

- **LLM wiki (data / ground truth)** — `vault/wiki/`
  The canonical *facts*: domain model, entity schemas, IPC command spec, vault
  layout, config keys, glossary. A top-level storage location inside the
  self-contained documentation vault at `vault/`. Start at
  [vault/wiki/index.md](vault/wiki/index.md).
  **When you need a fact about how naiteh works, read this first.**

- **Implementation docs (how it's built/run)** — `architecture.md` and `docs/`
  Narrative, design rationale, repo layout, roadmap, work-session logs. Lives
  with the code.

When the two ever disagree on a *fact*, the LLM wiki is the source of truth.

## Layout

```
apps/desktop/src/          React + TypeScript frontend
apps/desktop/src-tauri/    Rust backend (domain/, services/, commands)
vault/                     self-contained documentation vault
  journal/                 (dated entries)
  note/                    (free-form notes)
  wiki/                    the LLM wiki — 8 pages, start at index.md
architecture.md            full implementation reference
docs/sessions/             dated work-session summaries
```

## Build / run

Use the project `Makefile` (run `make help` to list targets); the desktop app is
a pnpm + Tauri workspace under `apps/desktop/`.
