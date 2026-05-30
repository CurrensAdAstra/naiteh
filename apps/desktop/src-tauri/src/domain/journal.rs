//! Journal, calendar, and timeline types — see architecture.md §6.1 / §6.3.

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSaveResult {
    pub path: String,
    pub mtime: i64,
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
    },
    #[serde(rename_all = "camelCase")]
    Note {
        rel_path: String,
        title: String,
        mtime: i64,
        snippet: String,
        pinned: bool,
    },
}

impl TimelineItem {
    pub fn mtime(&self) -> i64 {
        match self {
            TimelineItem::JournalEntry { mtime, .. } | TimelineItem::Note { mtime, .. } => *mtime,
        }
    }
}
