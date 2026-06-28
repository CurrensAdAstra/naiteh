---
title: "App Config"
tags: [naiteh-wiki, config, settings]
created: 2026-06-28T00:00:00+09:00
updated: 2026-06-28T00:00:00+09:00
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
auth.json          # local users + backend-only password hashes (Argon2id)
audit-log.jsonl    # one AuditLogEntry JSON object per line
audit-log.1.jsonl  # previous audit log, rotated here when the active one hits 5 MiB
```

Login attempts are logged by the backend; user work events are logged through
`auth_log_action`. See [Domain Model](domain-model.md) for `AuditLogEntry`.
