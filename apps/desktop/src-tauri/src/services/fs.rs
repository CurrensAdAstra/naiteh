//! Filesystem service.
//!
//! Every disk write in naiteh must go through [`atomic_write`] (see
//! vault/wiki/concurrency-safety.md). The implementation writes to a sibling temp file,
//! fsyncs it, then renames over the target — atomic on POSIX and on
//! NTFS via `MoveFileEx` semantics that Rust's `rename` invokes.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::domain::AppError;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_suffix() -> String {
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let counter = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{pid}-{nanos}-{counter}")
}

/// Atomically write `contents` to `target`.
///
/// Creates parent directories on demand. On any failure, the temp file is
/// removed and the original `target` is left untouched.
pub fn atomic_write(target: &Path, contents: &[u8]) -> Result<(), AppError> {
    let parent = target.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("path has no parent: {}", target.display()))
    })?;
    fs::create_dir_all(parent)?;

    let file_name = target
        .file_name()
        .ok_or_else(|| {
            AppError::InvalidPath(format!("path has no file name: {}", target.display()))
        })?
        .to_string_lossy()
        .into_owned();

    let tmp_path: PathBuf = parent.join(format!(".{file_name}.tmp.{}", unique_suffix()));

    let write_result = (|| -> Result<(), AppError> {
        let mut f = File::create(&tmp_path)?;
        f.write_all(contents)?;
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(AppError::Io(e.to_string()));
    }
    Ok(())
}

/// Ensure a directory exists (no error if already present).
pub fn ensure_dir(dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    Ok(())
}

/// Run blocking filesystem work on Tauri's blocking thread pool.
///
/// Synchronous `#[tauri::command]`s execute on the main (UI) thread, so
/// any command that walks or reads the vault must be `async` and push
/// its work through here instead — otherwise a large vault freezes the
/// window. Also used by async write commands so file I/O never stalls
/// an async-runtime worker.
pub async fn run_blocking<T, F>(f: F) -> Result<T, AppError>
where
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("background task failed: {e}")))?
}

/// True when `to` is merely a different-case spelling of the existing
/// entry `from` in the same directory — i.e. on a case-insensitive
/// filesystem (Windows, default macOS) `to.exists()` is reporting
/// `from` itself, not a separate file.
///
/// Decided by listing the parent directory: if no entry is spelled
/// exactly like `to`'s name, then `to` resolved via case folding to
/// `from`. On a case-sensitive filesystem a real `to` would be listed
/// verbatim, so this correctly returns false there.
pub fn is_case_only_alias(from: &Path, to: &Path) -> bool {
    let (Some(from_name), Some(to_name)) = (from.file_name(), to.file_name()) else {
        return false;
    };
    let (Some(from_s), Some(to_s)) = (from_name.to_str(), to_name.to_str()) else {
        return false;
    };
    if from_s == to_s || from_s.to_lowercase() != to_s.to_lowercase() {
        return false;
    }
    let (Some(from_parent), Some(to_parent)) = (from.parent(), to.parent()) else {
        return false;
    };
    match (from_parent.canonicalize(), to_parent.canonicalize()) {
        (Ok(a), Ok(b)) if a == b => {}
        _ => return false,
    }
    if !from.exists() || !to.exists() {
        return false;
    }
    let Ok(entries) = fs::read_dir(from_parent) else {
        return false;
    };
    !entries
        .filter_map(|e| e.ok())
        .any(|e| e.file_name() == to_name)
}

/// Rename `from` → `to`, handling a case-only rename (`Note.md` →
/// `note.md`) on case-insensitive filesystems via a two-step rename
/// through a unique temporary sibling name. Callers are expected to
/// have already rejected a genuinely different existing `to`.
pub fn rename_entry(from: &Path, to: &Path) -> Result<(), AppError> {
    if !is_case_only_alias(from, to) {
        return fs::rename(from, to).map_err(|e| AppError::Io(e.to_string()));
    }
    let parent = to
        .parent()
        .ok_or_else(|| AppError::InvalidPath(format!("path has no parent: {}", to.display())))?;
    let name = from
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = parent.join(format!(".{name}.rename.{}", unique_suffix()));
    fs::rename(from, &tmp).map_err(|e| AppError::Io(e.to_string()))?;
    if let Err(e) = fs::rename(&tmp, to) {
        // Put it back so the user doesn't lose the entry to a hidden name.
        let _ = fs::rename(&tmp, from);
        return Err(AppError::Io(e.to_string()));
    }
    Ok(())
}

/// Atomically write a JSON-serializable value (pretty-printed + trailing newline).
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), AppError> {
    let mut bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Io(format!("serialize json: {e}")))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

/// Read and parse a JSON file. Returns `ConfigCorrupt` on parse failure.
pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    let bytes = fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::NotFound(format!("missing file: {}", path.display()))
        }
        _ => AppError::Io(e.to_string()),
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|e| AppError::ConfigCorrupt(format!("{}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use tempfile::tempdir;

    #[test]
    fn atomic_write_creates_file_and_parents() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("nested/sub/data.txt");
        atomic_write(&target, b"hello").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hello");
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("data.txt");
        atomic_write(&target, b"first").unwrap();
        atomic_write(&target, b"second").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second");
    }

    #[test]
    fn atomic_write_leaves_no_temp_files_on_success() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("data.txt");
        atomic_write(&target, b"hi").unwrap();
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftovers.is_empty(), "stray temp files: {leftovers:?}");
    }

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Sample {
        a: u32,
        b: String,
    }

    #[test]
    fn json_round_trip() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("doc.json");
        let value = Sample {
            a: 7,
            b: "hi".into(),
        };
        write_json(&target, &value).unwrap();
        let back: Sample = read_json(&target).unwrap();
        assert_eq!(back, value);
    }

    #[test]
    fn read_json_missing_returns_not_found() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("missing.json");
        let err = read_json::<Sample>(&target).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
    }

    #[test]
    fn case_only_rename_of_file_succeeds() {
        let dir = tempdir().unwrap();
        let from = dir.path().join("Note.md");
        let to = dir.path().join("note.md");
        atomic_write(&from, b"body").unwrap();
        rename_entry(&from, &to).unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["note.md".to_string()]);
        assert_eq!(fs::read(&to).unwrap(), b"body");
    }

    #[test]
    fn case_only_rename_of_directory_succeeds() {
        let dir = tempdir().unwrap();
        let from = dir.path().join("Work");
        let to = dir.path().join("work");
        atomic_write(&from.join("a.md"), b"x").unwrap();
        rename_entry(&from, &to).unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["work".to_string()]);
        assert!(to.join("a.md").is_file());
    }

    #[test]
    fn distinct_files_are_not_case_aliases() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a.md");
        let b = dir.path().join("b.md");
        atomic_write(&a, b"a").unwrap();
        atomic_write(&b, b"b").unwrap();
        assert!(!is_case_only_alias(&a, &b));
        // Same exact name is not a case-only rename either.
        assert!(!is_case_only_alias(&a, &a));
    }

    #[test]
    fn run_blocking_returns_closure_result() {
        let v = tauri::async_runtime::block_on(run_blocking(|| Ok::<_, AppError>(41 + 1)));
        assert_eq!(v.unwrap(), 42);
        let e = tauri::async_runtime::block_on(run_blocking(|| {
            Err::<(), _>(AppError::NotFound("x".into()))
        }));
        assert!(matches!(e, Err(AppError::NotFound(_))));
    }

    #[test]
    fn read_json_corrupt_returns_config_corrupt() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("bad.json");
        atomic_write(&target, b"{not valid json").unwrap();
        let err = read_json::<Sample>(&target).unwrap_err();
        assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
    }
}
