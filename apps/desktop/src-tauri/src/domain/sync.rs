//! Sync status — see vault/wiki/domain-model.md ("Sync"). The
//! conflict-pair type lives with its logic in `services::conflicts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub remote_url: Option<String>,
    pub branch: String,
    pub ahead: u32,
    pub behind: u32,
    /// Uncommitted changes in the working tree (conflict sidecars excluded).
    pub dirty: bool,
    pub last_sync: Option<i64>,
    /// A pull stopped on conflicting edits and is waiting for the user to
    /// resolve its conflict sidecars; the next sync after that records the
    /// merge and uploads it.
    #[serde(default)]
    pub merge_pending: bool,
}
