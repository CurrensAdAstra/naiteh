//! Process-wide "recent own changes" registry.
//!
//! The vault watcher (`services::watcher`) sees every change under the
//! vault root, including the ones naiteh itself just made. So the
//! frontend can tell an external edit (Google Drive, another editor) from
//! the echo of its own save, every path `services::fs` writes, renames
//! or removes is recorded here, and the watcher tags a change `own: true`
//! when its path was recorded within [`TTL`]. See
//! vault/wiki/concurrency-safety.md ("External change detection").
//!
//! Lock-light by design: one `std::sync::Mutex` around a small map, held
//! for a hash lookup; never the vault lock. Entries older than the TTL
//! are pruned on every call, so the map stays bounded by the number of
//! paths touched in the last few seconds.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::services::notes::canonicalize_lenient;

/// How long after naiteh touches a path a watcher event for it still
/// counts as naiteh's own. Debounced batches arrive ~0.4 s after the
/// write, so 3 s leaves ample slack for a busy disk or a slow Drive
/// mirror.
pub const TTL: Duration = Duration::from_secs(3);

fn registry() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static REG: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Comparison key for a path: the canonical form of its deepest existing
/// ancestor plus the non-existent tail (so a path can be recorded before
/// it is created or after it is removed), case-folded on Windows (whose
/// watcher may spell a name differently from the writer).
pub fn key_for(path: &Path) -> PathBuf {
    let canon = canonicalize_lenient(path).unwrap_or_else(|| path.to_path_buf());
    if cfg!(windows) {
        PathBuf::from(canon.to_string_lossy().to_lowercase())
    } else {
        canon
    }
}

/// Remember that naiteh is about to touch / has just touched `path`.
pub fn record(path: &Path) {
    record_at(path, Instant::now());
}

pub fn record_at(path: &Path, now: Instant) {
    let key = key_for(path);
    let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
    prune(&mut map, now);
    map.insert(key, now);
}

/// True when `path` was recorded within [`TTL`]. Does not consume the
/// record: one save can surface as several watcher events (create,
/// modify, rename) spread over more than one batch.
pub fn is_own(path: &Path) -> bool {
    is_own_at(path, Instant::now())
}

pub fn is_own_at(path: &Path, now: Instant) -> bool {
    let key = key_for(path);
    let mut map = registry().lock().unwrap_or_else(|p| p.into_inner());
    prune(&mut map, now);
    map.contains_key(&key)
}

fn prune(map: &mut HashMap<PathBuf, Instant>, now: Instant) {
    map.retain(|_, t| now.saturating_duration_since(*t) < TTL);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn recorded_path_is_own_until_ttl_expires() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("note.md");
        std::fs::write(&p, b"x").unwrap();
        let t0 = Instant::now();
        record_at(&p, t0);
        assert!(is_own_at(&p, t0));
        assert!(is_own_at(&p, t0 + TTL - Duration::from_millis(1)));
        assert!(!is_own_at(&p, t0 + TTL));
        // Expired entries are gone for good.
        assert!(!is_own_at(&p, t0));
    }

    #[test]
    fn unrecorded_path_is_not_own() {
        let dir = tempdir().unwrap();
        assert!(!is_own(&dir.path().join("other.md")));
    }

    #[test]
    fn key_survives_removal_and_spelling_differences() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("sub").join("gone.md");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        let before = key_for(&p);
        std::fs::remove_file(&p).unwrap();
        assert_eq!(
            before,
            key_for(&p),
            "key must not change when the file goes away"
        );
        // A path through the canonical root spells the same key.
        let via_canon = dir
            .path()
            .canonicalize()
            .unwrap()
            .join("sub")
            .join("gone.md");
        assert_eq!(before, key_for(&via_canon));
        if cfg!(windows) {
            let upper = dir.path().join("SUB").join("GONE.MD");
            assert_eq!(before, key_for(&upper));
        }
    }
}
