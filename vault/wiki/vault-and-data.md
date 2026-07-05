---
title: "Vault & Data"
tags: [naiteh-wiki, vault, storage]
created: 2026-06-28T00:00:00+09:00
updated: 2026-06-28T23:30:00+09:00
pinned: false
---

# Vault & Data

## What is the vault?

A **vault** is a directory on disk that contains all notes, journal entries, and
metadata. naiteh never stores notes anywhere else.

- **First run**: the app offers (a) one-click creation of the default
  vault `~/Documents/heartwood` (deduped `heartwood-2`, `heartwood-3`, …
  if the folder exists), (b) creating a vault in a picked folder, or
  (c) opening an existing vault. The path is stored in app config.
- The active vault can be changed from Settings. naiteh remembers **multiple
  vaults**, but only one is active at a time.

## Vault layout

```
<vault-root>/
├── .naiteh/                  ← app metadata
│   ├── config.json           ← per-vault settings (synced)
│   ├── sync-state.json       ← last-sync timestamp (machine-local, gitignored)
│   └── workspace.json        ← last-opened file (machine-local, gitignored)
├── .git/                     ← managed by Sync feature, hidden from UI
├── journal/
│   └── YYYY/
│       └── MM/
│           └── YYYY-MM-DD.md
├── notes/                    ← free-form notes; subfolders = "projects"
│   ├── _inbox/               ← quick notes captured in journal mode
│   ├── <project-A>/
│   ├── <project-B>/
│   └── ...
└── attachments/              ← images, PDFs etc. referenced from notes
```

The in-memory tag index (`services/index.rs`) is rebuilt on vault open / after
any write; v1 keeps no on-disk tag cache (a future `tags.json` may live under
`.naiteh/`). The Sync feature writes a `.gitignore` covering the machine-local
files above.

## Rules

- One **journal entry** per calendar day. Filename is the local date,
  `YYYY-MM-DD.md`.
- A **"project"** is simply a user-defined folder under `notes/`. No separate
  `projects/` directory, no project metadata file.
- `notes/_inbox/` is reserved for quick captures from journal mode. The leading
  underscore sorts it to the top and signals "system". Filenames are
  `YYYY-MM-DDTHH-MM-SS.md`.
- Folders under `notes/` nest freely; naiteh imposes no structure beyond
  `_inbox/`.
- All files are UTF-8 Markdown. Front matter is optional but supported (YAML).

## Front-matter schema (optional)

```yaml
---
title: "Optional human title"
tags: [work, idea]
created: 2026-05-09T10:30:00+09:00
updated: 2026-05-09T11:00:00+09:00
pinned: false                # used by calendar's "On the Agenda" pin area
---
```

When front matter is absent, `title` falls back to the first H1 or the filename,
and timestamps fall back to filesystem mtime.

> **What v1 actually reads.** The note parser (`services/notes.rs`) consumes only
> `title`, `tags`, and `pinned`. `created` / `updated` may be *written* (e.g. by
> the Evernote importer) but are **not** read back — the timeline always uses
> filesystem mtime, not these fields.

A future field `date: YYYY-MM-DD` is reserved for v1.5 (assign arbitrary notes to
specific calendar days, Agenda-style). v1 does not implement this — only journal
entries and notes with `created`/`mtime` on that date appear on the timeline.
