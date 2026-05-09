use serde::{Deserialize, Serialize};

/// architecture.md §6.4
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub initialized: bool,
}

/// architecture.md §6.1
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

/// architecture.md §6.1
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalOpenResult {
    pub path: String,
    pub content: String,
    pub exists: bool,
}

/// architecture.md §6.1
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalSaveResult {
    pub path: String,
    pub mtime: i64,
}

/// architecture.md §6.3 — one entry per date in a `timeline_range` query,
/// even when the date has no items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDay {
    pub date: String,
    pub items: Vec<TimelineItem>,
}

/// architecture.md §6.2
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub mtime: i64,
    pub size: u64,
    pub pinned: bool,
}

/// architecture.md §6.3 — used by both journal "Recent Activity" and the
/// calendar timeline. Variants stay in PascalCase so `kind` reads as
/// `"JournalEntry"` / `"Note"` on the wire; fields are camelCased per
/// architecture.md §6.
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
