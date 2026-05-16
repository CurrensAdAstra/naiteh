//! In-memory tag index, populated on demand and invalidated by writes.
//!
//! architecture.md §4.3 lists `.naiteh/tags.json` as a "rebuildable
//! cache". Until now nothing populated it, so every `tags_list` /
//! `tags_notes` call re-scanned every Markdown file in the vault. On a
//! 1000-note vault this turned every tab click into an O(N) disk
//! fan-out.
//!
//! This module is the cheap version of that promise: an in-process
//! per-vault `TagSnapshot` (one frontmatter parse per note, kept in
//! memory) that the tags IPC commands read from. The on-disk
//! `tags.json` form can be added later as a separate persistence layer
//! without touching consumers.
//!
//! ## Invalidation contract
//!
//! Every IPC command that mutates files inside the vault MUST call
//! `TagIndex::invalidate(&vault_root)` after the write succeeds. The
//! next read rebuilds the snapshot lazily. The vault-lock guarantee
//! from `services::vault_lock` means writes and invalidations are
//! serialized with reads-that-rebuild, so there's no torn cache.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use crate::domain::AppError;
use crate::services::notes;

#[derive(Default)]
pub struct TagIndex {
    inner: StdMutex<HashMap<PathBuf, Arc<TagSnapshot>>>,
}

#[derive(Debug, Clone, Default)]
pub struct TagSnapshot {
    pub notes: Vec<IndexedNote>,
}

#[derive(Debug, Clone)]
pub struct IndexedNote {
    pub abs_path: PathBuf,
    pub tags: Vec<String>,
}

impl TagIndex {
    /// Returns the cached snapshot, building it from disk if missing.
    /// The returned `Arc` lets callers iterate without holding the
    /// outer map lock.
    pub fn get_or_build(
        &self,
        vault_root: &Path,
    ) -> Result<Arc<TagSnapshot>, AppError> {
        let key = canonical_or_owned(vault_root);
        {
            let map = self.inner.lock().expect("tag-index map poisoned");
            if let Some(snap) = map.get(&key) {
                return Ok(snap.clone());
            }
        }
        // Build outside the map lock — file IO is slow and we don't
        // want to block other vaults' reads.
        let snap = Arc::new(build(vault_root)?);
        let mut map = self.inner.lock().expect("tag-index map poisoned");
        // Double-check: another caller may have built it while we were
        // scanning. Their result is equally valid; keep whichever is
        // already there to maximise sharing.
        Ok(map.entry(key).or_insert(snap).clone())
    }

    /// Drop the cached snapshot for `vault_root`. Called from every
    /// write IPC after the lock'd mutation completes.
    pub fn invalidate(&self, vault_root: &Path) {
        let key = canonical_or_owned(vault_root);
        self.inner
            .lock()
            .expect("tag-index map poisoned")
            .remove(&key);
    }
}

fn build(vault_root: &Path) -> Result<TagSnapshot, AppError> {
    let mut notes_out: Vec<IndexedNote> = Vec::new();
    for path in collect_taggable_files(vault_root)? {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let (fm, _) = notes::parse_front_matter(&content);
        notes_out.push(IndexedNote {
            abs_path: path,
            tags: fm.tags,
        });
    }
    Ok(TagSnapshot { notes: notes_out })
}

fn collect_taggable_files(vault_root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut files = notes::collect_md_files(&vault_root.join("notes"))?;
    files.extend(notes::collect_md_files(&vault_root.join("journal"))?);
    Ok(files)
}

fn canonical_or_owned(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::fs as fsx;
    use tempfile::tempdir;

    fn vault_with_tags() -> tempfile::TempDir {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("notes/a.md"),
            b"---\ntags: [work, idea]\n---\nbody",
        )
        .unwrap();
        fsx::atomic_write(
            &v.path().join("notes/b.md"),
            b"---\ntags: [work]\n---\nbody",
        )
        .unwrap();
        fsx::atomic_write(
            &v.path().join("journal/2026/05/2026-05-09.md"),
            b"---\ntags: [work, daily]\n---\nbody",
        )
        .unwrap();
        v
    }

    #[test]
    fn get_or_build_returns_one_indexed_entry_per_taggable_file() {
        let v = vault_with_tags();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        assert_eq!(snap.notes.len(), 3);
    }

    #[test]
    fn subsequent_calls_return_the_same_arc() {
        let v = vault_with_tags();
        let idx = TagIndex::default();
        let a = idx.get_or_build(v.path()).unwrap();
        let b = idx.get_or_build(v.path()).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "expected cache hit");
    }

    #[test]
    fn invalidate_forces_a_rebuild_on_next_read() {
        let v = vault_with_tags();
        let idx = TagIndex::default();
        let initial = idx.get_or_build(v.path()).unwrap();
        assert_eq!(initial.notes.len(), 3);

        // Add a new tagged file then invalidate.
        fsx::atomic_write(
            &v.path().join("notes/c.md"),
            b"---\ntags: [new]\n---\nbody",
        )
        .unwrap();
        idx.invalidate(v.path());

        let after = idx.get_or_build(v.path()).unwrap();
        assert_eq!(after.notes.len(), 4);
        assert!(!Arc::ptr_eq(&initial, &after));
    }

    #[test]
    fn different_vaults_get_independent_snapshots() {
        let v1 = vault_with_tags();
        let v2 = tempdir().unwrap();
        fsx::atomic_write(
            &v2.path().join("notes/x.md"),
            b"---\ntags: [other]\n---\n",
        )
        .unwrap();

        let idx = TagIndex::default();
        let s1 = idx.get_or_build(v1.path()).unwrap();
        let s2 = idx.get_or_build(v2.path()).unwrap();
        assert!(!Arc::ptr_eq(&s1, &s2));
        assert_eq!(s2.notes.len(), 1);
    }

    #[test]
    fn missing_notes_and_journal_dirs_return_empty_not_error() {
        let v = tempdir().unwrap();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        assert!(snap.notes.is_empty());
    }
}
