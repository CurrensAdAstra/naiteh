---
title: "App Config"
tags: [naiteh-wiki, config, settings]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-10T20:00:00+09:00
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
  },
  "appearance": {
    "palette": "default",
    "uiFont": "",
    "editorFont": ""
  },
  "clipping": {
    "htmlPaste": "markdown",
    "headingStyle": "atx",
    "bulletMarker": "-",
    "codeBlockStyle": "fenced",
    "emphasis": "_",
    "strong": "**",
    "linkStyle": "inline",
    "images": "keep",
    "tables": "gfm"
  }
}
```

Every section is `serde(default)`: a `config.json` written before a section
existed (e.g. without `appearance` / `clipping`) loads with that section's
defaults.

Per-vault settings live separately in `<vault>/.naiteh/config.json`.

### Appearance

Set through `app_config_set_appearance` (see [IPC API](ipc-api.md#ai-assist));
the renderer applies it as CSS custom properties on the document root
(palette color tokens, `--font-ui`, `--font-editor`).

| Key | Values | Default |
|-----|--------|---------|
| `palette` | `default`, `ocean`, `forest`, `sunset`, `lavender`, `rose`, `nord`, `midnight` (`nord` and `midnight` are dark schemes) | `default` |
| `uiFont` | CSS `font-family` string for the interface; `""` = built-in stack from `styles/tokens.css` | `""` |
| `editorFont` | CSS `font-family` string for the editor; `""` = built-in stack | `""` |

Validation (on save; failure → `Validation`, nothing saved): `palette` is
trimmed and must be one of the ids above. Fonts are trimmed, at most 200
characters, and may not contain `;` `{` `}` `<` `>` `\` or control characters.

### Clipping

How `text/html` clipboard content pasted into the editor is turned into
Markdown. Set as a whole through `app_config_set_clipping`; every field is a
closed set of string values (anything else → `Validation`, nothing saved).

| Key | Values | Default |
|-----|--------|---------|
| `htmlPaste` | `markdown` (convert) · `plain` (text only) · `html` (insert the HTML) | `markdown` |
| `headingStyle` | `atx` (`# H`) · `setext` (underlined; h1/h2 only) | `atx` |
| `bulletMarker` | `-` · `*` · `+` | `-` |
| `codeBlockStyle` | `fenced` · `indented` | `fenced` |
| `emphasis` | `_` · `*` | `_` |
| `strong` | `**` · `__` | `**` |
| `linkStyle` | `inline` (`[t](url)`) · `reference` (`[t][1]` + link list at the end) | `inline` |
| `images` | `keep` (`![alt](src)`) · `drop` | `keep` |
| `tables` | `gfm` (pipe tables) · `html` (keep `<table>`) · `text` (cells as lines) | `gfm` |

Paste behaviour: an image on the clipboard keeps priority and still goes
through attachments; pasting inside a fenced code block inserts plain text;
`html` mode still strips scripts, event-handler attributes and `javascript:`
URLs.

## IPC view vs disk

The schema above is the **on-disk** format (`AppConfig`, unchanged — `ai.apiKey`
is stored in `config.json` as before). It never crosses the IPC boundary as-is:
`app_config_get`, `app_config_set_editor`, `app_config_set_ai`,
`app_config_set_appearance` and `app_config_set_clipping` return an
**`AppConfigView`** — the same fields (`appearance` and `clipping` as-is),
except `ai` is replaced by a key-less view:

```json
"ai": {
  "hasApiKey": true,
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1"
}
```

`hasApiKey` is true when a non-blank key is stored. The renderer can set,
keep, or clear the key through `app_config_set_ai` (`apiKey` / `clearApiKey`,
see [IPC API](ipc-api.md#ai-assist)) but can never read it back.

`ai.baseUrl` must be `https://…`, or `http://` only for `localhost`,
`127.0.0.1` or `[::1]` (local providers such as Ollama). The rule is enforced
when saving and again before every AI request, so a hand-edited `config.json`
with a plain-http remote URL is refused rather than used.

## Other app-config files

```
auth.json                # local users: username, role, active, passwordHash (Argon2id), mustChangePassword
                         # seeded with admin/admin (mustChangePassword: true) only when the file is missing
audit-log.jsonl          # one AuditLogEntry JSON object per line
audit-log.1.jsonl        # previous audit log, rotated here when the active one hits 5 MiB
remembered-session.json  # "keep me signed in" token + 30-day expiry (login checkbox, on by default; see IPC auth_resume)
hooks/                   # user-installed CLI hooks (see below)
```

Login attempts, session resumes, account changes and password changes are logged
by the backend; user work events are logged through `auth_log_action`, which
accepts only an allowlist of action names (see [IPC API](ipc-api.md#auth--audit)).
See [Domain Model](domain-model.md) for `AuditLogEntry`.

## CLI hooks

Git-hook-style executables under `<app-config-dir>/hooks/`, named after
the event. Machine-local **by design**: vaults sync via git, so a hook
inside a vault would let a malicious remote gain code execution — the
hooks dir sits in the same trust boundary as `auth.json` and the AI key.

| Hook | Fires after |
|------|-------------|
| `hooks/on-note-save`    | a successful `notes_write`, `notes_create`, `notes_rename` (with the **new** path), or `notes_set_pinned` — every note write that changes a note file's content or location |
| `hooks/on-journal-save` | a successful `journal_save` |
| `hooks/on-sync`         | a successful `sync_now` |

Not hooked: `notes_delete`, folder commands, `quick_create`, attachments,
Evernote import, `sync_pull` / `sync_push`, conflict resolution.

Contract (facts):

- **Unix (macOS / Linux):** the extensionless file (`hooks/on-note-save`)
  must exist **and** have an executable bit set; otherwise it is ignored
  (like git).
- **Windows:** there is no executable bit and an extensionless script
  can't be launched, so the hook is looked up as `<name>.exe`,
  `<name>.cmd`, `<name>.bat`, then `<name>.ps1` — first match wins.
  `.cmd` / `.bat` run via `cmd /C`; `.ps1` via `powershell -NoProfile
  -NonInteractive -ExecutionPolicy Bypass -File`; `.exe` directly. No
  console window is shown. An extensionless `hooks/on-note-save` is
  ignored (a note is printed to stderr).
- Environment passed to the process: `NAITEH_EVENT` (`note-save` /
  `journal-save` / `sync`), `NAITEH_VAULT` (absolute vault root), and —
  for the two save events — `NAITEH_REL_PATH` (vault-relative, `/`) +
  `NAITEH_ABS_PATH`.
- Nothing is piped on stdin; hooks read the file via `NAITEH_ABS_PATH`.
- Fire-and-forget: runs on a detached thread, its stdout/stderr discarded,
  killed after a 30 s timeout. A failing hook never fails the command.
  Spawn failures, non-zero exit codes and timeouts are logged to the app's
  own stderr (`naiteh: hook … exited with …` / `… killed after 30s timeout`
  / `… failed to run: …`).
- Scripts that need per-vault behaviour branch on `$NAITEH_VAULT`.
