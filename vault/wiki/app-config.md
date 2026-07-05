---
title: "App Config"
tags: [naiteh-wiki, config, settings]
created: 2026-06-28T00:00:00+09:00
updated: 2026-06-29T09:00:00+09:00
pinned: false
---

# App Config

App-level config (not per-vault) lives in the OS app-config directory:

| OS      | Path                                                |
|---------|-----------------------------------------------------|
| Windows | `%APPDATA%\naiteh\config.json`                      |
| macOS   | `~/Library/Application Support/naiteh/config.json`  |
| Linux   | `~/.config/naiteh/config.json`                      |

## Schema

```json
{
  "activeVault": "/Users/me/Documents/MyVault",
  "knownVaults": [
    "/Users/me/Documents/MyVault",
    "/Users/me/Documents/Work"
  ],
  "theme": "light",
  "editor": {
    "fontSize": 14,
    "lineWrapping": true
  },
  "calendar": {
    "subView": "timeline"
  },
  "journal": {
    "splitRatio": 0.5
  },
  "ai": {
    "apiKey": null,
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

Per-vault settings live separately in `<vault>/.naiteh/config.json`.

## Other app-config files

```
auth.json                # local users + backend-only password hashes (Argon2id)
audit-log.jsonl          # one AuditLogEntry JSON object per line
audit-log.1.jsonl        # previous audit log, rotated here when the active one hits 5 MiB
remembered-session.json  # opt-in "keep me signed in" token + 30-day expiry (see IPC auth_resume)
hooks/                   # user-installed CLI hooks (see below)
```

Login attempts are logged by the backend; user work events are logged through
`auth_log_action`. See [Domain Model](domain-model.md) for `AuditLogEntry`.

## CLI hooks

Git-hook-style executables under `<app-config-dir>/hooks/`, named after
the event. Machine-local **by design**: vaults sync via git, so a hook
inside a vault would let a malicious remote gain code execution — the
hooks dir sits in the same trust boundary as `auth.json` and the AI key.

| Script | Fires after |
|--------|-------------|
| `hooks/on-note-save`    | a successful `notes_write` |
| `hooks/on-journal-save` | a successful `journal_save` |
| `hooks/on-sync`         | a successful `sync_now` |

Contract (facts):

- The file must exist **and** have the executable bit set (Unix); on
  Windows existence alone opts in.
- Environment passed to the process: `NAITEH_EVENT` (`note-save` /
  `journal-save` / `sync`), `NAITEH_VAULT` (absolute vault root), and —
  for the two save events — `NAITEH_REL_PATH` + `NAITEH_ABS_PATH`.
- Nothing is piped on stdin; hooks read the file via `NAITEH_ABS_PATH`.
- Fire-and-forget: runs detached, stdout/stderr discarded, killed after
  a 30 s timeout. A failing hook never fails the save.
- Scripts that need per-vault behaviour branch on `$NAITEH_VAULT`.
