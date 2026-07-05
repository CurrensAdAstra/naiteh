//! Journal IPC commands — see architecture.md §7.3 / §7.4.
//!
//! Each public `*` command is a thin wrapper that resolves the active vault
//! and delegates to a `*_impl` taking the vault root explicitly so it can be
//! unit-tested against a tempdir.

use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate};

use crate::domain::{
    AppError, DayMeta, JournalOpenResult, JournalSaveResult, NoteMeta, TimelineDay, TimelineItem,
};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::hooks;
use crate::services::index::TagIndex;
use crate::services::notes;
use crate::services::timeline;
use crate::services::vault_lock::VaultLocks;

const INBOX_DIR: &str = "_inbox";

// ── quick_create ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn quick_create(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
) -> Result<NoteMeta, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = quick_create_impl(&vault_root);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
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
pub fn activity_recent(
    index: tauri::State<'_, TagIndex>,
    limit: u32,
) -> Result<Vec<TimelineItem>, AppError> {
    let vault_root = config::current_vault_root()?;
    let snap = index.get_or_build(&vault_root)?;
    Ok(timeline::recent(&snap.notes, limit as usize))
}

// ── journal_open ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn journal_open(date: String) -> Result<JournalOpenResult, AppError> {
    let vault_root = config::current_vault_root()?;
    journal_open_impl(&vault_root, &date)
}

fn journal_open_impl(vault_root: &Path, date: &str) -> Result<JournalOpenResult, AppError> {
    validate_date(date)?;
    let path = journal_path_for(vault_root, date);
    let path_str = path.to_string_lossy().to_string();
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(JournalOpenResult {
            path: path_str,
            content,
            exists: true,
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(JournalOpenResult {
            path: path_str,
            content: String::new(),
            exists: false,
        }),
        Err(e) => Err(AppError::Io(e.to_string())),
    }
}

// ── journal_save ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn journal_save(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    date: String,
    content: String,
) -> Result<JournalSaveResult, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = journal_save_impl(&vault_root, &date, &content);
    if result.is_ok() {
        index.invalidate(&vault_root);
        if let Ok(config_dir) = config::default_app_config_dir() {
            let rel = format!("journal/{}/{}/{date}.md", &date[0..4], &date[5..7]);
            hooks::fire(
                &config_dir,
                hooks::HookEvent::JournalSave,
                &vault_root,
                Some(&rel),
            );
        }
    }
    result
}

fn journal_save_impl(
    vault_root: &Path,
    date: &str,
    content: &str,
) -> Result<JournalSaveResult, AppError> {
    validate_date(date)?;
    let path = journal_path_for(vault_root, date);
    fsx::atomic_write(&path, content.as_bytes())?;
    let mtime = notes::mtime_secs(&path);
    Ok(JournalSaveResult {
        path: path.to_string_lossy().to_string(),
        mtime,
    })
}

// ── journal_month_meta ───────────────────────────────────────────────────

#[tauri::command]
pub fn journal_month_meta(year: u16, month: u8) -> Result<Vec<DayMeta>, AppError> {
    let vault_root = config::current_vault_root()?;
    journal_month_meta_impl(&vault_root, year, month)
}

fn journal_month_meta_impl(
    vault_root: &Path,
    year: u16,
    month: u8,
) -> Result<Vec<DayMeta>, AppError> {
    if !(1..=12).contains(&month) {
        return Err(AppError::InvalidPath(format!("invalid month: {month}")));
    }
    let dir = vault_root
        .join("journal")
        .join(format!("{year:04}"))
        .join(format!("{month:02}"));
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if validate_date(&stem).is_err() {
            continue;
        }
        let mtime = notes::mtime_secs(&path);
        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let (fm, body) = notes::parse_front_matter(&content);
        let title = fm.title.or_else(|| notes::first_h1(body));
        let snippet = (!body.trim().is_empty()).then(|| notes::make_snippet(body));
        out.push(DayMeta {
            date: stem,
            has_entry: true,
            path: Some(path.to_string_lossy().to_string()),
            mtime: Some(mtime),
            title,
            snippet,
        });
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(out)
}

// ── timeline_range ───────────────────────────────────────────────────────

#[tauri::command]
pub fn timeline_range(
    index: tauri::State<'_, TagIndex>,
    from: String,
    to: String,
) -> Result<Vec<TimelineDay>, AppError> {
    let from_d = parse_date(&from)?;
    let to_d = parse_date(&to)?;
    if from_d > to_d {
        return Err(AppError::InvalidPath(format!("from > to: {from} > {to}")));
    }
    let vault_root = config::current_vault_root()?;
    let snap = index.get_or_build(&vault_root)?;
    Ok(timeline::range(&snap.notes, from_d, to_d))
}

// ── timeline_pinned ──────────────────────────────────────────────────────

#[tauri::command]
pub fn timeline_pinned(index: tauri::State<'_, TagIndex>) -> Result<Vec<TimelineItem>, AppError> {
    let vault_root = config::current_vault_root()?;
    let snap = index.get_or_build(&vault_root)?;
    Ok(timeline::pinned(&snap.notes))
}

// ── helpers ──────────────────────────────────────────────────────────────

/// Strict `YYYY-MM-DD` validation — requires the canonical 10-character
/// shape on top of `NaiveDate`'s parser, which would otherwise accept e.g.
/// "26-05-09" as year 26.
fn validate_date(date: &str) -> Result<(), AppError> {
    parse_date(date).map(|_| ())
}

fn parse_date(date: &str) -> Result<NaiveDate, AppError> {
    let bytes = date.as_bytes();
    let well_shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(|c| c.is_ascii_digit())
        && bytes[5..7].iter().all(|c| c.is_ascii_digit())
        && bytes[8..10].iter().all(|c| c.is_ascii_digit());
    if !well_shaped {
        return Err(AppError::InvalidPath(format!(
            "invalid date '{date}' (expected YYYY-MM-DD)"
        )));
    }
    NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| AppError::InvalidPath(format!("invalid date '{date}': {e}")))
}

fn journal_path_for(vault_root: &Path, date: &str) -> PathBuf {
    let year = &date[0..4];
    let month = &date[5..7];
    vault_root
        .join("journal")
        .join(year)
        .join(month)
        .join(format!("{date}.md"))
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

    // Integration helpers: drive the real index → timeline path against
    // on-disk fixtures (the timeline classification/sorting itself has
    // unit tests in services::timeline).
    fn recent(vault: &Path, limit: u32) -> Vec<TimelineItem> {
        let idx = TagIndex::default();
        let snap = idx.get_or_build(vault).unwrap();
        timeline::recent(&snap.notes, limit as usize)
    }

    fn range(vault: &Path, from: &str, to: &str) -> Result<Vec<TimelineDay>, AppError> {
        let from_d = parse_date(from)?;
        let to_d = parse_date(to)?;
        if from_d > to_d {
            return Err(AppError::InvalidPath(format!("from > to: {from} > {to}")));
        }
        let idx = TagIndex::default();
        let snap = idx.get_or_build(vault).unwrap();
        Ok(timeline::range(&snap.notes, from_d, to_d))
    }

    fn pinned(vault: &Path) -> Vec<TimelineItem> {
        let idx = TagIndex::default();
        let snap = idx.get_or_build(vault).unwrap();
        timeline::pinned(&snap.notes)
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

        let items = recent(vault.path(), 10);
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
        let items = recent(vault.path(), 3);
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn activity_recent_handles_empty_vault() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("journal")).unwrap();
        std::fs::create_dir_all(vault.path().join("notes")).unwrap();
        let items = recent(vault.path(), 50);
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

    // ── journal_open ──────────────────────────────────────────────────────

    #[test]
    fn journal_open_returns_exists_false_when_file_is_missing() {
        let vault = tempfile::tempdir().unwrap();
        let result = journal_open_impl(vault.path(), "2026-05-09").unwrap();
        assert!(!result.exists);
        assert_eq!(result.content, "");
        assert!(result.path.ends_with("journal/2026/05/2026-05-09.md"));
    }

    #[test]
    fn journal_open_does_not_create_file() {
        let vault = tempfile::tempdir().unwrap();
        let _ = journal_open_impl(vault.path(), "2026-05-09").unwrap();
        assert!(!vault.path().join("journal/2026/05/2026-05-09.md").exists());
    }

    #[test]
    fn journal_open_returns_existing_content() {
        let vault = tempfile::tempdir().unwrap();
        let path = vault.path().join("journal/2026/05/2026-05-09.md");
        fsx::atomic_write(&path, b"hello").unwrap();
        let result = journal_open_impl(vault.path(), "2026-05-09").unwrap();
        assert!(result.exists);
        assert_eq!(result.content, "hello");
    }

    #[test]
    fn journal_open_rejects_invalid_dates() {
        let vault = tempfile::tempdir().unwrap();
        for bad in ["2026-13-01", "26-05-09", "not-a-date", ""] {
            let err = journal_open_impl(vault.path(), bad).unwrap_err();
            assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        }
    }

    // ── journal_save ──────────────────────────────────────────────────────

    #[test]
    fn journal_save_creates_directory_tree_and_file() {
        let vault = tempfile::tempdir().unwrap();
        let result = journal_save_impl(vault.path(), "2026-05-09", "first version").unwrap();
        let path = vault.path().join("journal/2026/05/2026-05-09.md");
        assert!(path.is_file());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first version");
        assert!(result.path.ends_with("2026-05-09.md"));
        assert!(result.mtime > 0);
    }

    #[test]
    fn journal_save_overwrites_existing_file() {
        let vault = tempfile::tempdir().unwrap();
        journal_save_impl(vault.path(), "2026-05-09", "v1").unwrap();
        journal_save_impl(vault.path(), "2026-05-09", "v2").unwrap();
        let read = journal_open_impl(vault.path(), "2026-05-09").unwrap();
        assert_eq!(read.content, "v2");
    }

    // ── journal_month_meta ────────────────────────────────────────────────

    #[test]
    fn journal_month_meta_lists_only_valid_dates_in_month() {
        let vault = tempfile::tempdir().unwrap();
        fsx::atomic_write(
            &vault.path().join("journal/2026/05/2026-05-01.md"),
            b"# May 1",
        )
        .unwrap();
        fsx::atomic_write(
            &vault.path().join("journal/2026/05/2026-05-09.md"),
            b"---\ntitle: \"Friday\"\n---\nbody text",
        )
        .unwrap();
        // Garbage filename should be skipped.
        fsx::atomic_write(&vault.path().join("journal/2026/05/notes.md"), b"x").unwrap();
        // Different month should not appear.
        fsx::atomic_write(&vault.path().join("journal/2026/06/2026-06-01.md"), b"x").unwrap();

        let metas = journal_month_meta_impl(vault.path(), 2026, 5).unwrap();
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].date, "2026-05-01");
        assert_eq!(metas[0].title.as_deref(), Some("May 1"));
        assert_eq!(metas[1].date, "2026-05-09");
        assert_eq!(metas[1].title.as_deref(), Some("Friday"));
        assert!(metas[1].snippet.is_some());
    }

    #[test]
    fn journal_month_meta_returns_empty_for_missing_month() {
        let vault = tempfile::tempdir().unwrap();
        let metas = journal_month_meta_impl(vault.path(), 2026, 5).unwrap();
        assert!(metas.is_empty());
    }

    #[test]
    fn journal_month_meta_rejects_invalid_month() {
        let vault = tempfile::tempdir().unwrap();
        let err = journal_month_meta_impl(vault.path(), 2026, 13).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    // ── timeline_range ────────────────────────────────────────────────────

    #[test]
    fn timeline_range_returns_one_day_per_date_in_range_newest_first() {
        let vault = tempfile::tempdir().unwrap();
        let days = range(vault.path(), "2026-05-01", "2026-05-03").unwrap();
        assert_eq!(days.len(), 3);
        assert_eq!(days[0].date, "2026-05-03");
        assert_eq!(days[1].date, "2026-05-02");
        assert_eq!(days[2].date, "2026-05-01");
        for d in &days {
            assert!(d.items.is_empty());
        }
    }

    #[test]
    fn timeline_range_attaches_journal_entry_for_its_date() {
        let vault = tempfile::tempdir().unwrap();
        fsx::atomic_write(
            &vault.path().join("journal/2026/05/2026-05-02.md"),
            b"# Tue",
        )
        .unwrap();
        let days = range(vault.path(), "2026-05-01", "2026-05-03").unwrap();
        let tue = days.iter().find(|d| d.date == "2026-05-02").unwrap();
        assert_eq!(tue.items.len(), 1);
        match &tue.items[0] {
            TimelineItem::JournalEntry { date, title, .. } => {
                assert_eq!(date, "2026-05-02");
                assert_eq!(title, "Tue");
            }
            other => panic!("expected journal entry, got {other:?}"),
        }
    }

    #[test]
    fn timeline_range_groups_notes_by_local_mtime_date() {
        let vault = tempfile::tempdir().unwrap();
        // Use SystemTime to land "today" so we can predict the date.
        let today = Local::now().format("%Y-%m-%d").to_string();
        let now = SystemTime::now();
        touch(
            &vault.path().join("notes/work/standup.md"),
            b"---\ntitle: \"Standup\"\n---\nbody",
            now,
        );
        let days = range(vault.path(), &today, &today).unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].items.len(), 1);
        match &days[0].items[0] {
            TimelineItem::Note { rel_path, .. } => {
                assert_eq!(rel_path, "notes/work/standup.md");
            }
            other => panic!("expected note, got {other:?}"),
        }
    }

    #[test]
    fn timeline_range_rejects_inverted_range() {
        let vault = tempfile::tempdir().unwrap();
        let err = range(vault.path(), "2026-05-10", "2026-05-01").unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    // ── timeline_pinned ───────────────────────────────────────────────────

    #[test]
    fn timeline_pinned_returns_only_pinned_items_newest_first() {
        let vault = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        touch(
            &vault.path().join("notes/work/standup.md"),
            b"---\ntitle: \"Standup\"\npinned: true\n---\nbody",
            now - Duration::from_secs(60),
        );
        touch(
            &vault.path().join("notes/personal/idea.md"),
            b"---\ntitle: \"Idea\"\n---\nbody",
            now - Duration::from_secs(20),
        );
        touch(
            &vault.path().join("journal/2026/05/2026-05-09.md"),
            b"---\ntitle: \"Day\"\npinned: true\n---\nbody",
            now,
        );
        let pinned = pinned(vault.path());
        assert_eq!(pinned.len(), 2);
        match &pinned[0] {
            TimelineItem::JournalEntry { title, .. } => assert_eq!(title, "Day"),
            other => panic!("expected pinned journal first, got {other:?}"),
        }
        match &pinned[1] {
            TimelineItem::Note {
                title, pinned: p, ..
            } => {
                assert_eq!(title, "Standup");
                assert!(*p);
            }
            other => panic!("expected pinned note second, got {other:?}"),
        }
    }

    #[test]
    fn timeline_pinned_returns_empty_when_nothing_is_pinned() {
        let vault = tempfile::tempdir().unwrap();
        fsx::atomic_write(
            &vault.path().join("notes/work/x.md"),
            b"---\ntitle: \"Work\"\n---\nbody",
        )
        .unwrap();
        let pinned = pinned(vault.path());
        assert!(pinned.is_empty());
    }
}
