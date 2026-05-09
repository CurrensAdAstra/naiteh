//! Search IPC command — see architecture.md §7.6.
//!
//! v1 is a naive case-insensitive substring scan over every Markdown file in
//! `notes/` and `journal/`. Architecture.md §10 reserves a ripgrep-backed
//! implementation for later.

use std::path::Path;

use crate::domain::{AppError, SearchHit};
use crate::services::config;
use crate::services::notes;

const EXCERPT_MAX_CHARS: usize = 200;

#[tauri::command]
pub fn search_text(query: String, limit: u32) -> Result<Vec<SearchHit>, AppError> {
    let vault_root = config::current_vault_root()?;
    search_text_impl(&vault_root, &query, limit)
}

fn search_text_impl(
    vault_root: &Path,
    query: &str,
    limit: u32,
) -> Result<Vec<SearchHit>, AppError> {
    let needle = query.trim();
    if needle.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }
    let needle_lower = needle.to_lowercase();
    let cap = limit as usize;

    let mut paths = notes::collect_md_files(&vault_root.join("notes"))?;
    paths.extend(notes::collect_md_files(&vault_root.join("journal"))?);
    paths.sort();

    let mut hits: Vec<SearchHit> = Vec::new();
    'files: for path in paths {
        if hits.len() >= cap {
            break;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !content.to_lowercase().contains(&needle_lower) {
            continue;
        }
        let title = compute_title(&content, &path);
        let rel_path = path
            .strip_prefix(vault_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        for (idx, line) in content.lines().enumerate() {
            if !line.to_lowercase().contains(&needle_lower) {
                continue;
            }
            hits.push(SearchHit {
                rel_path: rel_path.clone(),
                title: title.clone(),
                line: (idx + 1) as u32,
                excerpt: truncate_excerpt(line),
            });
            if hits.len() >= cap {
                break 'files;
            }
        }
    }
    Ok(hits)
}

fn compute_title(content: &str, path: &Path) -> String {
    let (fm, body) = notes::parse_front_matter(content);
    fm.title
        .or_else(|| notes::first_h1(body))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        })
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
