//! Attachment IPC commands.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::domain::{AppError, AttachmentImport};
use crate::services::{attachments, config};

#[tauri::command]
pub async fn attachments_import<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AttachmentImport, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |file| {
        let _ = tx.send(file);
    });
    let picked = rx
        .await
        .map_err(|e| AppError::Io(format!("dialog channel closed: {e}")))?;
    let Some(path) = picked else {
        return Err(AppError::Cancelled);
    };
    let source: PathBuf = path
        .into_path()
        .map_err(|e| AppError::InvalidPath(e.to_string()))?;
    let vault_root = config::current_vault_root()?;
    attachments::import(&vault_root, &source)
}
