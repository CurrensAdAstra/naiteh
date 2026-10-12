//! Calendar subscription IPC commands — see vault/wiki/ipc-api.md
//! ("Calendar subscriptions").
//!
//! Read-only iCal feeds (Google secret address, iCloud public calendar,
//! any https/webcal URL). Sources and caches live in the app config dir
//! (services::calendar). Network fetches run on the async runtime and
//! never under the vault lock; only `calendar_event_note` takes the
//! vault lock, for its note write.

use std::path::Path;

use chrono::{DateTime, NaiveDate};

use crate::commands::notes::{fire_note_saved, unique_path};
use crate::domain::{AppError, NoteMeta};
use crate::services::calendar::{self, CalendarEvent, CalendarSource, Range, StoredSource};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::index::TagIndex;
use crate::services::notes;
use crate::services::session::{require_session, ActiveSession};
use crate::services::vault_lock::VaultLocks;

/// Folder (vault-relative) that meeting notes are created in.
pub const MEETINGS_DIR: &str = "notes/meetings";

fn config_dir() -> Result<std::path::PathBuf, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    Ok(dir)
}

fn views(list: &[StoredSource]) -> Vec<CalendarSource> {
    list.iter().map(StoredSource::view).collect()
}

/// Fetch one source and record the outcome (cache + lastSyncedAt, or
/// lastError). No lock is held across the network await.
async fn refresh_source(dir: &Path, source: &StoredSource) -> Result<(), AppError> {
    let result = calendar::fetch_ics(&source.url).await;
    let (dir, id) = (dir.to_path_buf(), source.id.clone());
    fsx::run_blocking(move || calendar::record_fetch(&dir, &id, result, calendar::unix_now())).await
}

// ── calendar_list ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn calendar_list(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<CalendarSource>, AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || Ok(views(&calendar::load_sources(&dir)?))).await
}

// ── calendar_add ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn calendar_add(
    active: tauri::State<'_, ActiveSession>,
    name: String,
    url: String,
    kind: String,
    color: String,
) -> Result<CalendarSource, AppError> {
    require_session(&active)?;
    let name = calendar::validate_name(&name)?;
    calendar::validate_color(&color)?;
    let url = calendar::normalize_url(&url)?;
    let kind = calendar::detect_kind(&kind, &url)?;
    let body = calendar::fetch_ics(url.as_str()).await?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let now = calendar::unix_now();
        let source = StoredSource {
            id: calendar::new_source_id()?,
            name,
            kind,
            color,
            enabled: true,
            url: url.to_string(),
            last_synced_at: Some(now),
            last_error: None,
            last_attempt_at: Some(now),
        };
        fsx::atomic_write(&calendar::cache_path(&dir, &source.id), body.as_bytes())?;
        let view = source.view();
        calendar::modify_sources(&dir, |list| {
            list.push(source);
            Ok(())
        })?;
        Ok(view)
    })
    .await
}

// ── calendar_update / calendar_remove ────────────────────────────────────

#[tauri::command]
pub async fn calendar_update(
    active: tauri::State<'_, ActiveSession>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    enabled: Option<bool>,
) -> Result<CalendarSource, AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || update_impl(&dir, &id, name, color, enabled)).await
}

fn update_impl(
    dir: &Path,
    id: &str,
    name: Option<String>,
    color: Option<String>,
    enabled: Option<bool>,
) -> Result<CalendarSource, AppError> {
    let name = name.map(|n| calendar::validate_name(&n)).transpose()?;
    if let Some(c) = &color {
        calendar::validate_color(c)?;
    }
    calendar::modify_sources(dir, |list| {
        let s = list
            .iter_mut()
            .find(|s| s.id == id)
            .ok_or_else(|| AppError::NotFound(format!("calendar {id}")))?;
        if let Some(n) = name {
            s.name = n;
        }
        if let Some(c) = color {
            s.color = c;
        }
        if let Some(e) = enabled {
            s.enabled = e;
        }
        Ok(s.view())
    })
}

#[tauri::command]
pub async fn calendar_remove(
    active: tauri::State<'_, ActiveSession>,
    id: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || remove_impl(&dir, &id)).await
}

fn remove_impl(dir: &Path, id: &str) -> Result<(), AppError> {
    calendar::modify_sources(dir, |list| {
        let before = list.len();
        list.retain(|s| s.id != id);
        if list.len() == before {
            return Err(AppError::NotFound(format!("calendar {id}")));
        }
        Ok(())
    })?;
    // `id` matched a stored (generated, hex) id, so it is path-safe.
    match fsx::remove_file(&calendar::cache_path(dir, id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Io(e.to_string())),
    }
}

// ── calendar_events / calendar_refresh ───────────────────────────────────

#[tauri::command]
pub async fn calendar_events(
    active: tauri::State<'_, ActiveSession>,
    index: tauri::State<'_, TagIndex>,
    start: String,
    end: String,
) -> Result<Vec<CalendarEvent>, AppError> {
    require_session(&active)?;
    let range = Range::parse(&start, &end)?;
    let dir = config_dir()?;
    let d = dir.clone();
    let sources = fsx::run_blocking(move || calendar::load_sources(&d)).await?;
    let now = calendar::unix_now();
    for s in sources.iter().filter(|s| s.enabled) {
        let has_cache = calendar::cache_path(&dir, &s.id).exists();
        if !calendar::is_fresh(s, has_cache, now) {
            // Failure is recorded as lastError; the cache still serves.
            refresh_source(&dir, s).await?;
        }
    }
    let index = index.inner().clone();
    fsx::run_blocking(move || {
        let sources = calendar::load_sources(&dir)?;
        let lookup = match config::current_vault_root() {
            Ok(root) => calendar::note_lookup(index.get_or_build(&root)?.as_ref()),
            Err(_) => Default::default(),
        };
        Ok(calendar::events_from_cache(&dir, &sources, range, &|id| {
            lookup.get(id).cloned()
        }))
    })
    .await
}

#[tauri::command]
pub async fn calendar_refresh(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<CalendarSource>, AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    let d = dir.clone();
    let sources = fsx::run_blocking(move || calendar::load_sources(&d)).await?;
    for s in sources.iter().filter(|s| s.enabled) {
        refresh_source(&dir, s).await?;
    }
    fsx::run_blocking(move || Ok(views(&calendar::load_sources(&dir)?))).await
}

// ── calendar_event_note ──────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn calendar_event_note(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    calendar_id: String,
    event_id: String,
    title: String,
    start: String,
    all_day: bool,
) -> Result<NoteMeta, AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    let d = dir.clone();
    let cid = calendar_id.clone();
    let calendar_name = fsx::run_blocking(move || {
        calendar::load_sources(&d)?
            .into_iter()
            .find(|s| s.id == cid)
            .map(|s| s.name)
            .ok_or_else(|| AppError::NotFound(format!("calendar {cid}")))
    })
    .await?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let idx = index.inner().clone();
    let result = fsx::run_blocking(move || {
        let req = EventNoteRequest {
            calendar_name: &calendar_name,
            event_id: &event_id,
            title: &title,
            start: &start,
            all_day,
        };
        event_note_impl(&root, &idx, &req)
    })
    .await;
    if let Ok((meta, created)) = &result {
        if *created {
            index.invalidate(&vault_root);
            fire_note_saved(&vault_root, &meta.rel_path);
        }
    }
    result.map(|(meta, _)| meta)
}

struct EventNoteRequest<'a> {
    calendar_name: &'a str,
    event_id: &'a str,
    title: &'a str,
    start: &'a str,
    all_day: bool,
}

/// Find the note whose front matter has `event_id`, or create one under
/// `notes/meetings/`. Returns the meta and whether it was created.
fn event_note_impl(
    vault_root: &Path,
    index: &TagIndex,
    req: &EventNoteRequest<'_>,
) -> Result<(NoteMeta, bool), AppError> {
    let event_id = req.event_id.trim();
    if event_id.is_empty() || event_id.len() > 1024 {
        return Err(AppError::Validation("eventId is required".into()));
    }
    let snap = index.get_or_build(vault_root)?;
    if let Some(rel) = calendar::note_lookup(&snap).get(event_id) {
        let abs = notes::resolve_in_vault(vault_root, rel)?;
        if abs.is_file() {
            return Ok((notes::read_note_meta(vault_root, &abs)?, false));
        }
    }
    let (date, time) = parse_start(req.start, req.all_day)?;
    let title = req.title.trim();
    let title = if title.is_empty() { "Meeting" } else { title };
    let dir = notes::resolve_in_vault(vault_root, MEETINGS_DIR)?;
    fsx::ensure_dir(&dir)?;
    let stem = notes::slugify(&format!("{date} {title}"));
    let target = unique_path(&dir, &stem);
    let mut fm = format!(
        "---\ntitle: {}\ndate: {date}\nevent_id: {}\ncalendar: {}\n",
        notes::yaml_quote(title),
        notes::yaml_quote(event_id),
        notes::yaml_quote(req.calendar_name),
    );
    if let Some(t) = time {
        fm.push_str(&format!("time: \"{t}\"\n"));
    }
    let content = format!("{fm}---\n\n# {title}\n\n");
    fsx::atomic_write(&target, content.as_bytes())?;
    Ok((notes::read_note_meta(vault_root, &target)?, true))
}

/// `("YYYY-MM-DD", Some("HH:MM"))` from an event start: the date as is
/// for all-day, the RFC3339 value's own (local) wall clock otherwise.
fn parse_start(start: &str, all_day: bool) -> Result<(String, Option<String>), AppError> {
    let bad = || AppError::Validation(format!("Invalid event start: {start}"));
    if all_day {
        let d = NaiveDate::parse_from_str(start.get(..10).ok_or_else(bad)?, "%Y-%m-%d")
            .map_err(|_| bad())?;
        return Ok((d.format("%Y-%m-%d").to_string(), None));
    }
    let t = DateTime::parse_from_rfc3339(start).map_err(|_| bad())?;
    Ok((
        t.format("%Y-%m-%d").to_string(),
        Some(t.format("%H:%M").to_string()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn req<'a>(
        event_id: &'a str,
        title: &'a str,
        start: &'a str,
        all_day: bool,
    ) -> EventNoteRequest<'a> {
        EventNoteRequest {
            calendar_name: "Work \"main\"",
            event_id,
            title,
            start,
            all_day,
        }
    }

    #[test]
    fn event_note_creates_then_finds_existing() {
        let v = tempdir().unwrap();
        let idx = TagIndex::default();
        let r = req(
            "uid1@20260105T090000Z",
            "Design review",
            "2026-01-05T10:00:00+01:00",
            false,
        );
        let (meta, created) = event_note_impl(v.path(), &idx, &r).unwrap();
        assert!(created);
        assert_eq!(meta.rel_path, "notes/meetings/2026-01-05-design-review.md");
        assert_eq!(meta.title, "Design review");
        let content = std::fs::read_to_string(v.path().join(&meta.rel_path)).unwrap();
        assert!(content.contains("event_id: \"uid1@20260105T090000Z\"\n"));
        assert!(content.contains("date: 2026-01-05\n"));
        assert!(content.contains("time: \"10:00\"\n"));
        assert!(content.contains("calendar: \"Work \\\"main\\\"\"\n"));
        assert!(content.ends_with("---\n\n# Design review\n\n"));

        // Second call (after the write invalidates the index) returns it.
        idx.invalidate(v.path());
        let (again, created) = event_note_impl(v.path(), &idx, &r).unwrap();
        assert!(!created);
        assert_eq!(again.rel_path, meta.rel_path);

        // A different event with the same title + date gets a unique name.
        let r2 = req(
            "uid2@20260105T090000Z",
            "Design review",
            "2026-01-05T15:00:00+01:00",
            false,
        );
        let (other, created) = event_note_impl(v.path(), &idx, &r2).unwrap();
        assert!(created);
        assert_eq!(
            other.rel_path,
            "notes/meetings/2026-01-05-design-review-1.md"
        );

        // Index exposes the mapping for calendar_events.
        idx.invalidate(v.path());
        let lookup = calendar::note_lookup(&idx.get_or_build(v.path()).unwrap());
        assert_eq!(lookup.get("uid1@20260105T090000Z"), Some(&meta.rel_path));
    }

    #[test]
    fn event_note_all_day_has_no_time_and_rejects_bad_input() {
        let v = tempdir().unwrap();
        let idx = TagIndex::default();
        let (meta, _) = event_note_impl(
            v.path(),
            &idx,
            &req("d@20260110", "Offsite", "2026-01-10", true),
        )
        .unwrap();
        let content = std::fs::read_to_string(v.path().join(&meta.rel_path)).unwrap();
        assert!(!content.contains("time:"));
        assert!(event_note_impl(v.path(), &idx, &req("", "x", "2026-01-10", true)).is_err());
        assert!(event_note_impl(v.path(), &idx, &req("e", "x", "yesterday", false)).is_err());
    }

    #[test]
    fn update_and_remove_sources() {
        let dir = tempdir().unwrap();
        calendar::modify_sources(dir.path(), |l| {
            l.push(StoredSource {
                id: "ab12".into(),
                name: "A".into(),
                kind: "ics".into(),
                color: "gray".into(),
                enabled: true,
                url: "https://example.com/a.ics".into(),
                last_synced_at: None,
                last_error: None,
                last_attempt_at: None,
            });
            Ok(())
        })
        .unwrap();
        fsx::atomic_write(&calendar::cache_path(dir.path(), "ab12"), b"x").unwrap();
        let v = update_impl(
            dir.path(),
            "ab12",
            Some(" B ".into()),
            Some("teal".into()),
            Some(false),
        )
        .unwrap();
        assert_eq!(
            (v.name.as_str(), v.color.as_str(), v.enabled),
            ("B", "teal", false)
        );
        assert!(update_impl(dir.path(), "ab12", None, Some("black".into()), None).is_err());
        assert!(matches!(
            update_impl(dir.path(), "zz", None, None, None),
            Err(AppError::NotFound(_))
        ));
        remove_impl(dir.path(), "ab12").unwrap();
        assert!(!calendar::cache_path(dir.path(), "ab12").exists());
        assert!(calendar::load_sources(dir.path()).unwrap().is_empty());
        assert!(matches!(
            remove_impl(dir.path(), "ab12"),
            Err(AppError::NotFound(_))
        ));
    }
}
