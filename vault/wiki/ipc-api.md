---
title: "IPC API (Tauri Commands)"
tags: [naiteh-wiki, ipc, api, commands]
created: 2026-06-28T00:00:00+09:00
updated: 2026-10-17T12:00:00+09:00
pinned: false
---

# IPC API (Tauri Commands)

All commands return `Result<T, AppError>`. `AppError` serializes to the frontend
as a tagged union (`{ kind, message }`):

```rust
pub enum AppError {
    Io(String),                 // filesystem / process I/O
    NotFound(String),
    InvalidPath(String),        // lexical path-traversal / shape rejection
    AlreadyInitialized(String), // vault init re-run on an existing vault
    Conflict(String),           // dirty-tree pull, sync conflict, etc.
    ConfigCorrupt(String),
    Unauthorized(String),       // no active access, invalid token, bad credentials, lockout
    Validation(String),         // semantic input check (empty field, …)
    Network(String),            // transport didn't reach the remote
    Upstream(String),           // remote replied with error / bad body
    StaleWrite(String),         // conflict-safe write refused: message = current on-disk
                                // version (hex SHA-256), "" if the file is gone; nothing written
    Cancelled,                  // user dismissed a picker / dialog
}
```

The frontend's `formatAppError` (`src/lib/types.ts`) prefixes the ambiguous
categories — `Network` ("Network error — …"), `Upstream` ("Service error — …"),
`Cancelled` ("Operation cancelled") — and shows the backend's message verbatim
for the rest. A network failure is never mislabelled as I/O.

On the wire the `kind` is the variant name, e.g.
`{ "kind": "Unauthorized", "message": "not signed in" }` or
`{ "kind": "StaleWrite", "message": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }`.
`StaleWrite` is returned only by `notes_write` / `journal_save` called with an
`expected_version` (see [Concurrency & Safety → Optimistic version
check](concurrency-safety.md)); the frontend re-reads and lets the user
reconcile instead of overwriting.

## Session gate

App access is enforced by the backend, not just by hiding UI. A Tauri-managed
`ActiveSession` (`services/session.rs`) gates this single-user app instance.
**Every non-auth command calls `require_session` first** and returns
`Unauthorized` without active access, whether the optional app lock is enabled
or disabled. Gated non-auth commands take **no token parameter**.

| Group | Commands | Gate |
|---|---|---|
| Pre-access | `auth_bootstrap`, `auth_unlock`, `auth_migrate` | bootstrap or password/legacy validation |
| Token-gated | `auth_set_lock`, `auth_lock`, `auth_migrate_secrets`, `auth_list_audit_logs`, `auth_log_action` | the active `token` argument, not an account role |
| Session-gated | **every other command**, including vault, app config, AI, calendar and backup | `ActiveSession` |

The frontend first calls `auth_bootstrap`. It issues no vault/settings IPC and
renders no workspace until backend access is ready (`AuthAccess.login` is
non-null). Fresh installs bootstrap without an app login; enabled locks require
password unlock and legacy installs require explicit conversion. Startup errors
are visible and retryable; failure never implies a disabled lock or opens the
shell. No non-auth command is exempt.

Sessions and bearer tokens are **memory-only, without idle or absolute expiry**.
An enabled lock is reapplied by manual lock or app restart, not a timer. There
is no remember UI, token persistence or session-resume IPC.

**Frontend handling.** Every `src/lib/api/*` wrapper calls the backend through
one `invoke` (`src/lib/api/invoke.ts`). Its access-loss handler runs on
`Unauthorized` from **every non-auth command** and exactly these auth commands:
`auth_lock`, `auth_list_audit_logs`, `auth_log_action`, `auth_migrate_secrets`.
It hides the workspace immediately, pauses autosave access, and preserves
editor drafts and pending save/retry entries in memory. `auth_unlock`,
`auth_migrate` and `auth_set_lock` are excluded so invalid passwords remain form
errors; bootstrap errors remain visible/retryable and fail closed.

After access is restored, draft recovery checks `vault_current` against the
retained originating root and the local active vault **before flushing**. A
mismatch or read/save error leaves drafts paused and the workspace withheld,
even with backend access unlocked. **Retry draft recovery** rechecks recovery;
**Return to draft vault** explicitly restores the original vault through
`vault_set_active`, without discarding the queue or resetting the editor, then
rechecks access and the root. Workspace loading rechecks before replacing the
local active vault. The notice warns that edits are not confirmed saved and
the window must stay open.

Manual lock first flushes saves/preserves held edits as copies. A failed flush
refuses locking; otherwise the frontend awaits `auth_lock` acknowledgement
before clearing local access. These guarantees do not make in-memory drafts
durable across app exit. The App-root close guard remains mounted across
locked/loading/error/recovery/shell states and prevents closing when unsaved or
in-flight writes cannot safely flush. See [Concurrency & Safety](concurrency-safety.md).

## Vault

```rust
vault_pick_folder() -> Result<VaultInfo, AppError>
vault_init(root: String) -> Result<VaultInfo, AppError>
vault_current() -> Result<Option<VaultInfo>, AppError>
vault_set_active(root: String) -> Result<VaultInfo, AppError>
vault_list_known() -> Result<Vec<VaultInfo>, AppError>

// One-click first-run setup: create ~/Documents/duramen (deduped
// with -2, -3, … if taken), initialize it, make it active.
vault_create_default() -> Result<VaultInfo, AppError>
```

**Root validation** (`services/vault_path.rs`; rules in
[Vault & Data](vault-and-data.md#where-a-vault-may-live)). `vault_init`,
`vault_set_active` and `vault_create_default` require an absolute path, resolve
it canonically, and refuse filesystem roots, the home folder itself, and
system / app-data locations (`InvalidPath`). `vault_init` may create the folder
if its parent exists; `vault_set_active` requires the folder to already be a
naiteh vault (`.naiteh/`, or `notes/` + `journal/`). The stored / returned
`root` is the canonical path.

## Journal

```rust
journal_month_meta(year: u16, month: u8) -> Result<Vec<DayMeta>, AppError>
journal_open(date: String) -> Result<JournalOpenResult, AppError>   // { path, content, exists, version }
journal_save(date: String, content: String, expected_version: Option<String>, expected_vault_root: String)
    -> Result<JournalSaveResult, AppError>                          // { path, mtime, version }
```

`journal_open` returns the **version** of the entry on disk (`""` when
`exists` is false). `journal_save` has the same content-version and required
originating-vault checks as `notes_write` below. Pass the read `version` as
`expectedVersion` (`""` matches a still-missing entry) and the captured
originating root as the required `expectedVaultRoot`.

## Quick capture

```rust
quick_create() -> Result<NoteMeta, AppError>   // empty note in notes/_inbox/, timestamp filename
quick_list(limit: u32) -> Result<Vec<NoteMeta>, AppError>  // recent _inbox items, newest first
```

## Activity & Timeline

```rust
activity_recent(limit: u32) -> Result<Vec<TimelineItem>, AppError>  // journal mode; mixes entries+notes by mtime
timeline_range(from: String, to: String) -> Result<Vec<TimelineDay>, AppError>  // inclusive YYYY-MM-DD; one day per date, incl. empty
timeline_pinned() -> Result<Vec<TimelineItem>, AppError>  // "On the Agenda"
```

All three read the in-memory index snapshot (`services/index.rs` →
`services/timeline.rs`) rather than re-scanning per call.

Every `TimelineItem` (both kinds) also carries the flattened
[`Placement`](domain-model.md#activity--timeline) fields:

```ts
createdAt: string | null   // front-matter `created` with a time, RFC 3339 local offset
placedAt: string | null    // createdAt, else file mtime (local); null when `created` is date-only
docKind: "note" | "clip" | "journal"
sourceHost: string | null  // host of a clip's `source_url`
```

(`kind` stays the variant tag `"JournalEntry"` / `"Note"`, so the
note/clip/journal distinction is `docKind`.)

**Day assignment in `timeline_range`:** a journal entry lands on the date of
its filename. A note lands on the local date of its front-matter `created`
(timestamp or date-only) when that parses, else on its file mtime's local
date. The day timeline draws an item at `placedAt` when that instant falls on
the shown day; otherwise (date-only `created`, or a journal entry edited on a
later day) it shows as an all-day chip. These markers are local only: no
`calendar_*` command ever receives or returns vault notes or clips.

## Notes

```rust
notes_list(rel_dir: Option<String>) -> Result<Vec<NoteMeta>, AppError>
notes_read(rel_path: String) -> Result<NoteDocument, AppError>      // { content, version }
notes_version(rel_path: String) -> Result<String, AppError>         // current version; NotFound if missing
notes_write(rel_path: String, content: String, expected_version: Option<String>, expected_vault_root: String)
    -> Result<NoteWriteResult, AppError>                            // { meta: NoteMeta, version }
notes_create(rel_dir: String, title: String) -> Result<NoteMeta, AppError>
notes_delete(rel_path: String) -> Result<(), AppError>
notes_rename(from: String, to: String) -> Result<NoteMeta, AppError>

// Folder management. Vault-relative, must live strictly under notes/, symlink-safe
// via resolve_in_vault. The reserved notes/_inbox cannot be renamed or deleted.
notes_list_dirs() -> Result<Vec<String>, AppError>      // includes empty dirs
notes_create_dir(rel_dir: String) -> Result<(), AppError>
notes_delete_dir(rel_dir: String) -> Result<(), AppError>   // recursive
notes_rename_dir(from: String, to: String) -> Result<(), AppError>
```

Every vault-relative path (notes, journal, attachments, Evernote import) goes
through `notes::normalize_rel_path` / `resolve_in_vault`, which reject — among
the rules in [Concurrency & Safety](concurrency-safety.md) — any `.git`
component (case-insensitive; on Windows also the `GIT~N` 8.3 alias) with
`InvalidPath`, so no IPC can write into the repository internals. Paths must
already be in the normal form described in
[Vault & Data → Vault-relative paths](vault-and-data.md#vault-relative-paths);
nothing is silently "fixed up".

- **`notes_list` reads the index.** For `rel_dir` = `None` (meaning `notes/`)
  or any folder under `notes/` or `journal/`, the `NoteMeta`s come from the
  in-memory index snapshot (`services/index.rs`, invalidated by writes and
  the file watcher), filtered to that folder and sorted by `relPath` — no
  per-call file reads. Other folders (e.g. `agents/`) fall back to a walk
  that reads each file. Empty folders come from `notes_list_dirs`, a pure
  directory walk.

- **Originating-vault check (both writers).** `notes_write` and `journal_save`
  require `expected_vault_root: String` (wire: `expectedVaultRoot`), captured
  from the originating vault before any async work. Omitted/null roots cannot
  invoke these writers; an empty root is `Validation`. The backend compares
  the supplied root with its current active root after canonicalization; a
  mismatch or unavailable originating root is `Conflict`, with no file written.
  Once validated, that captured canonical root is used for locking and writing
  even if the shared active-vault setting changes later. There is no fallback
  to whichever vault is active at write time.
- **Versions / conflict-safe writes.** A `version` is the lowercase hex
  SHA-256 of the file's bytes on disk (`services/notes.rs` `file_version`).
  `notes_read` returns the version of what it read; `notes_write` with
  `expected_version: Some(v)` writes only if the file still has version `v`
  (compared under the per-vault lock) and otherwise returns
  `StaleWrite(current)` without touching the file — `current` being the
  on-disk version, or `""` if the file was deleted underneath.
  `expected_version: None` skips only the content-version check (e.g. a new
  file/copy); the originating-vault check is still required.
  On success the result carries the version of the bytes just written (what
  the next save should expect). `notes_version` is the cheap freshness probe
  (e.g. on window focus) that avoids transferring content; it is read-only and
  takes no lock. `notes_create` / `quick_create` keep returning `NoteMeta` —
  the frontend opens the new file via `notes_read`. Wire argument:
  `expectedVersion`.
- `notes_create` names the file from the title by the
  [slug rules](vault-and-data.md#file-names-and-slugs) (`-1`, `-2`, … on
  collision) and writes `title:` as a double-quoted, escaped YAML string, so
  any title round-trips and can't inject front-matter keys.
- `notes_rename` / `notes_rename_dir` allow a **case-only** rename
  (`Note.md` → `note.md`) even on case-insensitive filesystems; any other
  existing target is a `Conflict`. A folder can't be moved into itself
  (`InvalidPath`).
- The folder commands resolve their argument via `resolve_notes_subdir`: it
  must normalize cleanly and lie strictly below `notes/` both lexically and
  after canonicalization (never `notes/` itself, never via a symlink /
  junction out of `notes/`). `notes/_inbox` — by any spelling or filesystem
  alias — is reserved (`Conflict`).
- `on-note-save` [hooks](app-config.md#cli-hooks) fire after `notes_write`,
  `notes_create` and `notes_rename`. (Pinning is a front-matter text edit
  saved through `notes_write`; there is no separate pin command.)

## Search & Tags

```rust
search_text(query: String, limit: u32) -> Result<Vec<SearchHit>, AppError>
tags_list() -> Result<Vec<TagCount>, AppError>
tags_notes(tag: String) -> Result<Vec<NoteMeta>, AppError>
```

`tags_*` read the in-memory tag index (built lazily, invalidated by every write).
`search_text` takes its **file list and each hit's `title`** from that same
index snapshot (`notes/` + `journal/` Markdown, visited in `relPath` order) and
reads only file **contents** per call: a case-insensitive substring match, one
hit per matching line (`line` is 1-based, `excerpt` is the trimmed line cut to
200 chars + `…`), capped at `limit`. A blank query or `limit = 0` returns `[]`.
Content edits are seen immediately; a file created outside the app appears
after the next index invalidation, and a file deleted since the index was built
is skipped.

Contents come from an **in-memory** cache (`services::index::ContentCache`)
keyed by `(relPath, mtime, size)` that holds each file's text and its
lowercased form, so a repeat search re-reads (and re-lowercases) only files
whose mtime or size changed. It holds one vault (switching vaults drops it), is
pruned to the index snapshot's files on every search, and is never written to
disk — a copy under `.naiteh/` would spread every note into Drive / Git sync
and backups. Results are identical to an uncached scan.

The Search panel only calls `search_text` once the trimmed query has at least
**2 characters** (shorter input shows "Type at least 2 characters"), after a
250 ms debounce.

Tags come from front matter in either flow (`tags: [a, b]`) or block-list
(`tags:` + `- a` lines) form; see vault-and-data.md, "Front-matter schema".

## Threading

Every command that reads or walks the vault — `notes_list`, `notes_read`,
`notes_version`, `notes_list_dirs`, `quick_list`, `journal_open`, `journal_month_meta`,
`activity_recent`, `timeline_*`, `tags_*`, `search_text` — is `async` and does
its filesystem work on the blocking pool (`services::fs::run_blocking`), as do
the vault-mutating notes / journal / attachment / Evernote commands and the
Argon2-running auth commands. A synchronous Tauri command would run on the
main (UI) thread, so a vault walk there would freeze the window. Sync commands
use `spawn_blocking` likewise (see below). The AI chat commands are `async`:
config / note / agent / linked-note reads run on the blocking pool, the HTTP
request (and stream) on the async runtime; none holds the vault lock.

## Sync (Git-backed, exposed as Sync/Backup)

```rust
sync_status() -> Result<SyncStatus, AppError>
sync_set_remote(url: String) -> Result<(), AppError>
sync_init() -> Result<(), AppError>
sync_pull() -> Result<SyncStatus, AppError>
sync_push() -> Result<SyncStatus, AppError>
sync_now() -> Result<SyncStatus, AppError>

// Conflict resolution. keep_theirs derives the original path from the sidecar name.
sync_list_conflicts() -> Result<Vec<ConflictPair>, AppError>
sync_resolve_keep_ours(conflict_rel_path: String) -> Result<(), AppError>
sync_resolve_keep_theirs(conflict_rel_path: String) -> Result<(), AppError>
```

All sync commands are `async` and run their git / filesystem work on the
blocking pool (never the main thread). Sync operations are serialized by a
process-wide gate; the per-vault lock is held only for the local phases, so
note saves never wait on the network (see [Concurrency & Safety](concurrency-safety.md)).

**`sync_now` / `sync_pull` pipeline** (`services/git.rs`):

1. *prepare* (locked) — keep `.gitignore` complete; if a pending merge exists,
   either record it (all its sidecars resolved) or fail with `Conflict`
   ("… still need a decision"); then commit local edits (`sync_now`) or refuse
   a dirty tree (`sync_pull`). Conflict sidecars are never committed.
2. *fetch* (unlocked) — download `refs/heads/<branch>` into
   `refs/remotes/origin/<branch>`. An empty destination is fine.
3. *integrate* (locked) — up to date / fast-forward / three-way merge. Colliding
   edits: the merged result goes to the working tree (local version for the
   collided files), remote versions become `*.conflict-<ts>.*` sidecars, a
   pending merge (remote OID + sidecar list) is saved to
   `.naiteh/sync-state.json`, and the command returns `Conflict`. Nothing is
   uploaded until resolved.
4. *push* (`sync_now`, unlocked) — a rejected update returns `Conflict`
   ("sync again").

**Convergence.** Once every sidecar of the pending pull is gone ("Keep mine",
"Keep theirs", or hand-edit then "Keep mine"), the merge is recorded as a commit
whose parents are the local head and the pending remote commit, with the
working tree as content — immediately by the resolve command that removed the
last sidecar, otherwise by the next sync — and the next `sync_now` pushes it.

**Joining an existing destination.** If local and remote histories are
unrelated and local history is only naiteh's own automatic commits
(`naiteh: initial sync` / `naiteh: sync`, no merges) that never synced with
the current tracking ref, naiteh joins the remote: local files are laid on top
of the remote history (`naiteh: join existing vault`); files present on both
sides with different content become sidecars (resolved as above);
`.gitignore` / `.naiteh/*` take the remote's version. Any other unrelated
history returns `Conflict` explaining that the destination holds a different
vault.

**Network limits.** Each fetch / push has a 300 s deadline (aborted from
libgit2 progress callbacks → `Network("… timed out …")`) plus 15 s connect /
60 s read timeouts. Credentials: each method is tried at most once per
operation — SSH username, SSH agent, `~/.ssh/id_ed25519`, `~/.ssh/id_rsa`, the
configured git credential helper (HTTPS), then default — after which the
command fails with `Unauthorized` instead of looping.

**Path safety.** Sidecar writes and conflict resolution reject absolute paths,
`..`, any `.git` component, paths resolving outside the vault, and any symlink
along the path.

The UI never exposes "git", "commit", "rebase", or "remote URL" to casual users
— it shows "Sync now", "Backup destination", etc. Power users see Git terms in
advanced settings.

## AI chat

Chat-in-note, a port of the [chatgpt-md](https://github.com/bramses/chatgpt-md)
Obsidian plugin (MIT). A **chat note** is an ordinary Markdown note; the
document format is in [Domain Model](domain-model.md#chat-note). All four
commands are `async` and session-gated; file reads run on the blocking pool
without the vault lock, and network calls never run on the UI thread.

```rust
ai_chat_send(request_id: String, doc_rel_path: String, content: String)
    -> Result<ChatSendResult, AppError>
ai_chat_stop(request_id: String) -> Result<(), AppError>
ai_infer_title(content: String) -> Result<String, AppError>
ai_list_models(provider: String) -> Result<Vec<String>, AppError>
```

Wire arguments: `{ requestId, docRelPath, content }`, `{ requestId }`,
`{ content }`, `{ provider }`. `ChatSendResult` is `{ model, text }` where
`model` is the `provider@model` actually used.

**`ai_chat_send`** parses `content` (the live editor text of the note at
`docRelPath`), resolves settings (note front matter > agent > global
`ai` settings), expands links in user messages relative to `docRelPath`,
and calls the provider. With effective `stream: true` it emits
`ai:chat-chunk` events as tokens arrive (see [Events](#events)) and returns
the full text at the end; with `stream: false` no events are emitted. The
backend never writes the note — the frontend appends the reply.
Errors:

- `Validation` — no messages after parsing; bad model string (unknown
  provider prefix / empty); a non-numeric `temperature` etc.; missing agent
  (`Agent not found: <name>`); base URL failing the base-URL rule; missing
  key: exactly `No API key for <provider>. Add it in Settings → AI.`;
  a `requestId` already in flight.
- `Network` — connection / TLS / timeout (connect 30 s; 300 s of silence
  between response bytes) or a stream cut off.
- `Upstream` — non-2xx (`<provider> returned <status>: <error.message or
  body, ≤400 chars>`), an error object inside the stream, or an
  unparseable reply.
- `Cancelled` — stopped by `ai_chat_stop`. Text streamed before the stop
  was already delivered through events.
- `Io` / `NotFound`: OS credential storage is unavailable or a referenced key
  is missing. Errors are visible; no legacy-plaintext fallback is used.

**`ai_chat_stop`** aborts the request with that id (drops the HTTP
connection). A no-op for an unknown or finished id.

**`ai_infer_title`** sends one non-streaming request with the global
`defaultModel` and a chatgpt-md-style prompt (infer a title from the
messages, in `inferTitleLanguage`, no `: \ / * ? " < > |`). The reply's
first line is sanitized: `#`, quotes, backticks and those characters
removed, whitespace collapsed, capped at 60 characters, trailing `.`
dropped. Empty → `Upstream`; content with no text → `Validation`.

**`ai_list_models`** returns the provider's model ids sorted, already
prefixed `provider@` (e.g. `ollama@llama3.2`). Needs the provider's key
when it requires one (same `Validation` message as above).

AI commands resolve only the selected provider's credentials, migrating its
legacy key on use when necessary. An unused provider's credentials do not block
a request; keyless providers do not require credential storage for requests.

### Providers

| id | Default base URL | Key | Chat endpoint | Models endpoint |
|---|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | Bearer | `POST /chat/completions` | `GET /models` |
| `anthropic` | `https://api.anthropic.com` | `x-api-key` + `anthropic-version: 2023-06-01` | `POST /v1/messages` | `GET /v1/models` |
| `gemini` | `https://generativelanguage.googleapis.com` | `x-goog-api-key` | `POST /v1beta/models/<m>:generateContent` / `:streamGenerateContent?alt=sse` | `GET /v1beta/models` (generateContent-capable) |
| `openrouter` | `https://openrouter.ai/api/v1` | Bearer | as openai | as openai |
| `zai` | `https://api.z.ai/api/paas/v4` | Bearer | as openai | as openai |
| `ollama` | `http://localhost:11434` | none | `POST /api/chat` (NDJSON stream) | `GET /api/tags` |
| `lmstudio` | `http://localhost:1234/v1` | none | as openai | as openai |

Request mapping: OpenAI-compatible bodies carry `model, messages,
temperature, max_tokens, top_p?, presence_penalty?, frequency_penalty?,
stream` (`developer` role kept only for `openai`, else sent as `system`).
Anthropic gets system/developer messages joined into `system`,
`max_tokens` always, temperature capped at 1. Gemini gets
`systemInstruction`, `contents` (assistant → `model`) and
`generationConfig`. Ollama gets `options { temperature, num_predict, … }`.
Streams: SSE `data:` lines (OpenAI `choices[0].delta.content` until
`[DONE]`; Anthropic `content_block_delta`/`text_delta` until
`message_stop`; Gemini `candidates[0].content.parts[].text`), Ollama
NDJSON `message.content` until `done`. If a streaming request comes back
as `application/json`, it is parsed whole and delivered as one chunk.

### App-config commands

All return the **`AppConfigView`** (no API keys; see
[App Config](app-config.md#ipc-view-vs-disk)):

```rust
app_config_get() -> Result<AppConfigView, AppError>
app_config_set_editor(font_size: u16, line_wrapping: bool) -> Result<AppConfigView, AppError>
app_config_set_ai(settings: AiSettingsInput) -> Result<AppConfigView, AppError>
app_config_set_ai_provider(
    provider: String,          // one of the ids above
    base_url: Option<String>,  // None / blank = keep current; trailing "/" dropped
    api_key: Option<String>,   // Some(non-blank) = replace; None / blank = keep
    clear_api_key: bool,       // true = remove the stored key (wins over api_key)
) -> Result<AppConfigView, AppError>
app_config_set_appearance(
    palette: String,           // trimmed; one of the palette ids
    ui_font: String,           // trimmed CSS font-family; "" = built-in stack
    editor_font: String,       // trimmed CSS font-family; "" = built-in stack
) -> Result<AppConfigView, AppError>
app_config_set_clipping(clipping: ClippingConfig) -> Result<AppConfigView, AppError>  // replaces all fields
```

`AiSettingsInput` (wire `{ settings: { … } }`, camelCase):
`{ addedProviders?, defaultModel, temperature, maxTokens, stream, headingLevel,
inferTitleLanguage, chatsFolder, agentsFolder }`. Validation (`Validation`
/ `InvalidPath`, nothing saved): `defaultModel` must parse (a bare model is
stored as `openai@<model>`); `temperature` 0–2; `maxTokens` 1–1 000 000;
`headingLevel` 1–6; `inferTitleLanguage` 1–50 chars after trimming;
folders must be vault-relative normal form (trailing `/` dropped).
`addedProviders`, when supplied, replaces the ordered Settings provider list
(known ids only; trimmed and deduplicated). Providers removed from the old list
have their key/reference cleared and their endpoint reset atomically with this
update. Omission preserves the list and provider credentials, so ordinary model
and advanced-settings saves leave provider registrations alone.
`app_config_set_ai_provider` touches only that provider's endpoint/key.

Config reads and unrelated settings/vault operations do not require OS
credential storage or discard unmigrated values. Secret updates use secure
storage and an atomic metadata commit; `hasApiKey` is a configured-presence
boolean, not a readback or store-availability check. The manual retry is
`auth_migrate_secrets(token)` below, not an app-config command. See
[App Config](app-config.md#credential-storage).

Other wire arguments are camelCase (`baseUrl`, `apiKey`, `clearApiKey`,
`uiFont`, `editorFont`; `clipping` is the camelCase `ClippingConfig`
object). `app_config_set_appearance` / `app_config_set_clipping` validate
every value (palette ids, font-family rules, clipping value sets — see
[App Config](app-config.md#appearance)) and fail with `Validation` without
saving.

**Base-URL rule:** must parse as a URL with scheme `https`, or `http` only when
the host is `localhost`, `127.0.0.1` or `[::1]`; anything else → `Validation`
(nothing is saved). Re-checked before every request.

**`url:` override rule:** a chat note's or agent file's front-matter `url:` is
accepted only when it equals the provider's base URL configured in Settings,
compared after normalization (scheme and host[:port] lowercased, path kept
case-sensitive, trailing `/` dropped). Otherwise `ai_chat_send` fails with
`Validation("The url: override in a note or agent must match the base URL
configured for <provider> in Settings → AI.")` before any request is built —
for keyed and keyless (Ollama / LM Studio) providers alike, so neither the
API key nor note content can be sent to an arbitrary host. `ai_infer_title`
uses the same `resolve_request` path (it never takes a `url:` and always
uses the Settings base URL).

## Auth & Audit

```rust
auth_bootstrap() -> Result<AuthAccess, AppError>
auth_unlock(password: String) -> Result<AuthAccess, AppError>
auth_migrate(username: String, password: String, new_password: String) -> Result<AuthAccess, AppError>
auth_set_lock(token: String, enabled: bool, current_password: Option<String>, new_password: Option<String>)
    -> Result<AuthAccess, AppError>
auth_lock(token: String) -> Result<(), AppError>
auth_migrate_secrets(token: String) -> Result<(), AppError>
auth_list_audit_logs(token: String, limit: u32) -> Result<Vec<AuditLogEntry>, AppError>
auth_log_action(token: String, action: String, detail: Option<String>) -> Result<(), AppError>
```

`AuthAccess` is `{ lockEnabled: boolean, migrationRequired: boolean,
login: LoginResult | null }`. When access is ready, it contains
`login: { token, session: { username: "local", role: "Admin" },
mustChangePassword: false }`. `local` / `Admin` is internal audit attribution,
not an account role or vault isolation boundary. The opaque token is kept only
in memory; there is no expiry timer, persistence or remember checkbox. There is
no admin route or account-management UI.

**`auth_bootstrap`** determines access before any vault IPC. A fresh install
needs no app login and seeds no account; with the lock disabled it establishes
backend access and returns a non-null `login`. A blocked lock or required legacy
conversion returns `login: null`. Errors remain visible/retryable and fail
closed, rather than being interpreted as a disabled lock.

**`auth_unlock`** validates only the app-lock password and returns ready access.
The optional lock stores an Argon2id hash in app-config `app-lock.json`, not
plaintext. New lock passwords are 8–1024 characters.

**`auth_migrate`** is the explicit one-time conversion when `auth.json` exists
but `app-lock.json` does not (wire: `{ username, password, newPassword }`). It
validates the supplied legacy username and password, then requires a **new**
8–1024-character app-lock password different from that old password. Conversion
enables the app lock and opens access; it never silently disables the lock or
chooses an arbitrary legacy account.
Legacy account hashes and audit history remain but are ignored for subsequent
access. Legacy `remembered-session.json` is deleted; no old token is retained
or moved to credential storage.

**`auth_set_lock`** changes optional lock settings with the active token and
returns `AuthAccess`. Wire arguments are `{ token, enabled, currentPassword,
newPassword }`; both password arguments are nullable. Password changes and
legacy conversion use the app-lock flow, not an account-management command.

**`auth_lock`** validates the active token and closes backend access. It returns
void on success; the frontend must await acknowledgement after a successful
save/preservation flush before clearing local access. Manual lock and app
restart are the only normal relock triggers; there is no session timer.

**`auth_migrate_secrets`** validates the active token and retries safe,
idempotent migration of AI API keys and SFTP passwords/private-key passphrases
to OS credential storage. It returns void, not keys or a migration report.
Ordinary reads/unrelated operations do not depend on this migration succeeding.
Store errors are visible with no plaintext fallback. Calendar secret feed URLs
are not in scope. See [App Config](app-config.md#credential-storage).

**Audit commands** are retained: `auth_list_audit_logs` and `auth_log_action`
both validate the active token, without account-role checks. Renderer action
names are allowlisted; backend access events cannot be forged through
`auth_log_action`. The audit history remains available after legacy conversion.

Removed IPCs: `auth_login`, `auth_resume`, `auth_logout`,
`auth_change_password`, `auth_create_user`, `auth_list_users` and
`auth_set_user_active`. They have no compatibility aliases.

## Attachments

```rust
attachments_import() -> Result<AttachmentImport, AppError>  // native picker → copies into attachments/
attachments_import_bytes(bytes: Vec<u8>, suggested_name: String, mime: Option<String>) -> Result<AttachmentImport, AppError>
// clipboard paste / drag-drop. Empty suggested_name → synthesized paste-<timestamp>.<ext>
attachments_read_image(candidates: Vec<String>) -> Result<String, AppError>
// Markdown viewer: image as a `data:<mime>;base64,…` URL
```

Both imports enforce a 50 MiB ceiling.

**`attachments_read_image`** serves images to the Markdown viewer (the webview's
CSP allows `img-src data:`, and the asset protocol is not enabled, so local
images always pass through the session gate). `candidates` is 1–4 vault-relative
paths tried in order — the viewer sends the note-relative reading of a link
first, then the vault-relative one, because naiteh's own attachments are
vault-relative while Evernote imports sit next to their note. Each candidate goes
through the vault path checks (normal form, no `..` / `.git`, no symlink out of
the vault); only `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg`, `bmp`, `avif` files are
served, up to 20 MiB. Wrong candidate count → `Validation`; no candidate is an
existing image → `NotFound`. Read-only: takes no vault lock.

## Workspace (machine-local last-opened)

```rust
workspace_get() -> Result<WorkspaceState, AppError>
workspace_set_last_opened(last_opened: Option<LastOpened>) -> Result<WorkspaceState, AppError>
```

Persisted to gitignored `.naiteh/workspace.json` so each machine reopens its last
file in that vault.

## Calendar subscriptions

Read-only iCal feeds shown in the calendar panel: a Google Calendar "Secret
address in iCal format", an iCloud "Public Calendar" (`webcal://`) link, or any
public `.ics` URL. All commands are async and session-gated; fetches run on the
async runtime, never under the vault lock. Shapes are in
[Domain Model](domain-model.md#calendar-subscriptions); storage in
[App Config](app-config.md#calendar-subscriptions).

```rust
calendar_list() -> Result<Vec<CalendarSource>, AppError>
calendar_add(name: String, url: String, kind: String, color: String) -> Result<CalendarSource, AppError>
calendar_update(id: String, name: Option<String>, color: Option<String>, enabled: Option<bool>) -> Result<CalendarSource, AppError>
calendar_remove(id: String) -> Result<(), AppError>
calendar_events(start: String, end: String) -> Result<Vec<CalendarEvent>, AppError>
calendar_refresh() -> Result<Vec<CalendarSource>, AppError>
calendar_event_note(calendar_id: String, event_id: String, title: String, start: String, all_day: bool) -> Result<NoteMeta, AppError>
```

- **`calendar_add`**: `url` must be `https://` or `webcal://` (rewritten to
  `https://`), carry no credentials, and name a public host (no localhost,
  `.local`/`.internal`/`.lan`/`.home.arpa`, single-label names, or loopback /
  private / link-local / CGNAT IPs; redirects must stay https + public). `kind`
  is `google` | `apple` | `ics`; `ics` is upgraded to `google` for
  `calendar.google.com` and `apple` for `*.icloud.com`. `color` is one of
  `orange gray green blue purple red teal pink`; `name` 1-100 chars. The feed
  is fetched once: `Validation("Not an iCal calendar")` if the body isn't a
  VCALENDAR, `Network` if the request fails or the server returns non-2xx.
  The full URL is never returned to the renderer (only `urlHost`) and never
  appears in error messages.
- **`calendar_update`**: patch name / color / enabled; `NotFound` for an
  unknown id. **`calendar_remove`** also deletes the cached feed.
- **`calendar_events`**: `start`/`end` are local `YYYY-MM-DD` dates, `end`
  exclusive, span 1-62 days (`Validation` otherwise). Covers enabled sources;
  a source whose cache is older than 10 minutes (or missing) is refetched
  first. A failed fetch sets the source's `lastError` and the old cache is
  used (a failed attempt also backs off for 10 minutes). Recurrences are
  expanded in range: RRULE (`DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY` with
  `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY` incl. ordinals, `BYMONTHDAY`,
  `BYMONTH`), `RDATE`, `EXDATE`, and `RECURRENCE-ID` overrides. Other rule
  parts (`BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, sub-daily `FREQ`) degrade to the
  first occurrence. `TZID` resolves through the IANA tz database; `Z` is UTC;
  floating times and unknown TZIDs (e.g. Windows zone names) are local time.
  Sorted by start. `noteRelPath` comes from the in-memory note index
  (front-matter `event_id`).
- **`calendar_refresh`**: force-refetch every enabled source; returns the
  updated list (per-source failures land in `lastError`, not as an error).
- **`calendar_event_note`**: returns the note whose front matter has
  `event_id: <eventId>`, else creates one under the vault lock in
  `notes/meetings/` named `slug("<YYYY-MM-DD> <title>").md` (unique `-N`
  suffix), with front matter `title`, `date`, `event_id`, `calendar` (source
  name; strings quoted) and `time: "HH:MM"` for timed events (taken from
  `start`'s own offset), and body `# <title>`. `NotFound` for an unknown
  `calendarId`.

## Backup targets

In-app backup of the vault to a **Drive** target (a folder synced by Google
Drive for desktop) and/or an **SFTP** target, plus a compare of the copies and
single-file restore. All commands are async and session-gated; copying runs on
the blocking pool **without** the vault lock. Storage: [App
Config](app-config.md#backup-targets); behaviour: [Vault &
Data](vault-and-data.md#backup).

```ts
BackupTarget { id, kind: "drive" | "sftp", name, enabled, autoBackup: bool,
  intervalMinutes: number /* default 30, min 5 */, lastBackupAt: number | null,
  lastError: string | null,
  drive?: { folder: string },
  sftp?: { host, port, username, authMethod: "password" | "key", keyPath: string | null,
           hasPassword: bool, hasPassphrase: bool, remoteDir, hostKeyFingerprint: string | null } }
BackupRunResult { targetId, uploaded, trashed, unchanged, bytes, durationMs, error: string | null }
CompareReport { generatedAt, sources: [{ id: "local" | <targetId>, name, kind, ok, error, fileCount }],
  rows: [{ relPath, entries: { [sourceId]: { size, hash, mtime: number | null } | null },
           status: "same" | "differs" | "missing" }] }
```

```rust
backup_targets_list() -> Vec<BackupTarget>
backup_drive_candidates() -> Vec<String>
backup_target_add_drive(name, folder) -> BackupTarget
backup_target_add_sftp(name, host, port: Option<u16>, username, auth_method, password: Option<String>,
                       key_path: Option<String>, passphrase: Option<String>, remote_dir: Option<String>)
    -> { target: BackupTarget, fingerprint: String }
backup_target_confirm_host_key(id, fingerprint) -> BackupTarget
backup_target_update(id, name?, enabled?, auto_backup?, interval_minutes?, folder?, remote_dir?,
                     password?, passphrase?, key_path?) -> BackupTarget
backup_target_remove(id) -> ()
backup_test(id) -> ()
backup_run(id: Option<String>) -> Vec<BackupRunResult>
backup_compare(deep: bool, include_same: Option<bool>) -> CompareReport
backup_read_file(source_id, rel_path) -> { content: string | null, size, hash, binary }
backup_restore_file(source_id, rel_path, mode: "copy" | "overwrite", expected_version: Option<String>)
    -> { relPath, version }
```

- **`backup_drive_candidates`**: existing `My Drive` / `내 드라이브` folders
  under every drive-letter root (Windows), `~/Google Drive`, `~` and
  `~/Library/CloudStorage/GoogleDrive-*` (macOS).
- **`backup_target_add_drive`**: `folder` must be absolute; a bare "My Drive"
  root gets `naiteh-backup/<vault name>` appended. `Validation` when the folder
  is inside the vault or the vault is inside it (canonicalized). The folder is
  created.
- **`backup_target_add_sftp`**: only connects and does the SSH handshake (**no
  credential is sent**) and returns the server's host-key fingerprint
  (`SHA256:<base64>`, OpenSSH style). The target is saved with
  `hostKeyFingerprint: null`, `enabled: false`. `remoteDir` empty →
  `naiteh-backup/<vault name>` (relative to the login dir; `/…` = absolute; no
  `..`). Password auth needs `password`; key auth needs an existing `keyPath`.
  `Network` when the server can't be reached.
- **`backup_target_confirm_host_key`** (trust on first use): reconnects and,
  only if the server still presents exactly `fingerprint`, resolves credentials
  from OS storage (migrating legacy values if needed) and authenticates
  (`Unauthorized` on bad credentials), creates the remote dir, then pins the
  key and enables the target. Every later connection refuses a different key
  with `Validation("Host key changed: …")` before resolving credentials or
  authenticating. Store failures are visible, with no plaintext fallback.
- **`backup_target_update`**: `""` clears `password` / `passphrase` /
  `keyPath`; `enabled: true` is refused for an unconfirmed SFTP target;
  `folder` / `remoteDir` are validated like on add; `intervalMinutes < 5` →
  `Validation`. **`backup_target_remove`** never touches the backup data.
- **`backup_test`**: connect, write / read back / delete
  `.naiteh-backup/probe-<random>.txt`.
- **`backup_run`**: `id: null` = every enabled, confirmed target (sequentially;
  per-target failures land in `error`). With an id: `Conflict` when that target
  is already running, `Validation` when its host key is unconfirmed; a failed
  run still returns a result with `error` set (and `lastError` recorded).
- **`backup_compare`**: sources are `local` (hashed now) and every target. A
  Drive target is always hashed from its real files; an SFTP target is read
  from its manifest unless `deep` (then every remote file is downloaded and
  hashed); manifest entries have `mtime: null`. A target that can't be read is
  `ok: false` with `error` and contributes no entries. A row is `missing` when
  any readable source lacks the file, `differs` when hashes differ, else
  `same`; `same` rows only with `includeSame: true`.
- **`backup_read_file`**: `sourceId` is `local` or a target id. `content` is
  the UTF-8 text when ≤ 2 MB; `binary` when the bytes aren't UTF-8.
  `NotFound` when the source lacks the file; excluded paths (`.git/` …) are
  `InvalidPath`.
- **`backup_restore_file`**: reads from the backup first (no lock), then under
  the vault lock: `copy` writes `<stem>.from-<slug(source name)>-<UTC
  stamp>[-N].<ext>` beside the original; `overwrite` replaces the file only if
  its current version equals `expectedVersion` (`null` = the file must not
  exist), else `StaleWrite(current)`. Paths go through `resolve_in_vault`;
  writes are own-change tagged. `sourceId` must be a target.

## Evernote import

```rust
evernote_import() -> Result<EvernoteImportReport, AppError>
// native multi-file .enex picker → notes/<notebook>/<slug>/index.md with attachments alongside
```

Emits per-note progress on the `evernote-import-progress` event channel
(throttled to ~100 events/file):

```rust
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    file_index: usize, total_files: usize, file_name: String,
    note_done: usize, note_total: usize,
}
```

On the wire the frontend receives camelCase keys: `fileIndex`, `totalFiles`,
`fileName`, `noteDone`, `noteTotal`.

Import behaviour (`services/evernote/`):

- **Streaming.** Each `.enex` is read by a streaming reader (`EnexReader`): one
  note is parsed, converted, written and dropped before the next, so neither
  the file nor its note list is held in memory. A cheap counting pass first
  supplies `noteTotal`.
- **Per-note vault lock.** The vault mutex is taken **per note** (held only
  while that note's files are written), not for the whole import, so autosave
  and other writes interleave with a long import. The tag index is invalidated
  after each file that imported anything.
- **All-or-nothing per note.** A note is converted to Markdown before anything
  is written; a note that fails to convert writes nothing, and a write that
  fails part-way removes that note's freshly created folder. The failure is
  counted in `failedCount` with a `note "<title>": …` entry in `errors`; the
  import continues with the next note.
- **Malformed files.** A file that is malformed from the start imports nothing
  (`failedCount += 1`, one entry in `errors`, other selected files still
  import). If the stream breaks after some notes landed, those notes are kept
  and the error is recorded the same way.
- **Lenient entities.** Unknown or malformed HTML entities in ENML (`&foo;`, a
  bare `&`) are kept as literal text instead of failing the note.
- **Links.** `<a href>` targets are sanitized before they reach Markdown:
  `javascript:` / `vbscript:` / `livescript:` and non-raster `data:` URLs
  (anything but `data:image/*` other than SVG) are dropped — the scheme check
  ignores case and embedded whitespace / control characters — and spaces,
  `(`, `)`, `<`, `>` and control characters are percent-encoded.
- **Layout & names.** `notes/<notebook-slug>/<note-slug>/index.md` with the
  note's attachments beside it; slugs follow the
  [slug rules](vault-and-data.md#file-names-and-slugs), with `-2`, `-3`, … on
  collision. Attachment names are de-duplicated case-insensitively, and an
  attachment that would be named `index.md` (any case) is renamed (e.g.
  `index-2.md`) so it can never overwrite the note body. Dropped resources
  (e.g. ink) become per-note `warnings`.

## Events

Besides the request/response commands above, the backend pushes these kinds of
events to every window (Tauri `emit`; the frontend subscribes with `listen`).
Payloads are camelCase.

### `vault:changed` — files changed on disk

Emitted by the vault watcher (`services/watcher.rs`, a `notify` watcher on the
active vault root, recursive) once per debounced batch (~400 ms after the
first raw OS event of the batch):

```json
{
  "vaultRoot": "C:\\Users\\me\\Documents\\duramen",
  "changes": [
    { "relPath": "notes/work/plan.md", "kind": "modified", "own": false },
    { "relPath": "notes/old.md",       "kind": "removed",  "own": false },
    { "relPath": "notes/new.md",       "kind": "created",  "own": false },
    { "relPath": "notes/_inbox/2026-10-11T09-00-00.md", "kind": "created", "own": true }
  ],
  "overflow": false
}
```

- `vaultRoot` is the active vault's stored (canonical) path, as in
  `VaultInfo.root`; a late batch from a watcher that was just replaced carries
  the old root, so compare before acting.
- `relPath` is vault-relative in [normal form](vault-and-data.md#vault-relative-paths)
  (forward slashes). Directories appear with their own path (`kind` applies to
  the directory). A rename arrives as `removed` (old) + `created` (new).
- `kind` ∈ `created` | `modified` | `removed`. One entry per path per batch:
  the raw events for a path are collapsed, and the final kind is decided by
  what was reported **and** whether the path exists when the batch closes —
  gone → `removed`; present after a create **and** a remove in the same batch
  (replace / delete-and-recreate) → `modified`; present after a create →
  `created`; anything else present → `modified`. Because atomic saves (naiteh's
  own, Drive's, many editors') replace the file by rename, an edited note may
  surface as `created`; treat `created` and `modified` alike for an open
  document (reload if its version differs).
- `own` is true when naiteh itself caused the change: every write, directory
  creation, rename and removal the backend performs is recorded in a
  process-wide "recent own changes" set (`services/own_changes.rs`, canonical
  path → instant, 3 s TTL), and the watcher checks each change's path against
  it. Conflict sidecars written by sync, Evernote imports, attachments and
  quick notes are own. Files that libgit2 checks out during a pull are **not**
  tagged (the frontend already reloads after a pull).
- Filtered out entirely (never reported): anything under `.naiteh/` or `.git/`
  (any depth, case-insensitive); naiteh's own temp files
  (`.<name>.tmp.<suffix>`, `.<name>.rename.<suffix>`); `desktop.ini`,
  `Thumbs.db`, `.DS_Store`; `~$*`; `*.tmp`, `*.crdownload`; `*.gdoc`,
  `*.gsheet`, `*.gslides`; names starting with `.~lock.`; and any path that
  cannot be made vault-relative (outside the canonical root, non-UTF-8 name).
- `overflow: true` means the OS watcher lost events (buffer overflow / rescan
  requested); `changes` may then be empty. Treat it as "refresh everything".
- Every batch that contains a non-own change (or an overflow) also invalidates
  the in-memory tag index for that vault, so tags / search / timeline reflect
  external edits on their next read.

### `vault:watch-error` — live updates unavailable

```json
{ "vaultRoot": "G:\\My Drive\\duramen", "message": "native watcher: …; polling watcher: …" }
```

Emitted when no watcher could be started for the active vault or the running
one died (e.g. the vault folder became inaccessible). The native watcher
(ReadDirectoryChangesW / FSEvents / inotify) is tried first; if it fails to
start, `notify`'s polling watcher (2 s scans) takes over silently, so a
virtual drive such as `G:\My Drive` degrades to polling, not to an error.
Only when both fail is this event sent; the frontend shows "live updates
unavailable" and falls back to focus-time `notes_version` checks.

**Lifecycle.** The watcher is Tauri-managed state (`VaultWatcher`, `lib.rs`).
It is started at app setup for the configured active vault (if any) and
restarted — replacing the previous watcher — by `vault_set_active` and
`vault_create_default`, the two commands after which a different vault is
active (`vault_init` alone activates nothing; the frontend follows it with
`vault_set_active`). It runs on its own OS thread, never holds the vault lock,
and emits through the `AppHandle`.

### `backup:progress` / `backup:done` — backup runs

`backup:progress` `{ targetId, done, total, relPath }` while a run uploads /
trashes (throttled to ~10 per second, always including the last item);
`backup:done` `{ targetId, result: BackupRunResult }` after each run, manual or
automatic.

### `ai:chat-chunk` — streamed AI reply text

```json
{ "requestId": "r-17", "delta": "Hello" }
```

Emitted by `ai_chat_send` for each text delta while a streaming request
runs (`stream: true`), in order; concatenating every `delta` for a
`requestId` gives the command's final `text`. Nothing is emitted after the
command returns (including after `Cancelled`). Non-streaming requests emit
nothing.

## Native menu events

Custom native-menu items emit `menu:*` events that `shell/useMenuEvents` routes
to store actions (not direct IPC):

| Event | Action |
|---|---|
| `menu:view` (payload: ViewMode) | Switch panel (Cmd+1..6) |
| `menu:command-palette` | Open the palette (Cmd+P) |
| `menu:toggle-edit` | Switch the open note between view and edit mode (Cmd+Shift+E) |
| `menu:ai-chat-send` | View → Chat: send the active chat note (`ai_chat_send`; Cmd+J) |
| `menu:ai-new-chat` | View → New Chat: create a chat note in `ai.chatsFolder` (Cmd+Shift+J) |
| `menu:ai-select-model` | View → Select Model…: pick the note's `model` (`ai_list_models`) |
| `menu:ai-stop` | View → Stop Streaming (`ai_chat_stop`) |
| `menu:settings` | Open the settings modal (Cmd+,) |
| `menu:new-note` | Notes panel new-note prompt (Cmd+N) |
| `menu:new-folder` | Notes panel new-folder prompt (Cmd+Shift+N) |
| `menu:import-evernote` | Settings modal Evernote import flow |

`ViewMode` is one of journal/notes/calendar/search/tags/sync. Settings
is **not** a view — it is a full-screen modal opened by `menu:settings`,
the Activity Bar gear, the status-bar settings control, or the palette.

## Concurrency note

Every IPC that mutates the vault — the `notes_*` writers, `journal_save`,
`quick_create`, `attachments_*`, `evernote_import`, the `sync_*` commands, and
the conflict-resolution commands — acquires the per-vault mutex
(`services/vault_lock.rs`) before touching files and, when note files changed,
invalidates the tag index on success. Two exceptions to "hold it for the whole
command": `evernote_import` takes the lock per note, and the sync commands hold
it only for their local phases (never across the network). The vault watcher
never takes the lock; `notes_write` / `journal_save` perform their
`expected_version` check and the write under it, so the compare-and-write is
atomic with respect to every other app write. Both writers also require
`expectedVaultRoot` and keep the validated canonical root for the write,
rather than re-reading a later active-vault setting. See
[Concurrency & Safety](concurrency-safety.md).
