//! Tags IPC commands — see architecture.md §7.6.
//!
//! Tags are sourced from front-matter `tags: [...]` in any Markdown file
//! under the vault (both `notes/` and `journal/` are scanned).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::domain::{AppError, NoteMeta, TagCount};
use crate::services::config;
use crate::services::notes;

// ── tags_list ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn tags_list() -> Result<Vec<TagCount>, AppError> {
    let vault_root = config::current_vault_root()?;
    tags_list_impl(&vault_root)
}

fn tags_list_impl(vault_root: &Path) -> Result<Vec<TagCount>, AppError> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    for path in collect_taggable_files(vault_root)? {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let (fm, _) = notes::parse_front_matter(&content);
        for tag in fm.tags {
            *counts.entry(tag).or_insert(0) += 1;
        }
    }
    let mut out: Vec<TagCount> = counts
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect();
    // Most-used first; alphabetical tiebreaker for stable output.
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
    Ok(out)
}

// ── tags_notes ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn tags_notes(tag: String) -> Result<Vec<NoteMeta>, AppError> {
    let vault_root = config::current_vault_root()?;
    tags_notes_impl(&vault_root, &tag)
}

fn tags_notes_impl(vault_root: &Path, tag: &str) -> Result<Vec<NoteMeta>, AppError> {
    let mut metas: Vec<NoteMeta> = Vec::new();
    for path in collect_taggable_files(vault_root)? {
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let (fm, _) = notes::parse_front_matter(&content);
        if !fm.tags.iter().any(|t| t == tag) {
            continue;
        }
        if let Ok(meta) = notes::read_note_meta(vault_root, &path) {
            metas.push(meta);
        }
    }
    metas.sort_by_key(|m| std::cmp::Reverse(m.mtime));
    Ok(metas)
}

// ── helpers ──────────────────────────────────────────────────────────────

/// Every Markdown file the user might have tagged: `notes/` and `journal/`.
fn collect_taggable_files(vault_root: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut files = notes::collect_md_files(&vault_root.join("notes"))?;
    files.extend(notes::collect_md_files(&vault_root.join("journal"))?);
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::fs as fsx;
    use tempfile::tempdir;

    #[test]
    fn tags_list_returns_empty_for_empty_vault() {
        let v = tempdir().unwrap();
        assert!(tags_list_impl(v.path()).unwrap().is_empty());
    }

    #[test]
    fn tags_list_returns_empty_when_no_notes_have_tags() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"# A\nbody").unwrap();
        fsx::atomic_write(
            &v.path().join("notes/b.md"),
            b"---\ntitle: \"B\"\n---\nbody",
        )
        .unwrap();
        assert!(tags_list_impl(v.path()).unwrap().is_empty());
    }

    #[test]
    fn tags_list_aggregates_counts_sorted_desc_with_alphabetical_tiebreak() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("notes/a.md"),
            b"---\ntags: [work, idea]\n---\n",
        )
        .unwrap();
        fsx::atomic_write(&v.path().join("notes/b.md"), b"---\ntags: [work]\n---\n").unwrap();
        fsx::atomic_write(
            &v.path().join("notes/c.md"),
            b"---\ntags: [home, work]\n---\n",
        )
        .unwrap();
        let list = tags_list_impl(v.path()).unwrap();
        let labels: Vec<_> = list.iter().map(|t| (t.tag.as_str(), t.count)).collect();
        assert_eq!(labels, vec![("work", 3), ("home", 1), ("idea", 1)]);
    }

    #[test]
    fn tags_list_includes_journal_entries() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"---\ntags: [thought]\n---\n").unwrap();
        fsx::atomic_write(
            &v.path().join("journal/2026/05/2026-05-09.md"),
            b"---\ntags: [thought, daily]\n---\n",
        )
        .unwrap();
        let list = tags_list_impl(v.path()).unwrap();
        let by_tag: HashMap<_, _> = list.iter().map(|t| (t.tag.as_str(), t.count)).collect();
        assert_eq!(by_tag.get("thought"), Some(&2));
        assert_eq!(by_tag.get("daily"), Some(&1));
    }

    #[test]
    fn tags_notes_returns_empty_for_missing_tag() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"---\ntags: [work]\n---\n").unwrap();
        let list = tags_notes_impl(v.path(), "missing").unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn tags_notes_filters_by_tag_and_includes_journal_entries() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join("notes/a.md"),
            b"---\ntitle: \"Note A\"\ntags: [work, idea]\n---\nbody",
        )
        .unwrap();
        fsx::atomic_write(
            &v.path().join("notes/b.md"),
            b"---\ntitle: \"Note B\"\ntags: [home]\n---\nbody",
        )
        .unwrap();
        fsx::atomic_write(
            &v.path().join("journal/2026/05/2026-05-09.md"),
            b"---\ntitle: \"Day\"\ntags: [work]\n---\nbody",
        )
        .unwrap();
        let list = tags_notes_impl(v.path(), "work").unwrap();
        let titles: Vec<&str> = list.iter().map(|m| m.title.as_str()).collect();
        assert_eq!(titles.len(), 2);
        assert!(titles.contains(&"Note A"));
        assert!(titles.contains(&"Day"));
    }

    #[test]
    fn tags_notes_orders_newest_first() {
        let v = tempdir().unwrap();
        use std::time::{Duration, SystemTime};
        let now = SystemTime::now();
        fsx::atomic_write(
            &v.path().join("notes/old.md"),
            b"---\ntitle: \"Old\"\ntags: [work]\n---\n",
        )
        .unwrap();
        std::fs::File::open(v.path().join("notes/old.md"))
            .unwrap()
            .set_modified(now - Duration::from_secs(60))
            .unwrap();
        fsx::atomic_write(
            &v.path().join("notes/new.md"),
            b"---\ntitle: \"New\"\ntags: [work]\n---\n",
        )
        .unwrap();
        std::fs::File::open(v.path().join("notes/new.md"))
            .unwrap()
            .set_modified(now)
            .unwrap();

        let list = tags_notes_impl(v.path(), "work").unwrap();
        assert_eq!(list[0].title, "New");
        assert_eq!(list[1].title, "Old");
    }

    #[test]
    fn tags_camel_case_serialization() {
        let t = TagCount {
            tag: "work".into(),
            count: 3,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains("\"tag\":\"work\""));
        assert!(json.contains("\"count\":3"));
    }
}
