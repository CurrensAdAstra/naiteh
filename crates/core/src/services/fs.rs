//! Filesystem service.
//!
//! Every disk write in naiteh must go through [`atomic_write`] (see
//! architecture.md §9). The implementation writes to a sibling temp file,
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
    fn read_json_corrupt_returns_config_corrupt() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("bad.json");
        atomic_write(&target, b"{not valid json").unwrap();
        let err = read_json::<Sample>(&target).unwrap_err();
        assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
    }
}
