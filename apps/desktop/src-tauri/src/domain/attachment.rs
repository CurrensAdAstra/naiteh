//! Attachment import result — see vault/wiki/domain-model.md ("Attachments, Workspace, Evernote import").

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImport {
    pub rel_path: String,
    pub file_name: String,
    pub markdown: String,
}
