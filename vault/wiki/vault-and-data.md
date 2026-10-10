---
title: "Vault & Data"
tags: [naiteh-wiki, vault, storage]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-10T18:00:00+09:00
pinned: false
---

# Vault & Data

## What is the vault?

A **vault** is a directory on disk that contains all notes, journal entries, and
metadata. naiteh never stores notes anywhere else.

- **First run**: the app offers (a) one-click creation of the default
  vault `~/Documents/duramen` (deduped `duramen-2`, `duramen-3`, …
  if the folder exists), (b) creating a vault in a picked folder, or
  (c) opening an existing vault. The path is stored in app config.
- The active vault can be changed from Settings. naiteh remembers **multiple
  vaults**, but only one is active at a time.

## Where a vault may live

Every in-vault path check only proves a file stays inside the vault root, so the
root itself is validated when it is chosen (`vault_init`, `vault_set_active`,
`vault_create_default`; `services/vault_path.rs`):

- The path must be **absolute**; it is canonicalized (symlinks, `..`, Windows
  8.3 names resolved) and the canonical form is what app config stores.
- It must be a **directory**. `vault_init` may create the folder itself if its
  parent directory already exists; `vault_set_active` requires an existing
  naiteh vault — a `.naiteh/` directory, or the `notes/` + `journal/` layout.
- Refused (`InvalidPath`): any **filesystem root** (`C:\`, `/`, a UNC share
  root); the **home folder itself**; and anything **inside or containing** a
  protected location — on Windows `%SystemRoot%`/`%windir%`, Program Files
  (incl. x86 / W6432), `%ProgramData%`, `%APPDATA%`, `%LOCALAPPDATA%`; on every
  OS the OS config / data dirs (which hold naiteh's own app-config dir),
  `~/.ssh`, `~/.config`, `~/.gnupg`; on Unix `/etc`, `/usr`, `/bin`, `/sbin`,
  `/lib`, `/lib64`, `/boot`, `/dev`, `/proc`, `/sys`, `/System`, `/Library`,
  `~/Library`. "Containing" catches e.g. `C:\Users` or `~/AppData`.
- Ordinary subfolders such as `~/Documents/duramen` are fine.

## Vault layout

```
<vault-root>/
├── .naiteh/                  ← app metadata
│   ├── config.json           ← per-vault settings (synced)
│   ├── sync-state.json       ← last-sync timestamp + pending conflict merge (machine-local, gitignored)
│   └── workspace.json        ← last-opened file (machine-local, gitignored)
├── .git/                     ← managed by Sync feature, hidden from UI; no IPC path may address it
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
`.naiteh/`). The Sync feature keeps `.gitignore` covering the machine-local
files above (`.naiteh/sync-state.json`, `.naiteh/workspace.json`,
`.naiteh/tags.json`): missing lines are appended to an existing `.gitignore` on
every sync, and such files are dropped from the index if an older version
committed them.

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

## Vault-relative paths

Every path that crosses the IPC boundary (`relPath`, `relDir`, `from` / `to`,
`conflictRelPath`, …) is vault-relative in one **normal form**, enforced by
`notes::normalize_rel_path` (and `resolve_in_vault` on top of it). Anything
else is refused with `InvalidPath` — never silently "fixed up", so a caller
can't smuggle a different target past a string comparison:

- `/`-separated; a backslash anywhere is rejected.
- Not empty; no empty segments (`a//b`), no `.` or `..` segments.
- Not absolute (`/x`) and no drive / UNC prefix (`C:`, `C:\`); no NUL bytes.
- No `.git` segment, case-insensitively (on Windows also the 8.3 alias
  `GIT~1`, `git~2`, …).
- Windows only: no `:` in any segment (alternate data streams) and no segment
  ending in `.` or a space (Win32 would strip it, so `notes/_inbox.` would
  *be* `notes/_inbox`).
- Trailing `/` is tolerated and dropped.

`resolve_in_vault` then canonicalizes the deepest existing ancestor and
requires it to stay inside the canonical vault root (so a synced symlink can't
escape). Returned `relPath` values always use forward slashes.

## File names and slugs

- **New notes** (`notes_create`) and **Evernote imports** derive the file /
  folder name from the title with `notes::slugify`: alphanumerics (any
  script) lower-cased, every run of other characters collapsed to one `-`,
  leading `-` trimmed; capped at **80 characters** (counted as chars, not
  bytes); trailing `-`, `.` and spaces removed; `untitled` when nothing is
  left. A Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`,
  `CONIN$`, `CONOUT$`, `COM0`–`COM9`, `LPT0`–`LPT9`, case-insensitive, also
  with an extension) gets `-note` appended (`con` → `con-note`) on every OS,
  so vaults stay portable. Collisions get `-1`, `-2`, … (`notes_create`) or
  `-2`, `-3`, … (Evernote).
- **Quick notes**: `notes/_inbox/YYYY-MM-DDTHH-MM-SS.md` (local time), `-1`,
  `-2`, … on collision.
- **Titles in front matter** (and every string the Evernote importer writes:
  tags, `source_url`, `author`, `import_warnings`) are written as
  **double-quoted, escaped YAML strings** (`notes::yaml_quote`): `\` → `\\`, `"` → `\"`, newline / CR / tab
  → `\n` / `\r` / `\t`, other control characters (and U+2028/U+2029) →
  `\xNN` / `\uNNNN`. The reader (`parse_scalar`) is the exact inverse — it
  also accepts single-quoted (`''` → `'`) and plain scalars — so any title
  round-trips and can never inject extra keys or a closing `---`.

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

The block must start on the first line. Both LF and CRLF line endings are
accepted (files edited on Windows), and the closing `---` may be the last line
with no trailing newline. When the app rewrites the block (pin toggle, tag
edits) it keeps the file's line ending.

When front matter is absent, `title` falls back to the first H1 or the filename,
and timestamps fall back to filesystem mtime.

> **What v1 actually reads.** The note parser (`services/notes.rs`) consumes only
> `title`, `tags`, and `pinned`. `created` / `updated` may be *written* (e.g. by
> the Evernote importer) but are **not** read back — the timeline always uses
> filesystem mtime, not these fields. The Evernote importer also writes
> `source_url`, `author`, `imported_from: evernote` and `import_warnings` (a
> block list); naiteh ignores them when reading.

A future field `date: YYYY-MM-DD` is reserved for v1.5 (assign arbitrary notes to
specific calendar days, Agenda-style). v1 does not implement this — only journal
entries (by file name) and notes whose filesystem mtime falls on that date
appear on the timeline.
