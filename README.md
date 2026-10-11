# naiteh

naiteh is a local-first desktop app for Markdown notes and a daily journal.
Every note is a plain `.md` file on your own disk. It has a journal mode for
quick capture with a summary of recent work, a notes mode with a folder tree,
an Agenda-style calendar timeline, tags, and full-text search. The vault is
an ordinary folder, so the recommended backup is a folder-sync service such
as Google Drive; an optional built-in "Sync" uses Git under the hood. An opt-in AI Assist
panel can revise selected text through an OpenAI-compatible API, and it sends
nothing unless you click it. The app is built with Tauri v2 (Rust backend)
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
packages on Linux. On Debian/Ubuntu you also need `libssh2-1-dev`; see
`.github/workflows/ci.yml` for the exact package list.

## Development setup

```sh
corepack enable          # provides the pinned pnpm version
pnpm install
pnpm tauri dev           # or: pnpm tauri:dev / make tauri-dev
```

`pnpm dev` starts only the Vite frontend on http://localhost:4200, without
the native shell.

### First login

The app opens on a local login screen. On first run it seeds a single
**`admin`** account whose password is the same as the username. **Change
that default password right after your first login** (Settings → account).
The admin can then create more accounts in Settings.

## Backing up your vault

The vault is a plain folder (default `Documents/duramen`), so **Google Drive
for desktop is the recommended, primary backup**. It handles large Evernote
attachments and keeps deleted files and earlier versions for a while. The
same steps, with your vault path and a copy button, are in the app under
**Settings → Backup**.

1. Install Google Drive for desktop (Windows:
   `winget install Google.GoogleDrive`) and sign in.
2. Drive settings → **My Computer** → **Add folder** → pick the vault folder
   → **Sync with Google Drive**.
3. That's it: every note save, attachment and Evernote import is uploaded.

Keep in mind:

- Settings, accounts and the AI key live outside the vault (`%APPDATA%\naiteh`
  on Windows) and are not part of this backup.
- Use **one** sync method per vault. If you also turn on the in-app Sync (Git)
  for a vault that Drive syncs between several PCs, Drive and Git will fight
  over the `.git` folder. Backup from a single PC is fine either way.
- Don't edit the same note on two PCs at once; Drive keeps both versions as
  separate files and naiteh won't merge them.
- The in-app Sync (Git) is optional. If you use it with GitHub, use a
  **private** repository, and note that GitHub rejects files over 100 MB, so a
  large Evernote attachment can block every later sync.

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
