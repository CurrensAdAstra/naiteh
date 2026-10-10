//! In-memory tag index, populated on demand and invalidated by writes.
//!
//! vault/wiki/vault-and-data.md reserves `.naiteh/tags.json` for a
//! future on-disk tag cache. Before this module nothing populated it, so
//! every `tags_list` / `tags_notes` call re-scanned every Markdown file in
//! the vault. On a 1000-note vault this turned every tab click into an
//! O(N) disk fan-out.
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
//! next read rebuilds the snapshot lazily.
//!
//! Rebuilds run **without** the vault lock (reads never take it), so a
//! write + invalidate can land while a rebuild is scanning. To stop the
//! rebuild from then installing its now-stale snapshot, each vault slot
//! carries a generation counter: `invalidate` bumps it, and a rebuild
//! only installs its snapshot if the generation it started from is
//! still current. Otherwise it rescans (a few times) and, if writes keep
//! racing, serves its result uncached.
//!
//! `TagIndex` is a cheap `Clone` handle (shared `Arc` inside) so async
//! commands can move it into a `spawn_blocking` closure.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use crate::domain::{AppError, NoteMeta};
use crate::services::notes;

/// How many times `get_or_build` rescans when invalidations keep racing
/// its build before giving up on caching.
const MAX_BUILD_ATTEMPTS: usize = 3;

#[derive(Default, Clone)]
pub struct TagIndex {
    inner: Arc<StdMutex<HashMap<PathBuf, Slot>>>,
}

#[derive(Default)]
struct Slot {
    /// Bumped by every `invalidate`.
    generation: u64,
    snapshot: Option<Arc<TagSnapshot>>,
}

#[derive(Debug, Clone, Default)]
pub struct TagSnapshot {
    /// One entry per taggable file (under `notes/` or `journal/`),
    /// computed once at build time. Backs `tags_*` **and** the
    /// timeline/activity commands (`services::timeline`), so neither
    /// re-reads the vault per call.
    pub notes: Vec<IndexedDoc>,
}

/// A cached document: its full `NoteMeta` plus a body snippet, both
/// derived from a single read at build time.
#[derive(Debug, Clone)]
pub struct IndexedDoc {
    pub meta: NoteMeta,
    pub snippet: String,
}

impl TagIndex {
    /// Returns the cached snapshot, building it from disk if missing.
    /// The returned `Arc` lets callers iterate without holding the
    /// outer map lock.
    pub fn get_or_build(&self, vault_root: &Path) -> Result<Arc<TagSnapshot>, AppError> {
        self.get_or_build_with(vault_root, build)
    }

    /// `get_or_build` with an injectable builder so tests can simulate a
    /// write racing the scan.
    fn get_or_build_with(
        &self,
        vault_root: &Path,
        mut build_fn: impl FnMut(&Path) -> Result<TagSnapshot, AppError>,
    ) -> Result<Arc<TagSnapshot>, AppError> {
        let key = canonical_or_owned(vault_root);
        let mut last_build: Option<Arc<TagSnapshot>> = None;
        for _ in 0..MAX_BUILD_ATTEMPTS {
            let started_at = {
                let mut map = self.lock_map();
                let slot = map.entry(key.clone()).or_default();
                if let Some(snap) = &slot.snapshot {
                    return Ok(snap.clone());
                }
                slot.generation
            };
            // Build outside the map lock — file IO is slow and we don't
            // want to block other vaults' reads.
            let snap = Arc::new(build_fn(vault_root)?);
            let mut map = self.lock_map();
            let slot = map.entry(key.clone()).or_default();
            if slot.generation == started_at {
                // No invalidation since we started scanning, so our
                // snapshot is current. Another reader may have installed
                // an equally current one meanwhile; share theirs.
                return Ok(slot.snapshot.get_or_insert(snap).clone());
            }
            // A write landed mid-scan: our snapshot may predate it.
            // Never install it; rescan.
            last_build = Some(snap);
        }
        // Writes kept racing every attempt. Serve the freshest scan
        // without caching it; the next read will try again.
        Ok(last_build.expect("MAX_BUILD_ATTEMPTS > 0"))
    }

    /// Drop the cached snapshot for `vault_root` and bump its
    /// generation so any in-flight rebuild won't install a stale scan.
    /// Called from every write IPC after the mutation completes.
    pub fn invalidate(&self, vault_root: &Path) {
        let key = canonical_or_owned(vault_root);
        let mut map = self.lock_map();
        let slot = map.entry(key).or_default();
        slot.generation = slot.generation.wrapping_add(1);
        slot.snapshot = None;
    }

    fn lock_map(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Slot>> {
        // A panic while holding this lock can only leave a slot
        // half-updated in a way that is still valid (worst case a
        // missing snapshot), so recover from poisoning.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn build(vault_root: &Path) -> Result<TagSnapshot, AppError> {
    let mut notes_out: Vec<IndexedDoc> = Vec::new();
    for path in collect_taggable_files(vault_root)? {
        // One read per file; reused for both the meta and the snippet.
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        if let Ok(meta) = notes::note_meta_from_content(vault_root, &path, &content) {
            let (_, body) = notes::parse_front_matter(&content);
            let snippet = notes::make_snippet(body);
            notes_out.push(IndexedDoc { meta, snippet });
        }
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
        fsx::atomic_write(&v.path().join("notes/c.md"), b"---\ntags: [new]\n---\nbody").unwrap();
        idx.invalidate(v.path());

        let after = idx.get_or_build(v.path()).unwrap();
        assert_eq!(after.notes.len(), 4);
        assert!(!Arc::ptr_eq(&initial, &after));
    }

    #[test]
    fn different_vaults_get_independent_snapshots() {
        let v1 = vault_with_tags();
        let v2 = tempdir().unwrap();
        fsx::atomic_write(&v2.path().join("notes/x.md"), b"---\ntags: [other]\n---\n").unwrap();

        let idx = TagIndex::default();
        let s1 = idx.get_or_build(v1.path()).unwrap();
        let s2 = idx.get_or_build(v2.path()).unwrap();
        assert!(!Arc::ptr_eq(&s1, &s2));
        assert_eq!(s2.notes.len(), 1);
    }

    #[test]
    fn invalidate_during_rebuild_does_not_install_stale_snapshot() {
        let v = vault_with_tags();
        let idx = TagIndex::default();
        let mut calls = 0;
        let snap = idx
            .get_or_build_with(v.path(), |root| {
                calls += 1;
                let scanned = build(root);
                if calls == 1 {
                    // Simulate a concurrent notes_write that lands after
                    // our scan read the disk but before we install.
                    fsx::atomic_write(&root.join("notes/late.md"), b"---\ntags: [late]\n---\n")
                        .unwrap();
                    idx.invalidate(root);
                }
                scanned
            })
            .unwrap();
        assert_eq!(calls, 2, "stale first scan must trigger a rescan");
        assert_eq!(snap.notes.len(), 4, "returned snapshot includes the write");
        let cached = idx.get_or_build(v.path()).unwrap();
        assert!(Arc::ptr_eq(&snap, &cached), "fresh rescan is cached");
    }

    #[test]
    fn persistent_racing_writes_serve_uncached_result() {
        let v = vault_with_tags();
        let idx = TagIndex::default();
        let mut calls = 0;
        let snap = idx
            .get_or_build_with(v.path(), |root| {
                calls += 1;
                idx.invalidate(root);
                build(root)
            })
            .unwrap();
        assert_eq!(calls, MAX_BUILD_ATTEMPTS);
        assert_eq!(snap.notes.len(), 3);
        // Nothing was cached, so the next read rebuilds.
        let next = idx.get_or_build(v.path()).unwrap();
        assert!(!Arc::ptr_eq(&snap, &next));
    }

    #[test]
    fn clones_share_the_same_cache() {
        let v = vault_with_tags();
        let idx = TagIndex::default();
        let handle = idx.clone();
        let a = idx.get_or_build(v.path()).unwrap();
        let b = handle.get_or_build(v.path()).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        handle.invalidate(v.path());
        let c = idx.get_or_build(v.path()).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
    }

    #[test]
    fn missing_notes_and_journal_dirs_return_empty_not_error() {
        let v = tempdir().unwrap();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        assert!(snap.notes.is_empty());
    }
}
