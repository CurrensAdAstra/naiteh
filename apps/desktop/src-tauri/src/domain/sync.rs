//! Sync status — see architecture.md §6.6. The conflict-pair type lives
//! with its logic in `services::conflicts`.

use serde::{Deserialize, Serialize};

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
