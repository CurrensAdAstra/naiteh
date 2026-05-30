//! Evernote import report types — see architecture.md §6.9.

use serde::{Deserialize, Serialize};

/// Result of importing one or more `.enex` files. Returned to the
/// frontend so the Settings panel can show an "imported N notes, M
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
