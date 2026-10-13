//! Search IPC command — see vault/wiki/ipc-api.md ("Search & Tags").
//!
//! v1 is a naive case-insensitive substring scan over every Markdown file in
//! `notes/` and `journal/`. The architecture.md roadmap (v1.5, "Improved
//! search") reserves an indexed / ripgrep-backed implementation for later.
//!
//! The file list and each document's title come from the in-memory index
//! (`services::index`, invalidated by every write) instead of re-walking
//! the vault and re-deriving metadata per call; only file *contents* are
//! read here, through the in-memory content cache
//! (`services::index::ContentCache`, keyed by path + mtime + size), so a
//! repeat search re-reads only changed files. The command is async and does its I/O on the blocking pool
//! so a large vault never freezes the UI thread.

use std::path::PathBuf;

use crate::domain::{AppError, SearchHit};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::index::{ContentCache, TagIndex, TagSnapshot};
use crate::services::session::{require_session, ActiveSession};

const EXCERPT_MAX_CHARS: usize = 200;

#[tauri::command]
pub async fn search_text(
    active: tauri::State<'_, ActiveSession>,
    index: tauri::State<'_, TagIndex>,
    query: String,
    limit: u32,
) -> Result<Vec<SearchHit>, AppError> {
    require_session(&active)?;
    let needle = query.trim().to_string();
    if needle.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let index = index.inner().clone();
    fsx::run_blocking(move || {
        let vault_root = config::current_vault_root()?;
        let snap = index.get_or_build(&vault_root)?;
        Ok(index.with_contents(&vault_root, |cache| {
            search_snapshot(&snap, cache, &needle, limit)
        }))
    })
    .await
}

#[cfg(test)]
fn search_text_impl(
    vault_root: &std::path::Path,
    query: &str,
    limit: u32,
) -> Result<Vec<SearchHit>, AppError> {
    let snap = TagIndex::default().get_or_build(vault_root)?;
    Ok(search_snapshot(
        &snap,
        &mut ContentCache::default(),
        query,
        limit,
    ))
}

/// Scan the documents listed in `snap` for `query` (case-insensitive),
/// returning one hit per matching line, capped at `limit`. Documents are
/// visited in `rel_path` order for stable output. Contents come from
/// `cache`, which is pruned to the snapshot's files afterwards.
fn search_snapshot(
    snap: &TagSnapshot,
    cache: &mut ContentCache,
    query: &str,
    limit: u32,
) -> Vec<SearchHit> {
    let hits = scan(snap, cache, query, limit);
    let live: std::collections::HashSet<&str> = snap
        .notes
        .iter()
        .map(|d| d.meta.rel_path.as_str())
        .collect();
    cache.retain(|rel| live.contains(rel));
    hits
}

fn scan(snap: &TagSnapshot, cache: &mut ContentCache, query: &str, limit: u32) -> Vec<SearchHit> {
    let needle = query.trim();
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }
    let needle_lower = needle.to_lowercase();
    let cap = limit as usize;

    let mut docs: Vec<_> = snap.notes.iter().collect();
    docs.sort_by(|a, b| a.meta.rel_path.cmp(&b.meta.rel_path));

    let mut hits: Vec<SearchHit> = Vec::new();
    'files: for doc in docs {
        if hits.len() >= cap {
            break;
        }
        // A file deleted outside the app since the index was built is
        // simply skipped.
        let Some(cached) = cache.get(&doc.meta.rel_path, &PathBuf::from(&doc.meta.path)) else {
            continue;
        };
        if !cached.lower.contains(&needle_lower) {
            continue;
        }
        // Lowercasing never adds or removes a line break, so the
        // lowercased lines pair up with the original ones.
        for (idx, (line, lower)) in cached.text.lines().zip(cached.lower.lines()).enumerate() {
            if !lower.contains(&needle_lower) {
                continue;
            }
            hits.push(SearchHit {
                rel_path: doc.meta.rel_path.clone(),
                title: doc.meta.title.clone(),
                line: (idx + 1) as u32,
                excerpt: truncate_excerpt(line),
            });
            if hits.len() >= cap {
                break 'files;
            }
        }
    }
    hits
}

fn truncate_excerpt(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= EXCERPT_MAX_CHARS {
        trimmed.to_string()
    } else {
        let head: String = trimmed.chars().take(EXCERPT_MAX_CHARS).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::fs as fsx;
    use tempfile::tempdir;

    #[test]
    fn empty_query_returns_no_hits() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"hello world").unwrap();
        let hits = search_text_impl(v.path(), "", 50).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn whitespace_only_query_returns_no_hits() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"hello world").unwrap();
        let hits = search_text_impl(v.path(), "   ", 50).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn limit_zero_returns_no_hits() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"hello world").unwrap();
        let hits = search_text_impl(v.path(), "hello", 0).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn returns_one_hit_per_matching_line() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("notes/a.md"),
            b"first line\nhello world\nfiller\nhello again\n",
        )
        .unwrap();
        let hits = search_text_impl(v.path(), "hello", 50).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].excerpt, "hello world");
        assert_eq!(hits[1].line, 4);
        assert_eq!(hits[1].excerpt, "hello again");
    }

    #[test]
    fn match_is_case_insensitive() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"Hello World").unwrap();
        let hits = search_text_impl(v.path(), "hello", 50).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn respects_limit_across_files() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"alpha\nalpha\nalpha\n").unwrap();
        fsx::atomic_write(&v.path().join("notes/b.md"), b"alpha\nalpha\n").unwrap();
        let hits = search_text_impl(v.path(), "alpha", 4).unwrap();
        assert_eq!(hits.len(), 4);
    }

    #[test]
    fn includes_journal_entries() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("journal/2026/05/2026-05-09.md"),
            b"# Day\nbeta inside",
        )
        .unwrap();
        let hits = search_text_impl(v.path(), "beta", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].rel_path.starts_with("journal/"));
    }

    #[test]
    fn title_falls_back_through_fm_h1_then_filename() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("notes/fm.md"),
            b"---\ntitle: \"From FM\"\n---\nneedle here",
        )
        .unwrap();
        fsx::atomic_write(
            &v.path().join("notes/h1.md"),
            b"# From Heading\nneedle line",
        )
        .unwrap();
        fsx::atomic_write(&v.path().join("notes/raw.md"), b"plain needle").unwrap();
        let hits = search_text_impl(v.path(), "needle", 50).unwrap();
        let titles: Vec<_> = hits.iter().map(|h| h.title.as_str()).collect();
        assert!(titles.contains(&"From FM"));
        assert!(titles.contains(&"From Heading"));
        assert!(titles.contains(&"raw"));
    }

    #[test]
    fn excerpt_trims_and_truncates_long_lines() {
        let v = tempdir().unwrap();
        let long_line: String = "x ".repeat(150) + "needle";
        fsx::atomic_write(&v.path().join("notes/long.md"), long_line.as_bytes()).unwrap();
        let hits = search_text_impl(v.path(), "needle", 50).unwrap();
        assert_eq!(hits.len(), 1);
        let excerpt_len = hits[0].excerpt.chars().count();
        assert!(excerpt_len <= EXCERPT_MAX_CHARS + 1);
        assert!(hits[0].excerpt.ends_with('…'));
    }

    #[test]
    fn rel_paths_use_forward_slashes() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/sub/a.md"), b"needle").unwrap();
        let hits = search_text_impl(v.path(), "needle", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "notes/sub/a.md");
    }

    #[test]
    fn uses_cached_index_snapshot_and_refreshes_after_invalidate() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"needle one").unwrap();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        assert_eq!(
            search_snapshot(&snap, &mut ContentCache::default(), "needle", 50).len(),
            1
        );

        // A new file isn't visible until the index is invalidated (every
        // write IPC does that) — proof that search no longer re-walks.
        fsx::atomic_write(&v.path().join("notes/b.md"), b"needle two").unwrap();
        let snap = idx.get_or_build(v.path()).unwrap();
        assert_eq!(
            search_snapshot(&snap, &mut ContentCache::default(), "needle", 50).len(),
            1
        );
        idx.invalidate(v.path());
        let snap = idx.get_or_build(v.path()).unwrap();
        assert_eq!(
            search_snapshot(&snap, &mut ContentCache::default(), "needle", 50).len(),
            2
        );
    }

    #[test]
    fn content_edits_are_seen_without_reindexing() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"old text").unwrap();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"new needle").unwrap();
        // Contents are always read fresh; only the file list is cached.
        assert_eq!(
            search_snapshot(&snap, &mut ContentCache::default(), "needle", 50).len(),
            1
        );
    }

    #[test]
    fn deleted_file_in_snapshot_is_skipped() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"needle").unwrap();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        std::fs::remove_file(v.path().join("notes/a.md")).unwrap();
        assert!(search_snapshot(&snap, &mut ContentCache::default(), "needle", 50).is_empty());
    }

    /// The pre-cache implementation, kept to prove equivalence.
    fn search_uncached(snap: &TagSnapshot, query: &str, limit: u32) -> Vec<SearchHit> {
        let needle = query.trim();
        if needle.is_empty() || limit == 0 {
            return Vec::new();
        }
        let needle_lower = needle.to_lowercase();
        let cap = limit as usize;
        let mut docs: Vec<_> = snap.notes.iter().collect();
        docs.sort_by(|a, b| a.meta.rel_path.cmp(&b.meta.rel_path));
        let mut hits = Vec::new();
        'files: for doc in docs {
            if hits.len() >= cap {
                break;
            }
            let Ok(content) = std::fs::read_to_string(PathBuf::from(&doc.meta.path)) else {
                continue;
            };
            if !content.to_lowercase().contains(&needle_lower) {
                continue;
            }
            for (idx, line) in content.lines().enumerate() {
                if !line.to_lowercase().contains(&needle_lower) {
                    continue;
                }
                hits.push(SearchHit {
                    rel_path: doc.meta.rel_path.clone(),
                    title: doc.meta.title.clone(),
                    line: (idx + 1) as u32,
                    excerpt: truncate_excerpt(line),
                });
                if hits.len() >= cap {
                    break 'files;
                }
            }
        }
        hits
    }

    fn same(a: &[SearchHit], b: &[SearchHit]) -> bool {
        a.len() == b.len()
            && a.iter().zip(b).all(|(x, y)| {
                x.rel_path == y.rel_path
                    && x.title == y.title
                    && x.line == y.line
                    && x.excerpt == y.excerpt
            })
    }

    #[test]
    fn cached_search_equals_uncached_search() {
        let v = tempdir().unwrap();
        let long_line: String = "x ".repeat(150) + "Needle";
        let files: &[(&str, &str)] = &[
            (
                "notes/a.md",
                "first line\nhello world\nfiller\nHELLO again\n",
            ),
            (
                "notes/b.md",
                "---\ntitle: \"From FM\"\ntags:\n  - needle\n---\nneedle here",
            ),
            (
                "notes/c.md",
                "# Heading\r\nCRLF needle line\r\nİstanbul ΣΊΣΥΦΟΣ\r\n",
            ),
            ("notes/sub/d.md", &long_line),
            ("journal/2026/05/2026-05-09.md", "# Day\nbeta hello needle"),
            ("notes/e.md", "alpha\nalpha\nalpha\n"),
        ];
        for (rel, body) in files {
            fsx::atomic_write(&v.path().join(rel), body.as_bytes()).unwrap();
        }
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        let mut cache = ContentCache::default();
        for q in [
            "hello",
            "needle",
            "NEEDLE",
            "alpha",
            "istanbul",
            "σίσυφος",
            "x x",
            "beta",
            "zzz",
        ] {
            for limit in [0, 1, 2, 4, 50] {
                // Twice: cold, then fully cached.
                for _ in 0..2 {
                    let cached = search_snapshot(&snap, &mut cache, q, limit);
                    assert!(
                        same(&cached, &search_uncached(&snap, q, limit)),
                        "{q} {limit}"
                    );
                }
            }
        }
        assert_eq!(cache.reads(), files.len() as u64, "each file read once");
    }

    #[test]
    fn cache_rereads_changed_files_and_prunes_deleted_ones() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"needle one").unwrap();
        fsx::atomic_write(&v.path().join("notes/b.md"), b"needle two").unwrap();
        let idx = TagIndex::default();
        let snap = idx.get_or_build(v.path()).unwrap();
        let mut cache = ContentCache::default();
        assert_eq!(search_snapshot(&snap, &mut cache, "needle", 50).len(), 2);
        assert_eq!(search_snapshot(&snap, &mut cache, "needle", 50).len(), 2);
        assert_eq!(cache.reads(), 2);
        fsx::atomic_write(&v.path().join("notes/a.md"), b"needle one\nneedle again").unwrap();
        assert_eq!(search_snapshot(&snap, &mut cache, "needle", 50).len(), 3);
        assert_eq!(cache.reads(), 3, "only the changed file is re-read");
        std::fs::remove_file(v.path().join("notes/b.md")).unwrap();
        idx.invalidate(v.path());
        let snap = idx.get_or_build(v.path()).unwrap();
        assert_eq!(search_snapshot(&snap, &mut cache, "needle", 50).len(), 2);
        assert_eq!(cache.len(), 1, "deleted file pruned");
    }

    #[test]
    fn block_list_tag_note_is_searchable_and_titled() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("notes/obs.md"),
            b"---\ntitle: Obsidian\ntags:\n  - projectx\n---\nbody",
        )
        .unwrap();
        let hits = search_text_impl(v.path(), "projectx", 50).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Obsidian");
    }

    #[test]
    fn camel_case_serialization() {
        let hit = SearchHit {
            rel_path: "notes/a.md".into(),
            title: "A".into(),
            line: 3,
            excerpt: "x".into(),
        };
        let json = serde_json::to_string(&hit).unwrap();
        assert!(json.contains("\"relPath\":\"notes/a.md\""));
        assert!(json.contains("\"line\":3"));
    }
}
