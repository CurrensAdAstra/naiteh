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

/// Import an attachment from raw bytes — used by the editor's clipboard
/// paste and drag-and-drop handlers, where the source is a browser
/// `File` / `ClipboardItem` object that lives in memory, not on disk.
///
/// `suggested_name` is the original filename if known (drag-drop) or
/// empty (clipboard paste). `mime` is the type the browser reports;
/// the service falls back to a timestamped name with a MIME-derived
/// extension when the suggestion is unusable.
#[tauri::command]
pub async fn attachments_import_bytes(
    bytes: Vec<u8>,
    suggested_name: String,
    mime: Option<String>,
) -> Result<AttachmentImport, AppError> {
    let vault_root = config::current_vault_root()?;
    attachments::import_bytes(
        &vault_root,
        &bytes,
        &suggested_name,
        mime.as_deref(),
    )
}
