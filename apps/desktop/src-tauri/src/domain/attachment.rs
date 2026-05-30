//! Attachment import result — see architecture.md §6.9.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImport {
    pub rel_path: String,
    pub file_name: String,
    pub markdown: String,
}
