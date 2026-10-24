# naiteh

naiteh is a local-first desktop app for Markdown notes and a daily journal.
Every note is a plain `.md` file on your own disk. It has a journal mode for
quick capture with a summary of recent work, a notes mode with a folder tree,
an Agenda-style calendar timeline, tags, and full-text search. The vault is
an ordinary folder, so the recommended backup is a folder-sync service such
as Google Drive; an optional built-in "Sync" uses Git under the hood. For AI,
naiteh lets you chat inside a note, chatgpt-md style: write a question and
press Ctrl+J, and the reply from OpenAI, Anthropic, Gemini, OpenRouter, Z.AI,
Ollama or LM Studio streams into the note (keys in Settings → AI; nothing is
sent unless you run the command). The app is built with Tauri v2 (Rust backend)
and React 18 + TypeScript, and runs on Windows, macOS, and Linux.

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 20 |
| pnpm | 10 (pinned in `package.json` `packageManager`; use Corepack) |
| Rust | stable, >= the `rust-version` in `apps/desktop/src-tauri/Cargo.toml` (CI uses 1.90.0) |
| Platform deps | see below |

### Windows

You need Node.js, Rust through rustup (MSVC toolchain), the Visual Studio 2022
Build Tools with the "Desktop development with C++" (VCTools) workload, and
the WebView2 runtime:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

- WebView2 ships with Windows 10 (1803+) and Windows 11. If it's missing,
  install it with `winget install Microsoft.EdgeWebView2Runtime`.
- rustup defaults to the `stable-x86_64-pc-windows-msvc` toolchain. If you
  changed that, run `rustup default stable-msvc`.
- **Open a new terminal after installing** so the updated `PATH` takes
  effect. Alternatively, `scripts/dev.ps1` refreshes `PATH` in the current
  session and starts the app.
- Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` to stop Corepack from prompting
  before it downloads pnpm (this matters in scripts and CI):
  `$env:COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'` (PowerShell) or
  `setx COREPACK_ENABLE_DOWNLOAD_PROMPT 0` (persistent).

`make` isn't installed on Windows by default. Every `make` target has a root
`pnpm` script equivalent, so pnpm alone is enough.

### macOS / Linux

Install Node.js >= 20 and Rust through [rustup](https://rustup.rs). Then
install the system dependencies from the
[Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/):
Xcode Command Line Tools on macOS, and WebKitGTK 4.1, librsvg, and related
packages on Linux. On Debian/Ubuntu you also need `libssh2-1-dev` and
`libdbus-1-dev`; see `.github/workflows/ci.yml` for the exact package list.
Saving or using AI/SFTP credentials on Linux requires a running, unlocked
Secret Service provider (such as GNOME Keyring or KWallet) on the user's
session D-Bus. There is no automatic plaintext credential fallback.

## Development setup

```sh
corepack enable          # provides the pinned pnpm version
pnpm install
pnpm tauri dev           # or: pnpm tauri:dev / make tauri-dev
```

`pnpm dev` starts only the Vite frontend on http://localhost:4200, without
the native shell.

In **Settings → AI**, use **+ Add provider**, configure its **Connection**,
then choose an LLM **Model**. The minus button removes a provider and its saved
credentials. API keys and local APIs are supported; **Web sign-in** is marked
**Coming soon**. Additional options are under **Advanced chat settings**.

### Security and App Lock

Fresh installs open without an app login. **Settings → Security** can enable
an optional password-only app lock (Argon2id hash in app-config `app-lock.json`).
The backend checks access for every non-auth command. Sessions are memory-only,
without expiry timers, a remember checkbox or persisted tokens; an enabled
lock is reapplied on manual lock or app restart. There is no account management
or admin route.

Existing `auth.json` without `app-lock.json` requires one-time validation of your
legacy username/password and a new 8–1024-character app-lock password different
from the old one. Conversion enables the lock; it never silently disables it or
chooses an account. Old account hashes/audit history remain but no longer
determine access; legacy `remembered-session.json` is deleted without keeping
its token.

App lock is **not vault encryption**. Notes, attachments and backups remain
plaintext. Use a private OS account, screen locking, appropriate file permissions
and full-disk encryption for offline disk access/device loss. Disk encryption
does not protect remote copies or against same-user malware in an unlocked
session. Private Git and SFTP are not end-to-end content encryption; protect
backup access separately.

AI API keys and SFTP passwords/private-key passphrases use OS credential storage,
with references in JSON and no secret-readback IPC. Store errors are visible
with no plaintext fallback. Legacy plaintext is removed only after a secure
write and metadata commit; historical backups may still contain it. Unrelated
settings and vault operations do not require the store. Retry migration through
Settings → Security. Calendar secret feed URLs are outside this migration.

Native OS credential persistence, migration and lock-recovery runtime checks
remain pending as of 2026-10-17; unit tests use a memory credential store. See
the [implementation status](docs/fix-plan-F1-F5.md).

## Backing up your vault

naiteh can keep two backup copies of the vault for you and compare them.
Open **Settings → Backup**:

1. **+ Add Google Drive folder**: pick your "My Drive" folder (Google Drive
   for desktop must be installed and signed in). Backups go to
   `My Drive/naiteh-backup/<vault>`.
2. **+ Add SFTP server**: host, user, password or key file, remote folder.
   On first connect naiteh shows the server's fingerprint; choose **Trust
   this server** only if it matches.
3. Turn on **Auto backup** or press **Back up all now**. Only changed files
   are uploaded; files you delete are moved to the backup's trash folder,
   never deleted there.
4. **Compare copies…** shows the vault, the Drive copy and the SFTP copy side
   by side (same / differs / missing), with a line diff for notes and
   **Restore to vault as copy** / **Overwrite local**.

You can also keep syncing the vault folder itself with Google Drive, as
below.

Keep in mind:

- Settings, accounts and the AI key live outside the vault (`%APPDATA%\naiteh`
  on Windows) and are not part of this backup.
- Use **one** sync method per vault. If you also turn on the in-app Sync (Git)
  for a vault that Drive syncs between several PCs, Drive and Git will fight
  over the `.git` folder. Backup from a single PC is fine either way.
- naiteh watches the vault folder: a note changed by Drive is reloaded if
  you weren't editing it, and if you were, a banner lets you keep yours,
  load the disk version, or save yours as a `.local-…` copy. Edits are
  never overwritten silently. "Live updates off" in the status bar means the
  folder can't be watched (naiteh then re-checks whenever the window gets
  focus).
- Don't edit the same note on two PCs at once; Drive keeps both versions as
  separate files and naiteh won't merge them.
- The in-app Sync (Git) is optional. If you use it with GitHub, use a
  **private** repository, and note that GitHub rejects files over 100 MB, so a
  large Evernote attachment can block every later sync.

## Calendar subscriptions

The Calendar panel can show your Google or iCloud calendars (read-only):
**My calendars → + Add calendar**, paste the calendar's iCal address and
pick a colour.

- Google Calendar: Settings → your calendar → *Integrate calendar* →
  **Secret address in iCal format**.
- iCloud / Mac Calendar: share the calendar as a **Public Calendar** and copy
  the `webcal://` link.

Treat these addresses like passwords. naiteh stores them in its app-config
folder (not in the vault). Calendar mode shows the month, the selected
day's timeline and the open note side by side; each event in the timeline has
**Add note**, which creates (or opens) a meeting note linked to that event.
Your own notes and web clippings appear on the timeline at the time they were
written or clipped; they are shown in naiteh only and never added to your
calendars.

## Checks

`pnpm check` (or `make check`) runs the same checks as CI:

| pnpm | make | What |
|------|------|------|
| `pnpm typecheck` | `make typecheck` | TypeScript |
| `pnpm lint` | `make lint` | ESLint (`--max-warnings=0`) |
| `pnpm test` | `make test` | Vitest |
| `pnpm fmt:check` | `make fmt-check` | `cargo fmt --check` (`pnpm fmt` to fix) |
| `pnpm clippy` | `make clippy` | `cargo clippy -D warnings` |
| `pnpm test:rust` | `make test-rust` | `cargo test` |

For a focused security regression run:

| pnpm | make | What |
|------|------|------|
| `pnpm test:security` | `make test-security` | Both security suites below |
| `pnpm test:security:frontend` | `make test-security-frontend` | App access, optional lock, draft recovery and close protection |
| `pnpm test:security:rust` | `make test-security-rust` | Access gates, credential migration, AI/SFTP secret handling and vault-bound writes |

These tests use an isolated memory credential store, not real OS credentials.
They do not replace native keychain, restart or GUI verification. Linux native
builds still need the D-Bus development library listed in the prerequisites.

The Rust checks need `apps/desktop/dist/` to exist because
`tauri::generate_context!` embeds it. `pnpm rust:prep` (run automatically by
`clippy` and `test:rust`) creates a placeholder if you haven't built the
frontend yet.

`pnpm clean` / `make clean` removes the frontend `dist/` and Cargo's
`target/`.

## Building installers

```sh
pnpm tauri:build         # all installer formats for the host OS
```

Bundles are written to `apps/desktop/src-tauri/target/release/bundle/<format>/`.
To build a single format, pass `--bundles`, for example
`pnpm tauri build --bundles dmg` or `--bundles deb`.

### Windows installer

On Windows, run `pnpm windows-installer` (or `make windows-installer`) to
build the NSIS setup executable. The installer is written to
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

Installers aren't code-signed yet, so Windows SmartScreen and macOS
Gatekeeper will warn on first launch.

## Repository layout and docs

- [CLAUDE.md](CLAUDE.md): short orientation and repo layout
- [architecture.md](architecture.md): implementation reference (stack, layout,
  UI architecture, roadmap)
- [vault/wiki/index.md](vault/wiki/index.md): the LLM wiki, the canonical
  facts (domain model, IPC spec, vault layout, config keys). When it
  disagrees with other docs, the wiki wins.
- `docs/design/`: design proposals (not implemented yet), e.g.
  [engine-daemon.md](docs/design/engine-daemon.md)
- `docs/sessions/`: dated work-session summaries

## Contributing

- CI (`.github/workflows/ci.yml`) runs guards, frontend checks, Rust
  fmt/clippy/tests on Linux, macOS, and Windows, and a debug build on each OS.
- **Any commit that modifies `architecture.md` must include `[architecture]`
  in its subject line**, for example `[architecture] Auth: …`. Pull requests
  that touch it without the marker fail CI.
- Hex colors belong only in `apps/desktop/src/styles/tokens.css`, and
  `font-family` must use a `--font-*` token.
- All Rust filesystem writes go through `services/fs.rs` (`atomic_write`).
- The repo is pnpm-only. Don't commit `package-lock.json` or `yarn.lock`.
