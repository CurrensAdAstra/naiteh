//! Note metadata — see vault/wiki/domain-model.md ("Notes").

use serde::{Deserialize, Serialize};

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

/// What `notes_read` returns: the file's text plus the **version** of the
/// bytes it was read from (lowercase hex SHA-256 — see
/// `services::notes::file_version`). The frontend hands that version back
/// to `notes_write` as `expected_version` so a save can't overwrite a
/// newer copy that arrived on disk from outside the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDocument {
    pub content: String,
    pub version: String,
}

/// What `notes_write` returns: the refreshed metadata and the version of
/// the bytes just written (what the next `notes_write` should expect).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWriteResult {
    pub meta: NoteMeta,
    pub version: String,
}
