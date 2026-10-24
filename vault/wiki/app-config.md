---
title: "App Config"
tags: [naiteh-wiki, config, settings]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-24T18:00:00+09:00
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
    "subView": "timeline"        // legacy; no longer read (Calendar mode is month | day timeline | note)
  },
  "journal": {
    "splitRatio": 0.5
  },
  "ai": {
    "addedProviders": ["openai"],
    "defaultModel": "openai@gpt-4.1-mini",
    "temperature": 0.7,
    "maxTokens": 4096,
    "stream": true,
    "headingLevel": 3,
    "inferTitleLanguage": "English",
    "chatsFolder": "notes/chats",
    "agentsFolder": "notes/agents",
    "providers": {
      "anthropic":  { "baseUrl": "https://api.anthropic.com" },
      "gemini":     { "baseUrl": "https://generativelanguage.googleapis.com" },
      "lmstudio":   { "baseUrl": "http://localhost:1234/v1" },
      "ollama":     { "baseUrl": "http://localhost:11434" },
      "openai":     { "apiKeyRef": "v1-0123456789abcdef0123456789abcdef", "baseUrl": "https://api.openai.com/v1" },
      "openrouter": { "baseUrl": "https://openrouter.ai/api/v1" },
      "zai":        { "baseUrl": "https://api.z.ai/api/paas/v4" }
    }
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
defaults. Unknown keys are ignored by typed views (e.g. the removed `ai.chat`);
ordinary updates preserve untouched legacy secret values.

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

### AI

Chat-in-note settings (a port of chatgpt-md; see
[IPC API → AI chat](ipc-api.md#ai-chat)). Set with `app_config_set_ai`
(chat defaults and provider registrations) and `app_config_set_ai_provider`
(one provider's URL / key).

Settings → AI is a three-step flow: **Providers → Connection → Model**.
Only added providers appear in the list, with + / − controls. API-key access
and keyless local APIs work; **Web sign-in** is disabled and marked **Coming
soon** (there is no browser-authentication implementation). Model listing is
scoped to the provider being configured, after its connection step. Model IDs
can also be entered manually, and the selected model becomes `defaultModel`.
Temperature, token limits, formatting and folders are under collapsed
**Advanced chat settings**.

| Key | Meaning | Default |
|-----|---------|---------|
| `ai.addedProviders` | ordered provider ids added in Settings; model pickers list only added, configured providers | `[]` |
| `ai.defaultModel` | `provider@model`, used when a note has no `model:` | `openai@gpt-4.1-mini` |
| `ai.temperature` | 0–2 | `0.7` |
| `ai.maxTokens` | 1–1 000 000 | `4096` |
| `ai.stream` | stream replies (`ai:chat-chunk`) | `true` |
| `ai.headingLevel` | 1–6, `#` count of the `role::` headers the editor writes | `3` |
| `ai.inferTitleLanguage` | language `ai_infer_title` writes in (1–50 chars) | `English` |
| `ai.chatsFolder` | vault-relative folder for New Chat | `notes/chats` |
| `ai.agentsFolder` | vault-relative folder `agent: <name>` resolves in | `notes/agents` |
| `ai.providers.<id>.baseUrl` | per provider, base-URL rule below | see the provider table in the IPC page |
| `ai.providers.<id>.apiKeyRef` | opaque OS credential-store reference; omitted when unset, never in the IPC view | — |

Provider ids: `openai`, `anthropic`, `gemini`, `openrouter`, `zai`,
`ollama`, `lmstudio`. Loading always yields all seven (missing ones get
defaults, unknown ids are dropped, a blank `baseUrl` falls back to the
default). `addedProviders` is independent of those built-in definitions:
an explicit empty list stays empty, duplicates and unknown ids on disk are
dropped. Older configs without the list retain providers with a configured
key, plus local providers selected by `defaultModel` or with a custom endpoint.
Removing a provider clears its stored key/reference and resets its endpoint
in the same atomic config update. Out-of-range scalars on disk fall back to
their defaults.

**Pre-chat compatibility** (`ai.apiKey` / `ai.model` /
`ai.baseUrl`, no `defaultModel`): if `baseUrl` is a loopback host
(`localhost` / `127.0.0.1` / `[::1]`) on port 11434, its origin becomes
`providers.ollama.baseUrl` and `defaultModel` = `ollama@<model>` (the key
is not used by Ollama); otherwise the effective key and URL belong to
`providers.openai` and `defaultModel` = `openai@<model>`. When `defaultModel`
is present, legacy root keys are ignored for effective settings. Reading this
format does not require credential storage or remove legacy values; unrelated
writes preserve unmigrated secrets. Secure migration is described below.

## IPC view vs disk

The schema above is the **on-disk** format (`AppConfig`, credential references
included; older files can still contain unmigrated `apiKey` values). It never
crosses the IPC boundary as-is: `app_config_get`,
`app_config_set_editor`, `app_config_set_ai`, `app_config_set_ai_provider`,
`app_config_set_appearance` and `app_config_set_clipping` return an
**`AppConfigView`** — the same fields (`appearance` and `clipping` as-is),
except each provider exposes `hasApiKey`, not its key or `apiKeyRef`:

```json
"ai": {
  "addedProviders": ["openai"],
  "defaultModel": "openai@gpt-4.1-mini",
  "temperature": 0.7,
  "maxTokens": 4096,
  "stream": true,
  "headingLevel": 3,
  "inferTitleLanguage": "English",
  "chatsFolder": "notes/chats",
  "agentsFolder": "notes/agents",
  "providers": {
    "anthropic": { "hasApiKey": false, "baseUrl": "https://api.anthropic.com" },
    "openai": { "hasApiKey": true, "baseUrl": "https://api.openai.com/v1" }
  }
}
```

(`providers` always lists all seven ids, alphabetically.) `hasApiKey` is
true when a reference or a non-blank legacy key is configured; it does not probe
store availability or confirm that the referenced entry exists. The renderer
can set, keep, or clear a key through `app_config_set_ai_provider`
(`apiKey` / `clearApiKey`, see
[IPC API](ipc-api.md#app-config-commands)) but can never read it back.

Every provider `baseUrl` must be
`https://…`, or `http://` only for `localhost`, `127.0.0.1` or `[::1]`
(local providers such as Ollama / LM Studio). The rule is enforced when
saving and again before every AI request, so a hand-edited `config.json`
with a plain-http remote URL is refused rather than used. A note's or
agent's `url:` front-matter key may only restate the configured `baseUrl`
(see [IPC API](ipc-api.md#app-config-commands)).

## Credential Storage

AI API keys and SFTP passwords/private-key passphrases use `keyring` **3.6.3**:

| OS | Credential store |
|---|---|
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | Persistent Secret Service over the user's session D-Bus; a running, unlocked provider is required (not a session-only kernel keyring) |

New secret writes store opaque `apiKeyRef`, `passwordRef` or `passphraseRef`
references in JSON, not plaintext. There is no secret-readback IPC. Ordinary
metadata reads (`app_config_get`, backup-target listing), unrelated settings
updates and vault operations neither require the credential store nor discard
unmigrated values. For an AI request, only the selected provider's credentials
are resolved. SFTP credentials are resolved only after the host-key check.

Migration runs safely and idempotently on secret use/update, or through the
active-token `auth_migrate_secrets(token)` manual retry (returns no secret or
report). It stages new unique credential entries, then atomically commits JSON
metadata per file. Only after both secure write and metadata commit succeed is
legacy plaintext removed. Failed commits retain previous metadata/usable
references; cleanup of superseded entries and unreferenced staged entries is
best effort. A partially completed multi-file migration can be retried.

Unavailable stores or missing referenced credentials produce visible errors;
neither case falls back to plaintext, including when a legacy value also exists.
Historical config copies/backups may still contain old plaintext. Calendar
secret feed URLs are explicitly outside this migration's scope. Credential
storage does not encrypt vault content or protect against same-user malware.
Unit tests use an in-memory store; native OS persistence and end-to-end runtime
validation remain pending (see [Concurrency & Safety](concurrency-safety.md#validation-status)).

## Other app-config files

```
app-lock.json            # optional password-only app lock; Argon2id password hash, no session tokens
auth.json                # legacy accounts/hashes retained after explicit conversion; not used for later access
audit-log.jsonl          # one AuditLogEntry JSON object per line
audit-log.1.jsonl        # previous audit log, rotated here when the active one hits 5 MiB
remembered-session.json  # legacy only: deleted, never resumed; no legacy token retained
hooks/                   # user-installed CLI hooks (see below)
calendars.json           # calendar subscriptions incl. their secret URLs (see below)
calendar-cache/<id>.ics  # last successfully fetched body of each subscription
backup-targets.json      # Drive / SFTP metadata incl. passwordRef / passphraseRef (see below)
```

App-access events are logged by the backend; work events are logged through
`auth_log_action`, which validates the active token and
accepts only an allowlist of action names (see [IPC API](ipc-api.md#auth--audit)).
See [Domain Model](domain-model.md) for `AuditLogEntry`.

## App Lock and Legacy Conversion

Fresh installs need no app login and seed no account. The optional app lock
stores an Argon2id hash in `app-lock.json`, separate from `config.json`; new
passwords are 8–1024 characters. Sessions/tokens live only in memory, without
idle or absolute expiry. An enabled lock is reapplied on manual lock and app
restart, not on a timer. There is no remember UI or persisted session token.

An existing `auth.json` with no `app-lock.json` requires explicit one-time
validation of the supplied legacy username/password and a **new** app-lock
password, 8–1024 characters and different from the old password. Successful
conversion enables the lock. It never silently disables the lock or chooses an
arbitrary account. Legacy account hashes and audit history remain on disk but
do not control subsequent access; `remembered-session.json` is deleted rather
than migrated to credential storage. The internal `local` / `Admin`
`AuthSession` is only audit attribution, not a multi-user role or vault boundary.
There is no admin route or account-management UI. Every non-auth IPC still
checks `ActiveSession`, whether the optional lock is enabled or disabled.

## Calendar subscriptions

`calendars.json` lives in the app-config dir, **not** in the vault, so the
secret feed URLs are never synced or backed up with notes. They remain plaintext
here and are **not** included in the AI/SFTP credential-store migration:

```json
{ "sources": [ {
  "id": "3f9a0c1d2e4b5a6c", "name": "Work", "kind": "google", "color": "blue",
  "enabled": true, "url": "https://calendar.google.com/calendar/ical/.../basic.ics",
  "lastSyncedAt": 1791000000, "lastError": null, "lastAttemptAt": 1791000000
} ] }
```

`lastSyncedAt` is the fetched-at time of `calendar-cache/<id>.ics` (unix
seconds); `lastAttemptAt` (backend-only) is the last try, success or not. A
cache younger than 10 minutes is reused by `calendar_events`. Only the
`CalendarSource` view (with `urlHost`, no `url`) crosses IPC. See
[IPC API](ipc-api.md#calendar-subscriptions).

## Backup targets

`backup-targets.json` (app-config dir, never in the vault):

```json
{ "targets": [ {
  "id": "9c1e04d2a7b3f5e6", "kind": "sftp", "name": "NAS", "enabled": true,
  "autoBackup": true, "intervalMinutes": 30,
  "lastBackupAt": 1791000000, "lastError": null, "lastAttemptAt": 1791000000,
  "sftp": { "host": "nas.example", "port": 22, "username": "me",
            "authMethod": "password", "keyPath": null,
            "passwordRef": "v1-0123456789abcdef0123456789abcdef",
            "remoteDir": "naiteh-backup/notes",
            "hostKeyFingerprint": "SHA256:…" } } ] }
```

A Drive target has `"drive": { "folder": "G:\\My Drive\\naiteh-backup\\notes" }`
instead of `sftp`. Passwords and private-key passphrases use OS credential
storage, referenced by `passwordRef` / `passphraseRef`; legacy `password` /
`passphrase` values remain only until safe migration succeeds. Neither secrets
nor references cross IPC: the `BackupTarget` view has `hasPassword` /
`hasPassphrase` instead (`lastAttemptAt` is backend-only too). These booleans
describe configured credentials, not store availability. A private key file
stays wherever `keyPath` points; the file itself is not moved into the store. See
[IPC API](ipc-api.md#backup-targets).

## CLI hooks

Git-hook-style executables under `<app-config-dir>/hooks/`, named after
the event. Machine-local **by design**: vaults sync via git, so a hook
inside a vault would let a malicious remote gain code execution — the
hooks dir is trusted machine-local executable configuration alongside
`app-lock.json`, outside the vault.

| Hook | Fires after |
|------|-------------|
| `hooks/on-note-save`    | a successful `notes_write`, `notes_create`, or `notes_rename` (with the **new** path) — every note write that changes a note file's content or location |
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
