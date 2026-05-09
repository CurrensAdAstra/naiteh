//! Journal IPC commands — see architecture.md §7.3 / §7.4.
//!
//! Each public `*` command is a thin wrapper that resolves the active vault
//! and delegates to a `*_impl` taking the vault root explicitly so it can be
//! unit-tested against a tempdir.

use std::path::{Path, PathBuf};

use chrono::Local;

use crate::domain::{AppError, NoteMeta, TimelineItem};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::notes;

const INBOX_DIR: &str = "_inbox";

// ── quick_create ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn quick_create() -> Result<NoteMeta, AppError> {
    let vault_root = config::current_vault_root()?;
    quick_create_impl(&vault_root)
}

fn quick_create_impl(vault_root: &Path) -> Result<NoteMeta, AppError> {
    let inbox = vault_root.join("notes").join(INBOX_DIR);
    fsx::ensure_dir(&inbox)?;
    let stem = Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let target = unique_path(&inbox, &stem);
    fsx::atomic_write(&target, b"")?;
    notes::read_note_meta(vault_root, &target)
}

fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.md"));
    let mut suffix: u32 = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{suffix}.md"));
        suffix += 1;
    }
    candidate
}

// ── quick_list ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn quick_list(limit: u32) -> Result<Vec<NoteMeta>, AppError> {
    let vault_root = config::current_vault_root()?;
    quick_list_impl(&vault_root, limit)
}

fn quick_list_impl(vault_root: &Path, limit: u32) -> Result<Vec<NoteMeta>, AppError> {
    let inbox = vault_root.join("notes").join(INBOX_DIR);
    if !inbox.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries: Vec<NoteMeta> = Vec::new();
    for entry in std::fs::read_dir(&inbox)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Ok(meta) = notes::read_note_meta(vault_root, &path) {
            entries.push(meta);
        }
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.mtime));
    entries.truncate(limit as usize);
    Ok(entries)
}

// ── activity_recent ──────────────────────────────────────────────────────

#[tauri::command]
pub fn activity_recent(limit: u32) -> Result<Vec<TimelineItem>, AppError> {
    let vault_root = config::current_vault_root()?;
    activity_recent_impl(&vault_root, limit)
}

fn activity_recent_impl(vault_root: &Path, limit: u32) -> Result<Vec<TimelineItem>, AppError> {
    let mut items: Vec<TimelineItem> = Vec::new();

    for path in notes::collect_md_files(&vault_root.join("journal"))? {
        items.push(build_journal_item(&path));
    }
    for path in notes::collect_md_files(&vault_root.join("notes"))? {
        items.push(build_note_item(vault_root, &path));
    }

    items.sort_by_key(|i| std::cmp::Reverse(i.mtime()));
    items.truncate(limit as usize);
    Ok(items)
}

fn build_journal_item(abs_path: &Path) -> TimelineItem {
    let mtime = notes::mtime_secs(abs_path);
    let date = abs_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let content = std::fs::read_to_string(abs_path).unwrap_or_default();
    let (fm, body) = notes::parse_front_matter(&content);
    let title = fm
        .title
        .or_else(|| notes::first_h1(body))
        .unwrap_or_else(|| date.clone());
    TimelineItem::JournalEntry {
        date,
        path: abs_path.to_string_lossy().to_string(),
        mtime,
        title,
        snippet: notes::make_snippet(body),
    }
}

fn build_note_item(vault_root: &Path, abs_path: &Path) -> TimelineItem {
    let mtime = notes::mtime_secs(abs_path);
    let rel_path = abs_path
        .strip_prefix(vault_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
    let content = std::fs::read_to_string(abs_path).unwrap_or_default();
    let (fm, body) = notes::parse_front_matter(&content);
    let title = fm
        .title
        .or_else(|| notes::first_h1(body))
        .unwrap_or_else(|| {
            abs_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });
    TimelineItem::Note {
        rel_path,
        title,
        mtime,
        snippet: notes::make_snippet(body),
        pinned: fm.pinned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn touch(path: &Path, contents: &[u8], mtime: SystemTime) {
        fsx::atomic_write(path, contents).unwrap();
        let f = std::fs::File::open(path).unwrap();
        f.set_modified(mtime).unwrap();
    }

    #[test]
    fn quick_create_creates_inbox_file_and_returns_meta() {
        let vault = tempfile::tempdir().unwrap();
        let meta = quick_create_impl(vault.path()).unwrap();
        assert!(std::path::Path::new(&meta.path).is_file());
        assert!(meta.rel_path.starts_with("notes/_inbox/"));
        assert!(meta.rel_path.ends_with(".md"));
        assert_eq!(meta.size, 0);
    }

    #[test]
    fn quick_create_disambiguates_collisions() {
        let vault = tempfile::tempdir().unwrap();
        let a = quick_create_impl(vault.path()).unwrap();
        let b = quick_create_impl(vault.path()).unwrap();
        assert_ne!(a.path, b.path);
    }

    #[test]
    fn quick_list_returns_empty_when_no_inbox() {
        let vault = tempfile::tempdir().unwrap();
        let list = quick_list_impl(vault.path(), 50).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn quick_list_orders_newest_first_and_respects_limit() {
        let vault = tempfile::tempdir().unwrap();
        let inbox = vault.path().join("notes/_inbox");
        let now = SystemTime::now();
        touch(&inbox.join("a.md"), b"", now - Duration::from_secs(30));
        touch(&inbox.join("b.md"), b"", now - Duration::from_secs(10));
        touch(&inbox.join("c.md"), b"", now - Duration::from_secs(20));

        let list = quick_list_impl(vault.path(), 2).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].title, "b");
        assert_eq!(list[1].title, "c");
    }

    #[test]
    fn quick_list_skips_non_markdown_files() {
        let vault = tempfile::tempdir().unwrap();
        let inbox = vault.path().join("notes/_inbox");
        fsx::atomic_write(&inbox.join("a.md"), b"").unwrap();
        fsx::atomic_write(&inbox.join("b.txt"), b"").unwrap();
        let list = quick_list_impl(vault.path(), 50).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "a");
    }

    #[test]
    fn activity_recent_mixes_journal_and_notes_by_mtime() {
        let vault = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        touch(
            &vault.path().join("journal/2026/05/2026-05-09.md"),
            b"# Day entry",
            now - Duration::from_secs(60),
        );
        touch(
            &vault.path().join("notes/work/standup.md"),
            b"---\ntitle: \"Standup\"\npinned: true\n---\nbody",
            now - Duration::from_secs(10),
        );
        touch(
            &vault.path().join("notes/_inbox/quick.md"),
            b"# Quick capture",
            now - Duration::from_secs(30),
        );

        let items = activity_recent_impl(vault.path(), 10).unwrap();
        assert_eq!(items.len(), 3);

        match &items[0] {
            TimelineItem::Note {
                rel_path,
                title,
                pinned,
                ..
            } => {
                assert_eq!(rel_path, "notes/work/standup.md");
                assert_eq!(title, "Standup");
                assert!(*pinned);
            }
            other => panic!("expected pinned note first, got {other:?}"),
        }

        match &items[1] {
            TimelineItem::Note {
                rel_path, title, ..
            } => {
                assert_eq!(rel_path, "notes/_inbox/quick.md");
                assert_eq!(title, "Quick capture");
            }
            other => panic!("expected inbox note second, got {other:?}"),
        }

        match &items[2] {
            TimelineItem::JournalEntry { date, title, .. } => {
                assert_eq!(date, "2026-05-09");
                assert_eq!(title, "Day entry");
            }
            other => panic!("expected journal entry third, got {other:?}"),
        }
    }

    #[test]
    fn activity_recent_respects_limit() {
        let vault = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        for i in 0..5 {
            touch(
                &vault.path().join(format!("notes/n{i}.md")),
                b"x",
                now - Duration::from_secs(i * 10),
            );
        }
        let items = activity_recent_impl(vault.path(), 3).unwrap();
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn activity_recent_handles_empty_vault() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("journal")).unwrap();
        std::fs::create_dir_all(vault.path().join("notes")).unwrap();
        let items = activity_recent_impl(vault.path(), 50).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn activity_recent_camel_case_serialization() {
        let item = TimelineItem::Note {
            rel_path: "notes/x.md".into(),
            title: "x".into(),
            mtime: 1,
            snippet: "".into(),
            pinned: false,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"kind\":\"Note\""));
        assert!(json.contains("\"relPath\":\"notes/x.md\""));
    }
}
