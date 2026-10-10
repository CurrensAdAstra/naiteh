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
  Narrative, design rationale, repo layout, roadmap, design proposals,
  work-session logs. Lives with the code.

When the two ever disagree on a *fact*, the LLM wiki is the source of truth.
Code comments point to wiki pages (or `architecture.md` headings by name), not
section numbers.

## Layout

```
apps/desktop/src/          React + TypeScript frontend
apps/desktop/src-tauri/    Rust backend (domain/, services/, commands/)
vault/                     self-contained documentation vault
  journal/                 (dated entries)
  note/                    (free-form notes)
  wiki/                    the LLM wiki — 8 pages, start at index.md
architecture.md            full implementation reference
docs/design/               design proposals (not implemented)
docs/sessions/             dated work-session summaries
scripts/                   dev.ps1 (Windows dev launcher), ensure-dist.mjs
.github/workflows/ci.yml   CI: guards, frontend, Rust on Linux/macOS/Windows
Makefile, package.json     build targets (make) and their root pnpm twins
```

## Build / run

The desktop app is a pnpm + Tauri workspace under `apps/desktop/`. Every
`Makefile` target (`make help`) has a root `pnpm` script equivalent, so on
Windows (no `make`) use pnpm: `pnpm install`, `pnpm tauri:dev`, `pnpm check`
(everything CI runs), `pnpm test:rust`. Windows prerequisites (rustup MSVC,
VS 2022 Build Tools C++ workload, WebView2, Corepack) are in
[README.md](README.md#windows); `scripts/dev.ps1` refreshes `PATH` and starts
the app.

## Commit rule

CI (`.github/workflows/ci.yml`, "Guards") fails a pull request if any commit
touching `architecture.md` lacks `[architecture]` in its subject line, e.g.
`[architecture] Docs: reconcile layout`. Keep `architecture.md` edits in such
commits.
