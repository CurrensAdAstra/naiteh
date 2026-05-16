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

/// architecture.md §6.5
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}

/// architecture.md §6.5
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel_path: String,
    pub title: String,
    pub line: u32,
    pub excerpt: String,
}

/// architecture.md §6.6
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub remote_url: Option<String>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    pub dirty: bool,
    pub last_sync: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImport {
    pub rel_path: String,
    pub file_name: String,
    pub markdown: String,
}

/// architecture.md §6.8
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum UserRole {
    Admin,
    User,
}

/// architecture.md §6.8 — public account shape returned to the frontend.
/// Password hashes stay backend-only in the auth service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub username: String,
    pub role: UserRole,
    pub active: bool,
}

/// architecture.md §6.8
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub username: String,
    pub role: UserRole,
}

/// architecture.md §6.8
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub timestamp: String,
    pub username: String,
    pub action: String,
    pub detail: Option<String>,
}

/// RAG source status for the managed Korean statutes repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegalDocsStatus {
    pub repo_url: String,
    pub local_path: String,
    pub docs_path: String,
    pub installed: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub document_count: u32,
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

/// Result of importing one or more `.enex` files. Returned to the
/// frontend so the Settings panel can show a "imported N notes, M
/// warnings" card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EvernoteImportReport {
    pub imported_count: u32,
    pub skipped_count: u32,
    pub failed_count: u32,
    pub notes: Vec<EvernoteImportedNote>,
    /// File-level errors (e.g. a malformed .enex). Per-note problems
    /// surface as warnings on the note itself.
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvernoteImportedNote {
    /// Original Evernote title (pre-slugification).
    pub source_title: String,
    /// Vault-relative path of the imported note (`notes/<nb>/<slug>/index.md`).
    pub rel_path: String,
    pub warnings: Vec<String>,
}
