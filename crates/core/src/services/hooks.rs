//! CLI hooks — user-supplied executables that fire on app events.
//!
//! Modeled on git hooks: drop an executable named after the event into
//! the hooks directory and it runs when that event happens.
//!
//! ```text
//! <app-config-dir>/hooks/
//!     on-note-save        ← runs after a note is written
//!     on-journal-save     ← runs after a journal entry is written
//!     on-sync             ← runs after a successful "Sync now"
//! ```
//!
//! ## Why the app-config dir and not the vault
//!
//! Vaults are synced via git. If hooks lived inside the vault, a
//! malicious remote could commit an executable and gain code execution
//! on the next pull + save — the same threat model that made
//! `resolve_in_vault` refuse synced symlinks. Git itself never
//! transmits `.git/hooks` for this reason. Keeping hooks machine-local
//! puts them inside the same trust boundary as the app config and API
//! keys: only someone with local user access can install one. Scripts
//! that need per-vault behaviour can branch on `$NAITEH_VAULT`.
//!
//! ## Contract
//!
//! - The hook must have the executable bit set (Unix). Non-executable
//!   files are ignored, matching git's behaviour.
//! - Environment: `NAITEH_EVENT` (e.g. `note-save`), `NAITEH_VAULT`
//!   (absolute vault root), and — when the event concerns a file —
//!   `NAITEH_REL_PATH` / `NAITEH_ABS_PATH`.
//! - Fire-and-forget: the app never blocks a save on a hook. The hook
//!   runs on a background thread, its stdout/stderr are discarded, and
//!   it is killed after [`HOOK_TIMEOUT`]. A failing hook never fails
//!   the save.
//! - Hooks read the file themselves via `NAITEH_ABS_PATH`; nothing is
//!   piped on stdin (avoids pipe-deadlock foot-guns in shell one-liners).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const HOOKS_DIR: &str = "hooks";
const HOOK_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Events that can trigger a hook. The variant name maps to the hook
/// filename via [`HookEvent::script_name`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    NoteSave,
    JournalSave,
    Sync,
}

impl HookEvent {
    pub fn script_name(self) -> &'static str {
        match self {
            HookEvent::NoteSave => "on-note-save",
            HookEvent::JournalSave => "on-journal-save",
            HookEvent::Sync => "on-sync",
        }
    }

    /// Value of `NAITEH_EVENT` inside the hook process.
    pub fn env_value(self) -> &'static str {
        match self {
            HookEvent::NoteSave => "note-save",
            HookEvent::JournalSave => "journal-save",
            HookEvent::Sync => "sync",
        }
    }
}

/// Fire the hook for `event` if one is installed. Returns immediately;
/// the hook runs (and is timeout-killed) on a detached thread. This is
/// deliberately infallible — a broken hook must never break a save.
pub fn fire(config_dir: &Path, event: HookEvent, vault_root: &Path, rel_path: Option<&str>) {
    let Some(script) = installed_hook(config_dir, event) else {
        return;
    };
    let vault_root = vault_root.to_path_buf();
    let rel_path = rel_path.map(str::to_string);
    std::thread::spawn(move || {
        // Errors are intentionally swallowed; there is no one to report
        // them to on this detached path. Hook authors debug by running
        // their script manually with the documented env vars.
        let _ = run_blocking(&script, event, &vault_root, rel_path.as_deref());
    });
}

/// Resolve the hook script path if it exists and is executable.
fn installed_hook(config_dir: &Path, event: HookEvent) -> Option<PathBuf> {
    let path = config_dir.join(HOOKS_DIR).join(event.script_name());
    if !path.is_file() {
        return None;
    }
    if !is_executable(&path) {
        return None;
    }
    Some(path)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
    // Windows has no executable bit; existence is the opt-in.
    true
}

/// Run the hook to completion (or timeout-kill it). Split from `fire`
/// so tests can call it synchronously.
fn run_blocking(
    script: &Path,
    event: HookEvent,
    vault_root: &Path,
    rel_path: Option<&str>,
) -> std::io::Result<()> {
    let mut cmd = Command::new(script);
    cmd.env("NAITEH_EVENT", event.env_value())
        .env("NAITEH_VAULT", vault_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(rel) = rel_path {
        cmd.env("NAITEH_REL_PATH", rel);
        cmd.env("NAITEH_ABS_PATH", vault_root.join(rel));
    }

    let mut child = cmd.spawn()?;
    let started = Instant::now();
    loop {
        match child.try_wait()? {
            Some(_status) => return Ok(()),
            None if started.elapsed() >= HOOK_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(());
            }
            None => std::thread::sleep(POLL_INTERVAL),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    fn install_hook(config_dir: &Path, event: HookEvent, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = config_dir.join(HOOKS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(event.script_name());
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn hook_runs_with_event_and_path_env() {
        let cfg = tempdir().unwrap();
        let vault = tempdir().unwrap();
        let marker = cfg.path().join("marker");
        install_hook(
            cfg.path(),
            HookEvent::NoteSave,
            &format!(
                "#!/bin/sh\necho \"$NAITEH_EVENT|$NAITEH_VAULT|$NAITEH_REL_PATH\" > {}\n",
                marker.display()
            ),
        );

        let script = installed_hook(cfg.path(), HookEvent::NoteSave).unwrap();
        run_blocking(
            &script,
            HookEvent::NoteSave,
            vault.path(),
            Some("notes/a.md"),
        )
        .unwrap();

        let out = std::fs::read_to_string(&marker).unwrap();
        assert_eq!(
            out.trim(),
            format!("note-save|{}|notes/a.md", vault.path().display())
        );
    }

    #[cfg(unix)]
    #[test]
    fn sync_event_omits_path_env() {
        let cfg = tempdir().unwrap();
        let vault = tempdir().unwrap();
        let marker = cfg.path().join("marker");
        install_hook(
            cfg.path(),
            HookEvent::Sync,
            &format!(
                "#!/bin/sh\necho \"${{NAITEH_REL_PATH:-unset}}\" > {}\n",
                marker.display()
            ),
        );

        let script = installed_hook(cfg.path(), HookEvent::Sync).unwrap();
        run_blocking(&script, HookEvent::Sync, vault.path(), None).unwrap();

        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "unset");
    }

    #[test]
    fn missing_hook_is_a_noop() {
        let cfg = tempdir().unwrap();
        assert!(installed_hook(cfg.path(), HookEvent::NoteSave).is_none());
        // fire() with nothing installed must not panic or spawn.
        fire(
            cfg.path(),
            HookEvent::NoteSave,
            Path::new("/nonexistent"),
            None,
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_is_ignored() {
        let cfg = tempdir().unwrap();
        let dir = cfg.path().join(HOOKS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("on-note-save"), "#!/bin/sh\n").unwrap();
        // Default perms from write() lack the exec bit.
        assert!(installed_hook(cfg.path(), HookEvent::NoteSave).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn fire_is_detached_and_eventually_runs() {
        let cfg = tempdir().unwrap();
        let vault = tempdir().unwrap();
        let marker = cfg.path().join("fired");
        install_hook(
            cfg.path(),
            HookEvent::JournalSave,
            &format!("#!/bin/sh\ntouch {}\n", marker.display()),
        );

        fire(
            cfg.path(),
            HookEvent::JournalSave,
            vault.path(),
            Some("journal/2026/06/2026-06-28.md"),
        );

        // fire() returns immediately; poll briefly for the side effect.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(marker.exists(), "hook did not run within 5s");
    }
}
