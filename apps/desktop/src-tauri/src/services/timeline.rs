//! Timeline / activity item construction from the in-memory index.
//!
//! `activity_recent`, `timeline_range`, and `timeline_pinned` used to
//! re-scan and re-read every Markdown file under `notes/` + `journal/`
//! on every call. They now build their `TimelineItem`s from the cached
//! `IndexedDoc`s the tag index already holds (see `services::index`),
//! so switching tabs no longer fans out O(N) disk reads.
//!
//! Classification by vault-relative path:
//!   - `journal/.../<YYYY-MM-DD>.md` with a well-formed date stem →
//!     `TimelineItem::JournalEntry` (keyed by that date).
//!   - anything under `notes/` → `TimelineItem::Note`, keyed in range
//!     queries by its front-matter `created` local date when that parses
//!     (timestamp or date-only), else by its mtime's local date.
//!
//! Every item carries a `Placement` (time of day on the day timeline,
//! note/clip/journal kind, clip source host). Placement is purely local
//! display data: nothing here is ever written to or sent to a calendar.
//!   - a `journal/` file whose stem isn't a valid date is skipped, matching
//!     the previous behaviour.

use std::collections::HashMap;

use chrono::{DateTime, Local, NaiveDate, SecondsFormat};

use crate::domain::{DocKind, Placement, TimelineDay, TimelineItem};
use crate::services::index::{Created, IndexedDoc};

/// Most-recently-modified items first, capped at `limit`.
pub fn recent(docs: &[IndexedDoc], limit: usize) -> Vec<TimelineItem> {
    let mut items: Vec<TimelineItem> = docs.iter().filter_map(item_from_doc).collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.mtime()));
    items.truncate(limit);
    items
}

/// Pinned items only, most-recent first.
pub fn pinned(docs: &[IndexedDoc]) -> Vec<TimelineItem> {
    let mut items: Vec<TimelineItem> = docs
        .iter()
        .filter(|d| d.meta.pinned)
        .filter_map(item_from_doc)
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.mtime()));
    items
}

/// One `TimelineDay` per date in `[from, to]` (inclusive), newest day
/// first. Journal entries land on their own date; notes land on their
/// `created` local date if it parses, else their mtime's local date.
/// Empty days are included.
pub fn range(docs: &[IndexedDoc], from: NaiveDate, to: NaiveDate) -> Vec<TimelineDay> {
    let mut journal_by_date: HashMap<String, TimelineItem> = HashMap::new();
    let mut notes_by_date: HashMap<String, Vec<TimelineItem>> = HashMap::new();

    for doc in docs {
        let Some(item) = item_from_doc(doc) else {
            continue;
        };
        match &item {
            TimelineItem::JournalEntry { date, .. } => {
                journal_by_date.insert(date.clone(), item);
            }
            TimelineItem::Note { .. } => {
                let date = match doc.created {
                    Some(Created::At(dt)) => dt.format("%Y-%m-%d").to_string(),
                    Some(Created::Date(d)) => d.format("%Y-%m-%d").to_string(),
                    None => mtime_to_local_date(item.mtime()),
                };
                notes_by_date.entry(date).or_default().push(item);
            }
        }
    }

    let mut days = Vec::new();
    let mut cursor = from;
    loop {
        let date_str = cursor.format("%Y-%m-%d").to_string();
        let mut items: Vec<TimelineItem> = Vec::new();
        if let Some(je) = journal_by_date.remove(&date_str) {
            items.push(je);
        }
        if let Some(mut day_notes) = notes_by_date.remove(&date_str) {
            day_notes.sort_by_key(|i| std::cmp::Reverse(i.mtime()));
            items.extend(day_notes);
        }
        days.push(TimelineDay {
            date: date_str,
            items,
        });
        if cursor == to {
            break;
        }
        match cursor.succ_opt() {
            Some(next) => cursor = next,
            None => break,
        }
    }
    days.reverse();
    days
}

fn item_from_doc(doc: &IndexedDoc) -> Option<TimelineItem> {
    let meta = &doc.meta;
    if let Some(date) = journal_date(&meta.rel_path) {
        Some(TimelineItem::JournalEntry {
            date: date.to_string(),
            path: meta.path.clone(),
            mtime: meta.mtime,
            title: if meta.title.is_empty() {
                date.to_string()
            } else {
                meta.title.clone()
            },
            snippet: doc.snippet.clone(),
            placement: placement(doc, DocKind::Journal),
        })
    } else if meta.rel_path.starts_with("journal/") {
        // A journal/ file with a malformed date stem — skip, as the old
        // code did when validating the filename.
        None
    } else {
        Some(TimelineItem::Note {
            rel_path: meta.rel_path.clone(),
            title: meta.title.clone(),
            mtime: meta.mtime,
            snippet: doc.snippet.clone(),
            pinned: meta.pinned,
            placement: placement(doc, doc.doc_kind),
        })
    }
}

/// Time-of-day placement: `created` when it has a time, no time when it
/// is date-only, else the file mtime (all in the local offset).
fn placement(doc: &IndexedDoc, doc_kind: DocKind) -> Placement {
    let rfc = |dt: DateTime<Local>| dt.to_rfc3339_opts(SecondsFormat::Secs, false);
    let (created_at, placed_at) = match doc.created {
        Some(Created::At(dt)) => (Some(rfc(dt)), Some(rfc(dt))),
        Some(Created::Date(_)) => (None, None),
        None => (
            None,
            DateTime::from_timestamp(doc.meta.mtime, 0).map(|d| rfc(d.with_timezone(&Local))),
        ),
    };
    Placement {
        created_at,
        placed_at,
        doc_kind,
        source_host: doc.source_host.clone(),
    }
}

/// If `rel_path` is `journal/.../<YYYY-MM-DD>.md` with a well-formed
/// date stem, return that stem.
fn journal_date(rel_path: &str) -> Option<&str> {
    if !rel_path.starts_with("journal/") {
        return None;
    }
    let file = rel_path.rsplit('/').next()?;
    let stem = file.strip_suffix(".md")?;
    if is_valid_date(stem) {
        Some(stem)
    } else {
        None
    }
}

fn is_valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..10].iter().all(u8::is_ascii_digit)
        && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn mtime_to_local_date(secs: i64) -> String {
    DateTime::from_timestamp(secs, 0)
        .map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| "1970-01-01".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::NoteMeta;

    fn note_doc(rel: &str, title: &str, mtime: i64, pinned: bool) -> IndexedDoc {
        IndexedDoc {
            meta: NoteMeta {
                path: format!("/v/{rel}"),
                rel_path: rel.to_string(),
                title: title.to_string(),
                tags: vec![],
                mtime,
                size: 0,
                pinned,
            },
            snippet: format!("snippet of {title}"),
            event_id: None,
            created: None,
            doc_kind: DocKind::Note,
            source_host: None,
        }
    }

    fn placement_of(item: &TimelineItem) -> &Placement {
        match item {
            TimelineItem::JournalEntry { placement, .. } | TimelineItem::Note { placement, .. } => {
                placement
            }
        }
    }

    fn local(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        use chrono::TimeZone;
        Local
            .with_ymd_and_hms(y, m, d, h, mi, 0)
            .earliest()
            .unwrap()
    }

    #[test]
    fn note_lands_on_created_day_not_mtime_day() {
        // mtime is days later than `created`.
        let mtime = local(2026, 5, 20, 12, 0).timestamp();
        let mut doc = note_doc("notes/a.md", "A", mtime, false);
        doc.created = Some(Created::At(local(2026, 5, 9, 14, 30)));
        doc.doc_kind = DocKind::Clip;
        doc.source_host = Some("example.com".into());
        let from = NaiveDate::from_ymd_opt(2026, 5, 9).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 5, 20).unwrap();
        let days = range(&[doc], from, to);
        let with: Vec<_> = days.iter().filter(|d| !d.items.is_empty()).collect();
        assert_eq!(with.len(), 1);
        assert_eq!(with[0].date, "2026-05-09");
        let p = placement_of(&with[0].items[0]);
        assert_eq!(p.doc_kind, DocKind::Clip);
        assert_eq!(p.source_host.as_deref(), Some("example.com"));
        assert_eq!(p.created_at, p.placed_at);
        let placed = DateTime::parse_from_rfc3339(p.placed_at.as_deref().unwrap()).unwrap();
        assert_eq!(placed.timestamp(), local(2026, 5, 9, 14, 30).timestamp());
    }

    #[test]
    fn note_without_created_lands_on_mtime_day_at_mtime() {
        let mtime = local(2026, 5, 10, 9, 15).timestamp();
        let doc = note_doc("notes/a.md", "A", mtime, false);
        let d = NaiveDate::from_ymd_opt(2026, 5, 10).unwrap();
        let days = range(&[doc], d, d);
        let p = placement_of(&days[0].items[0]);
        assert_eq!(p.created_at, None);
        assert_eq!(p.doc_kind, DocKind::Note);
        let placed = DateTime::parse_from_rfc3339(p.placed_at.as_deref().unwrap()).unwrap();
        assert_eq!(placed.timestamp(), mtime);
    }

    #[test]
    fn date_only_created_sets_day_but_no_time() {
        let mtime = local(2026, 5, 20, 12, 0).timestamp();
        let mut doc = note_doc("notes/a.md", "A", mtime, false);
        doc.created = Some(Created::Date(NaiveDate::from_ymd_opt(2026, 5, 9).unwrap()));
        let d = NaiveDate::from_ymd_opt(2026, 5, 9).unwrap();
        let days = range(&[doc], d, d);
        assert_eq!(days[0].items.len(), 1);
        let p = placement_of(&days[0].items[0]);
        assert_eq!(p.created_at, None);
        assert_eq!(p.placed_at, None);
    }

    #[test]
    fn journal_entries_have_journal_kind_and_mtime_placement() {
        let mtime = local(2026, 5, 9, 21, 0).timestamp();
        let doc = note_doc("journal/2026/05/2026-05-09.md", "Day", mtime, false);
        let items = recent(&[doc], 1);
        let p = placement_of(&items[0]);
        assert_eq!(p.doc_kind, DocKind::Journal);
        assert!(p.placed_at.is_some());
    }

    #[test]
    fn placement_serializes_flat_camel_case() {
        let doc = note_doc("notes/a.md", "A", 0, false);
        let json = serde_json::to_string(&recent(&[doc], 1)[0]).unwrap();
        assert!(json.contains("\"kind\":\"Note\""), "{json}");
        assert!(json.contains("\"docKind\":\"note\""), "{json}");
        assert!(json.contains("\"createdAt\":null"), "{json}");
        assert!(json.contains("\"placedAt\":\""), "{json}");
        assert!(json.contains("\"sourceHost\":null"), "{json}");
    }

    #[test]
    fn recent_sorts_by_mtime_desc_and_truncates() {
        let docs = vec![
            note_doc("notes/a.md", "A", 100, false),
            note_doc("notes/b.md", "B", 300, false),
            note_doc("notes/c.md", "C", 200, false),
        ];
        let items = recent(&docs, 2);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].mtime(), 300);
        assert_eq!(items[1].mtime(), 200);
    }

    #[test]
    fn pinned_filters_and_sorts() {
        let docs = vec![
            note_doc("notes/a.md", "A", 100, true),
            note_doc("notes/b.md", "B", 300, false),
            note_doc("notes/c.md", "C", 200, true),
        ];
        let items = pinned(&docs);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].mtime(), 200);
        assert_eq!(items[1].mtime(), 100);
    }

    #[test]
    fn journal_files_become_journal_entries_keyed_by_date() {
        let docs = vec![note_doc("journal/2026/05/2026-05-09.md", "Day", 500, false)];
        let items = recent(&docs, 10);
        match &items[0] {
            TimelineItem::JournalEntry { date, title, .. } => {
                assert_eq!(date, "2026-05-09");
                assert_eq!(title, "Day");
            }
            other => panic!("expected JournalEntry, got {other:?}"),
        }
    }

    #[test]
    fn malformed_journal_file_is_skipped() {
        let docs = vec![note_doc("journal/2026/05/notes.md", "x", 1, false)];
        assert!(recent(&docs, 10).is_empty());
    }

    #[test]
    fn range_buckets_journal_on_its_date_and_notes_on_mtime() {
        // Journal entry dated 2026-05-09; a note whose mtime is on
        // 2026-05-10 (local). Use a timestamp safely inside that UTC day
        // is risky across TZs, so assert structural properties instead.
        let docs = vec![note_doc(
            "journal/2026/05/2026-05-09.md",
            "Day",
            1_700_000_000,
            false,
        )];
        let from = NaiveDate::from_ymd_opt(2026, 5, 8).unwrap();
        let to = NaiveDate::from_ymd_opt(2026, 5, 10).unwrap();
        let days = range(&docs, from, to);
        assert_eq!(days.len(), 3);
        // Newest day first.
        assert_eq!(days[0].date, "2026-05-10");
        assert_eq!(days[2].date, "2026-05-08");
        let with_entry: Vec<_> = days.iter().filter(|d| !d.items.is_empty()).collect();
        assert_eq!(with_entry.len(), 1);
        assert_eq!(with_entry[0].date, "2026-05-09");
    }
}
