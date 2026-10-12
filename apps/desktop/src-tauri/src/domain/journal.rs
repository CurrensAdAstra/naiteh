//! Journal, calendar, and timeline types — see vault/wiki/domain-model.md
//! ("Journal", "Activity / Timeline").

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayMeta {
    pub date: String,
    pub has_entry: bool,
    pub path: Option<String>,
    pub mtime: Option<i64>,
    pub title: Option<String>,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOpenResult {
    pub path: String,
    pub content: String,
    pub exists: bool,
    /// Version (hex SHA-256) of the bytes read; `""` when `exists` is
    /// false. Passed back to `journal_save` as `expected_version`.
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSaveResult {
    pub path: String,
    pub mtime: i64,
    /// Version of the bytes just written.
    pub version: String,
}

/// One entry per date in a `timeline_range` query, even when the date
/// has no items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDay {
    pub date: String,
    pub items: Vec<TimelineItem>,
}

/// Used by both journal "Recent Activity" and the calendar timeline.
/// Variants stay PascalCase so `kind` reads as `"JournalEntry"` /
/// `"Note"` on the wire; fields are camelCased.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TimelineItem {
    #[serde(rename_all = "camelCase")]
    JournalEntry {
        date: String,
        path: String,
        mtime: i64,
        title: String,
        snippet: String,
        #[serde(flatten)]
        placement: Placement,
    },
    #[serde(rename_all = "camelCase")]
    Note {
        rel_path: String,
        title: String,
        mtime: i64,
        snippet: String,
        pinned: bool,
        #[serde(flatten)]
        placement: Placement,
    },
}

/// What kind of document a timeline item is, for the day timeline's
/// marker icon. Wire values: `"note"`, `"clip"`, `"journal"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    #[default]
    Note,
    /// A web clipping: front matter has `source_url`, `clip_type`, or
    /// `imported_from: web-clipper`.
    Clip,
    Journal,
}

/// Where a timeline item sits on the day timeline (see
/// vault/wiki/ipc-api.md, "timeline_range"). Flattened into both
/// `TimelineItem` variants. Local-only: never sent to any calendar.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// Front-matter `created` with a time of day, as RFC 3339 in the
    /// local offset. `None` when absent, unparseable, or date-only.
    pub created_at: Option<String>,
    /// Time the item is drawn at (RFC 3339, local offset): `created_at`
    /// if present, else the file mtime. `None` when `created` is
    /// date-only — the item then has a day but no time (all-day chip).
    pub placed_at: Option<String>,
    pub doc_kind: DocKind,
    /// Host of the front-matter `source_url` (clips), e.g. `example.com`.
    pub source_host: Option<String>,
}

impl TimelineItem {
    pub fn mtime(&self) -> i64 {
        match self {
            TimelineItem::JournalEntry { mtime, .. } | TimelineItem::Note { mtime, .. } => *mtime,
        }
    }
}
