# Design: Engine daemon + pluggable sync

**Status:** Proposal (not implemented). Captures the architecture decided in
the "separate engine" discussion. Nothing here is built yet — this is the
blueprint the eventual implementation should follow. When a piece lands, move
its *facts* into `vault/wiki/` and its narrative into `architecture.md`, and
strike the corresponding "Proposed" note here.

**Author context:** naiteh is today a single-process Tauri app — the React
webview and the Rust core share one process and talk over Tauri IPC
(`invoke`). Close the window and everything stops. This document proposes
splitting the Rust core out into a long-running **local engine daemon** so
work can happen while the UI is closed, and making backup/sync a
**user-selectable backend**.

---

## 1. Why

Two concrete features force the split, and a third motivates it:

1. **Watch `~/Downloads` / `~/Documents`** — auto-ingest files that appear
   (e.g. a downloaded PDF becomes an attachment + note). This needs a process
   that **outlives the UI window**.
2. **Web clipping** — a browser extension clips a page into the vault. The
   clipper lives in the browser and needs a **local endpoint to post to**.
3. **Future web / multi-device** (see the local-first discussion) — the local
   engine's HTTP API is the same surface a remote sync path would reuse, so
   this split is also step 1 toward that, not a detour.

Both (1) and (2) say the same thing: the vault logic must stop being welded to
the UI window. The answer is a **headless engine + thin UI client**.

## 2. Goals / non-goals

**Goals**
- A long-running local engine that owns all vault I/O and runs independently
  of the UI (always-on, restarted on crash).
- A local API both the UI and a browser extension can call.
- Folder watching with an ingest pipeline.
- Web clipping ingestion.
- Backup/sync as a **settings-selectable backend**: *Git backup* now, *server
  sync* (E2EE) later, behind the same switch.
- Preserve **local-first + privacy**: no plaintext ever leaves the machine to a
  server the user doesn't control.

**Non-goals (for this iteration)**
- Remote/E2EE sync server implementation (interface only; see §8).
- Real-time collaboration / CRDT merge.
- Auto-update of the daemon, health telemetry, remote management.
- Web client / mobile app (separate future work; enabled but not built here).

## 3. Decisions locked

| Decision | Choice |
|---|---|
| Engine lifecycle | **Always-on daemon** (not a UI-bound sidecar). Autostart at login, restart on crash. Auto-update etc. deferred. |
| Sync model | **User-selectable backend** in Settings: `None` / `Git backup` / `Server sync`. Mutually exclusive (radio). |
| First shipped sync | **Git backup** only. `Server sync` is interface-only for now, slotted into the same switch later. |
| Privacy posture | Local-first preserved. Git backup → user's own remote. Server sync → **E2EE, server stores ciphertext only**. |
| Sole writer | The daemon is the **only** process that writes the vault; the UI goes through it. |

## 4. Architecture

```
 ~/Downloads·Documents        Browser extension              Tauri UI (thin client)
      │ fs events               │ POST /clip                   │ local API calls
      ▼                         ▼                              ▼
 ┌──────────────  naiteh engine daemon (always-on, auto-restart, sole writer)  ──────────────┐
 │  127.0.0.1:PORT local HTTP API   (loopback-only · token auth · CORS allowlist)             │
 │                                                                                            │
 │  watcher ─▶ ingest ─▶ vault      clip ─▶ html→md ─▶ vault      notes/journal/search/index  │
 │  vault_lock (single writer lives here, correctly)             auth (local token)           │
 │                                                                                            │
 │  SyncBackend ───▶  [ GitBackup ]   or   [ ServerSync (E2EE) ]   ◀── chosen in Settings      │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
      │                                                    │
      ▼                                                    ▼
 local vault (.md + attachments)                git remote   or   E2EE sync server
```

Everything above the sync line is **local and private**. The sync line is the
only outbound edge, and it is user-chosen: a git remote you own, or an E2EE
server that only ever sees ciphertext.

## 5. The engine daemon

### 5.1 Composition

Today's Rust logic already has the right seam: `commands/*` are thin Tauri IPC
wrappers that delegate to testable `services/*` `_impl` functions taking
explicit paths. The daemon reuses `services/` + `domain/` almost verbatim and
adds three modules:

| Module | New? | Responsibility |
|---|---|---|
| `services/notes`, `attachments`, `index`, `git`, `auth`, … | reuse | vault I/O, tag/timeline index, backup, local auth |
| `services/vault_lock` | reuse (rehomed) | single-writer mutex — now unambiguously owned by the daemon |
| `services/watcher` | **new** | filesystem watching (`notify` crate), debounce, dispatch to ingest |
| `services/ingest` | **new** | file → attachment + note, content-hash dedup, copy-not-move |
| `services/clip` | **new** | clipped HTML → Markdown + downloaded images → note |
| `api/*` | **new** | axum routes exposing the above over loopback HTTP |

`resolve_in_vault` (path containment / symlink safety) and the write mutex move
to their natural home: the daemon is the sole writer, so the multi-writer
question that exists today (UI + future clients) is resolved by construction.

### 5.2 Lifecycle & auto-recovery

Scope for now: **autostart at login + restart on crash.** Nothing more.

| OS | Mechanism | Autostart | Restart on crash |
|---|---|---|---|
| macOS | launchd **LaunchAgent** (`~/Library/LaunchAgents/com.naiteh.engine.plist`) | `RunAtLoad=true` | `KeepAlive=true` |
| Linux | systemd **user service** (`~/.config/systemd/user/naiteh-engine.service`) | `WantedBy=default.target` + `enable` | `Restart=on-failure` |
| Windows | Windows Service with recovery actions, **or** (lighter first cut) login autostart + in-process supervisor | Run key / service | SC failure actions / supervisor |

- **Singleton:** exactly one instance per user. Guard with a pidfile **or** by
  treating a successful bind of the loopback port as the lock (second instance
  fails to bind → exits). This doubles as the vault sole-writer guarantee.
- **Windows is the awkward one** (service registration needs elevation). The
  acceptable first cut is per-user login autostart with a supervisor that
  relaunches on exit; promote to a real service later.
- The daemon must start fast and lazily open the active vault so login isn't
  slowed.

## 6. Local API (daemon ↔ clients)

- **Transport:** HTTP (axum) bound to `127.0.0.1` **only** — never `0.0.0.0`.
  A WebSocket/SSE channel may be added later for push (e.g. "vault changed").
- **Auth:** a local token minted by the daemon and stored in the app-config dir
  (same pattern as today's session token). The UI reads it directly; the
  browser extension receives it via a one-time pairing step (paste, or a
  short-lived pairing code).
- **CORS:** allowlist the extension origin(s) only. A loopback port is
  reachable by any local process and any browser tab, so **the token is the
  real boundary** — loopback binding is necessary but not sufficient.
- **Endpoints (illustrative):**

  ```
  GET  /health
  GET  /vault, POST /vault/activate
  GET  /notes, GET/PUT /notes/{relPath}, POST /notes, DELETE …
  GET  /journal/{date}, PUT /journal/{date}
  GET  /search?q=…, GET /tags
  POST /import           # file → attachment + note (also used by the watcher)
  POST /clip             # { url, title, html } → note   (web clipper)
  GET  /sync/status, POST /sync/now
  ```

  These mirror the ~50 existing IPC commands; the migration is "same
  semantics, HTTP instead of `invoke`".

- **Clients:**
  - **Tauri UI** → thin client. Its `lib/api/*` wrappers swap `invoke(...)` for
    `fetch("http://127.0.0.1:PORT/...")` behind the same function signatures,
    so feature code barely changes. (During P1 the app can still launch the
    engine as a sidecar; see §9.)
  - **Browser extension** → posts to `/clip`.

## 7. Folder watching & ingest

- **Watcher:** the `notify` crate on a configured set of directories
  (e.g. `~/Downloads`, chosen `~/Documents` subfolders). Debounce bursts;
  ignore temp/partial files (`*.crdownload`, `*.part`, dotfiles).
- **Rules (config):** map by extension/mime → destination + note template,
  e.g. `pdf,docx → attachment + a note in notes/_inbox linking it`,
  `png,jpg → attachment`. Unmatched types are ignored.
- **Dedup:** content hash (e.g. blake3/sha256) recorded per import so the same
  file re-appearing (or a re-download) doesn't double-import.
- **Safety:** **copy, never move** the user's files by default — naiteh must not
  mutate `~/Downloads`. All writes go through `resolve_in_vault` containment.
- **Idempotence & crash-safety:** ingest is a queue with an at-least-once,
  dedup-guarded pipeline so a crash mid-ingest can safely retry.

## 8. Web clipping

- **Extension** (separate small project): captures the page or selection,
  sanitizes, and posts `{ url, title, html, selectionHtml? }` to `/clip` with
  the paired token.
- **Engine:** HTML → Markdown. naiteh already converts **ENML → Markdown**
  (`services/evernote/enml`), which is HTML-shaped; the reusable core is there.
  The genuinely new part is a **readability/sanitize** pass (strip nav/ads,
  keep article) before conversion. Images are downloaded into `attachments/`;
  the source URL and clip time land in the note's front matter.
- **MVP fallback:** before an extension exists, a clipper that "downloads" an
  `.html`/`.md` into a watched folder gets you clipping via §7 with **zero clip
  API** — clunky but cheap, useful for validating the pipeline.

## 9. Sync backends

Sync becomes a strategy chosen in Settings. The engine instantiates exactly one
backend; the rest of the engine is identical regardless.

```
Settings › Backup & Sync:
   ( ) None
   (•) Git backup        → push to your own git remote (no server)
   ( ) Server sync       → E2EE sync server (web + multi-device; ciphertext only)
```

```rust
// Illustrative — the seam, not final signatures.
trait SyncBackend {
    async fn push(&self, changes: ChangeSet) -> Result<Cursor, AppError>;
    async fn pull(&self, since: Cursor) -> Result<ChangeSet, AppError>;
    fn status(&self) -> SyncStatus;
}
```

- **`GitBackup` (ship first):** wraps the existing `services/git` engine behind
  the trait. Conflicts already use the sidecar + keep-mine/keep-theirs model,
  which maps cleanly onto note-level sync conflicts.
- **`ServerSync` (later, interface-only now):** an E2EE client. The server
  stores `{ noteId, version, ciphertext_blob, meta }` and offers cursor-based
  push/pull; **it cannot read note contents.** Because of E2EE the server is
  thin and dumb — a versioned encrypted-blob store + auth — so it shares almost
  nothing with the app beyond the wire protocol. Keys live on-device only
  (derived from the account password / device enrollment).
- **Selection:** mutually exclusive radio for now; changing it makes the engine
  re-read config and swap backends. `GitBackup` + `ServerSync` simultaneously is
  a later question.

### 9.1 Data-model prerequisite

Robust bidirectional sync needs more than file path + mtime:

- **Stable note id** in front matter (`id:`), so renames don't look like
  delete+create.
- **Sync-state index** per note: `{ id, version, lastSyncedHash, cursor }`,
  machine-local (alongside the existing `.naiteh/` machine-local state).

This is independent of any server and improves even Git backup, so it can land
early behind whatever backend is active.

## 10. Security & privacy

- **Loopback-only** binding + **token auth** + **CORS allowlist**. The token is
  the boundary; treat the loopback port as public to the machine.
- **Git backup** → the user's own remote; naiteh adds no third party.
- **Server sync** → **E2EE**: ciphertext only leaves the device; the server is a
  different box that cannot read notes. Key management (derivation, device
  enrollment, recovery) is the sensitive design area and gets its own doc when
  `ServerSync` is built.
- The daemon holds the AI key and the vault; its file permissions and the OS
  user account remain the trust boundary, exactly as today.

## 11. Repo / crate structure

Today: one Rust crate (`naiteh`) under `apps/desktop/src-tauri`, plus the React
app. Proposed workspace:

```
crates/
  core/            ← lifted services/ + domain/ (+ new watcher/ingest/clip)
  protocol/        ← shared wire types for the local API and sync backends
apps/
  desktop/         ← Tauri UI; depends on core during P0–P1, then a thin API client
  engine/          ← the daemon binary; depends on core + protocol; exposes the API
extension/         ← browser web-clipper (separate build)
```

- `core` has **no Tauri dependency** — it's pure logic + storage/sync traits.
- `desktop` stays untouched for most of this work; it only changes when it
  switches from in-process calls to the local API (§6).
- `engine` is the new always-on binary.

### 11.1 The four seams that change

1. `services/fs` (`std::fs`) → a **`Storage` trait** (local fs impl now; server
   / encrypted impls later).
2. `services/git` → **`SyncBackend`** (GitBackup impl now; ServerSync later).
3. `services/vault_lock` → **owned by the daemon** as sole writer.
4. `auth` → local **API token** for daemon↔client, plus network auth if/when
   `ServerSync` lands.

Everything else in `services/` (front matter, slugify, ENML→MD, conflict
detection, timeline building, the `_impl` functions) is portable and moves into
`core` unchanged.

## 12. Phased rollout (reversible order)

| Phase | Deliverable | Reversible? |
|---|---|---|
| **P0** ✅ *(done)* | Extract `core` crate (services + domain). Desktop still in-process. Pure refactor, no behavior change. | Fully |
| **P1** | `engine` binary wrapping `core` with the loopback API + token. Tauri **launches it as a sidecar** (dies with the app). UI keeps working. | Fully |
| **P2** | `watcher` + `ingest` pipeline (folder watching). | Fully |
| **P3** | Web-clipper extension → `/clip`. | Fully |
| **P4** | **Promote to a true daemon** — autostart + auto-recovery (§5.2). This is the "always-on" commitment. | Mostly |
| **P5** | `SyncBackend` trait; move Git backup behind it + the Settings switch. Add stable note `id` + sync-state (§9.1). | Fully |
| **P6** *(future)* | `ServerSync` (E2EE) + web client. Separate design doc for key management. | One-way-ish |

Ship value early: after **P0–P4 + P5(GitBackup)** you have an always-on engine
that watches folders, clips the web, and backs up via git — with **no server**
and privacy intact. `ServerSync` is a later, optional addition behind the same
settings switch.

## 13. Open questions

- **Windows daemon ergonomics** — service (elevation) vs login autostart +
  supervisor. Decide before P4.
- **Port allocation / discovery** — fixed port vs. write the chosen port to a
  well-known file the UI/extension read.
- **Config-change propagation** — UI changes the sync mode → daemon reloads
  (watch app-config, or an API signal). Default: watch app-config.
- **Conflict UX across clients** — the sidecar model exists; how the UI surfaces
  conflicts that the daemon resolved in the background.
- **Selective / partial sync** — mobile may not want the whole vault (future,
  `ServerSync`).
- **Upgrade / version skew** — UI and daemon are now separately versioned; need
  a compatibility check on the API.

## 14. Risks

- **"No server" property is traded for a local one.** Loopback + token keep it
  private, but it is a real attack surface (any local process, any browser tab)
  — the token and CORS must be right.
- **Two-process operational cost** — lifecycle, crash recovery, version skew,
  harder debugging vs. today's single process.
- **Scope creep into `ServerSync`/E2EE** — resist until web is actually
  required; P6 is a one-way-ish door and deserves its own design pass.
