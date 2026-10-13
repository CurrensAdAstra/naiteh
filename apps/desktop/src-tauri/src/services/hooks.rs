//! CLI hooks — user-supplied executables that fire on app events.
//!
//! Modeled on git hooks: drop an executable named after the event into
//! the hooks directory and it runs when that event happens.
//!
//! ```text
//! <app-config-dir>/hooks/
//!     on-note-save        ← runs after a note is written / created / renamed / re-pinned
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
//! - On Windows there is no executable bit and `CreateProcess` can't run
//!   an extensionless script, so the hook is looked up as
//!   `<name>.exe`, `<name>.cmd`, `<name>.bat`, then `<name>.ps1` (first
//!   match wins). `.cmd` / `.bat` run via `cmd /C`, `.ps1` via
//!   `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File`.
//!   No console window is shown (`CREATE_NO_WINDOW`). An extensionless
//!   hook is ignored on Windows (with a note on stderr).
//! - `on-note-save` fires after every successful note write that
//!   changes a note file's content or location: `notes_write`,
//!   `notes_create`, and `notes_rename` (with the *new* path).
//! - Environment: `NAITEH_EVENT` (e.g. `note-save`), `NAITEH_VAULT`
//!   (absolute vault root), and — when the event concerns a file —
//!   `NAITEH_REL_PATH` / `NAITEH_ABS_PATH`.
//! - Fire-and-forget: the app never blocks a save on a hook. The hook
//!   runs on a background thread, its stdout/stderr are discarded, and
//!   it is killed after [`HOOK_TIMEOUT`]. A failing hook never fails
//!   the save; spawn failures, non-zero exits and timeouts are logged
//!   to the app's stderr.
//! - Hooks read the file themselves via `NAITEH_ABS_PATH`; nothing is
//!   piped on stdin (avoids pipe-deadlock foot-guns in shell one-liners).

use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const HOOKS_DIR: &str = "hooks";

/// Extensions probed (in order) for a hook on Windows.
#[cfg(windows)]
const WINDOWS_HOOK_EXTENSIONS: &[&str] = &["exe", "cmd", "bat", "ps1"];
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
        // Never propagate — a broken hook must not break a save — but
        // do leave a trace so hook authors can tell why nothing happened.
        match run_blocking(&script, event, &vault_root, rel_path.as_deref()) {
            Ok(HookOutcome::Exited(status)) if !status.success() => {
                eprintln!("naiteh: hook {} exited with {status}", script.display());
            }
            Ok(HookOutcome::Exited(_)) => {}
            Ok(HookOutcome::TimedOut) => {
                eprintln!(
                    "naiteh: hook {} killed after {}s timeout",
                    script.display(),
                    HOOK_TIMEOUT.as_secs()
                );
            }
            Err(e) => {
                eprintln!("naiteh: hook {} failed to run: {e}", script.display());
            }
        }
    });
}

/// How a hook run ended.
#[derive(Debug)]
enum HookOutcome {
    Exited(ExitStatus),
    TimedOut,
}

/// Resolve the hook script path if it exists and is executable.
#[cfg(not(windows))]
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

/// Windows: probe `<name>.exe|.cmd|.bat|.ps1`. An extensionless file
/// (the Unix convention) can't be launched by `CreateProcess`, so it is
/// ignored with a hint in the log.
#[cfg(windows)]
fn installed_hook(config_dir: &Path, event: HookEvent) -> Option<PathBuf> {
    let dir = config_dir.join(HOOKS_DIR);
    let base = event.script_name();
    for ext in WINDOWS_HOOK_EXTENSIONS {
        let candidate = dir.join(format!("{base}.{ext}"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let bare = dir.join(base);
    if bare.is_file() {
        eprintln!(
            "naiteh: ignoring hook {}: Windows hooks need a .exe, .cmd, .bat or .ps1 extension",
            bare.display()
        );
    }
    None
}

/// Build the process for `script`, routing script types Windows can't
/// execute directly through their interpreter.
fn build_command(script: &Path) -> Command {
    let ext = script
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let mut cmd = match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(script);
            c
        }
        Some("ps1") => {
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script);
            c
        }
        _ => Command::new(script),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Don't flash a console window for every save.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(all(not(unix), not(windows)))]
fn is_executable(_path: &Path) -> bool {
    // No executable bit on this platform; existence is the opt-in.
    true
}

/// Run the hook to completion (or timeout-kill it). Split from `fire`
/// so tests can call it synchronously.
fn run_blocking(
    script: &Path,
    event: HookEvent,
    vault_root: &Path,
    rel_path: Option<&str>,
) -> std::io::Result<HookOutcome> {
    let mut cmd = build_command(script);
    cmd.env("NAITEH_EVENT", event.env_value())
        .env("NAITEH_VAULT", vault_root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(rel) = rel_path {
        cmd.env("NAITEH_REL_PATH", rel);
        let mut abs = vault_root.to_path_buf();
        for part in rel.split('/').filter(|p| !p.is_empty()) {
            abs.push(part);
        }
        cmd.env("NAITEH_ABS_PATH", abs);
    }

    let mut child = cmd.spawn()?;
    let started = Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(HookOutcome::Exited(status)),
            None if started.elapsed() >= HOOK_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(HookOutcome::TimedOut);
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

    #[test]
    fn build_command_routes_scripts_through_interpreters() {
        let args = |c: &Command| -> Vec<String> {
            c.get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        let cmd = build_command(Path::new("hooks/on-note-save.CMD"));
        assert_eq!(cmd.get_program(), "cmd");
        assert_eq!(args(&cmd)[0], "/C");

        let bat = build_command(Path::new("hooks/on-sync.bat"));
        assert_eq!(bat.get_program(), "cmd");

        let ps = build_command(Path::new("hooks/on-sync.ps1"));
        assert_eq!(ps.get_program(), "powershell");
        let a = args(&ps);
        assert!(a.contains(&"-NoProfile".to_string()));
        assert!(a.windows(2).any(|w| w == ["-ExecutionPolicy", "Bypass"]));
        assert_eq!(a[a.len() - 2], "-File");

        let exe = build_command(Path::new("hooks/on-sync"));
        assert_eq!(exe.get_program(), Path::new("hooks/on-sync").as_os_str());
    }

    #[cfg(windows)]
    fn install_windows_hook(config_dir: &Path, file_name: &str, body: &str) -> PathBuf {
        let dir = config_dir.join(HOOKS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(file_name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[cfg(windows)]
    #[test]
    fn windows_ignores_extensionless_hook() {
        let cfg = tempdir().unwrap();
        install_windows_hook(cfg.path(), "on-note-save", "echo hi");
        assert!(installed_hook(cfg.path(), HookEvent::NoteSave).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_prefers_exe_then_cmd_then_bat_then_ps1() {
        let cfg = tempdir().unwrap();
        install_windows_hook(cfg.path(), "on-sync.ps1", "");
        assert!(installed_hook(cfg.path(), HookEvent::Sync)
            .unwrap()
            .ends_with("on-sync.ps1"));
        install_windows_hook(cfg.path(), "on-sync.bat", "");
        assert!(installed_hook(cfg.path(), HookEvent::Sync)
            .unwrap()
            .ends_with("on-sync.bat"));
        install_windows_hook(cfg.path(), "on-sync.cmd", "");
        assert!(installed_hook(cfg.path(), HookEvent::Sync)
            .unwrap()
            .ends_with("on-sync.cmd"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_cmd_hook_runs_with_event_and_path_env() {
        let cfg = tempdir().unwrap();
        let vault = tempdir().unwrap();
        let marker = cfg.path().join("marker.txt");
        install_windows_hook(
            cfg.path(),
            "on-note-save.cmd",
            &format!(
                "@echo off\r\necho %NAITEH_EVENT% %NAITEH_REL_PATH% %NAITEH_ABS_PATH%> \"{}\"\r\n",
                marker.display()
            ),
        );
        let script = installed_hook(cfg.path(), HookEvent::NoteSave).unwrap();
        let outcome = run_blocking(
            &script,
            HookEvent::NoteSave,
            vault.path(),
            Some("notes/a.md"),
        )
        .unwrap();
        assert!(matches!(outcome, HookOutcome::Exited(s) if s.success()));
        let out = std::fs::read_to_string(&marker).unwrap();
        let expected_abs = vault.path().join("notes").join("a.md");
        assert_eq!(
            out.trim(),
            format!("note-save notes/a.md {}", expected_abs.display())
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_ps1_hook_runs() {
        let cfg = tempdir().unwrap();
        let vault = tempdir().unwrap();
        let marker = cfg.path().join("ps-marker.txt");
        install_windows_hook(
            cfg.path(),
            "on-sync.ps1",
            &format!(
                "Set-Content -LiteralPath '{}' -Value $env:NAITEH_EVENT\r\n",
                marker.display()
            ),
        );
        let script = installed_hook(cfg.path(), HookEvent::Sync).unwrap();
        let outcome = run_blocking(&script, HookEvent::Sync, vault.path(), None).unwrap();
        assert!(matches!(outcome, HookOutcome::Exited(s) if s.success()));
        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "sync");
    }

    #[cfg(windows)]
    #[test]
    fn windows_failing_hook_reports_non_zero_exit() {
        let cfg = tempdir().unwrap();
        let vault = tempdir().unwrap();
        install_windows_hook(cfg.path(), "on-sync.cmd", "@exit /b 3\r\n");
        let script = installed_hook(cfg.path(), HookEvent::Sync).unwrap();
        let outcome = run_blocking(&script, HookEvent::Sync, vault.path(), None).unwrap();
        assert!(matches!(outcome, HookOutcome::Exited(s) if s.code() == Some(3)));
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
