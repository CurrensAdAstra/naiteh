//! Attachment IPC commands.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::domain::{AppError, AttachmentImport};
use crate::services::fs as fsx;
use crate::services::session::{require_session, ActiveSession};
use crate::services::vault_lock::VaultLocks;
use crate::services::{attachments, config};

#[tauri::command]
pub async fn attachments_import<R: Runtime>(
    active: tauri::State<'_, ActiveSession>,
    app: AppHandle<R>,
    locks: tauri::State<'_, VaultLocks>,
) -> Result<AttachmentImport, AppError> {
    require_session(&active)?;
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
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    // Up to 50 MiB of copy — keep it off the async runtime threads.
    fsx::run_blocking(move || attachments::import(&vault_root, &source)).await
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
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    bytes: Vec<u8>,
    suggested_name: String,
    mime: Option<String>,
) -> Result<AttachmentImport, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    fsx::run_blocking(move || {
        attachments::import_bytes(&vault_root, &bytes, &suggested_name, mime.as_deref())
    })
    .await
}

/// Read a vault image for the Markdown viewer as a `data:` URL.
///
/// `candidates` are vault-relative paths tried in order (see
/// `attachments::read_image_data_url`). Read-only, so no vault lock;
/// gated like every other vault command.
#[tauri::command]
pub async fn attachments_read_image(
    active: tauri::State<'_, ActiveSession>,
    candidates: Vec<String>,
) -> Result<String, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    fsx::run_blocking(move || attachments::read_image_data_url(&vault_root, &candidates)).await
}
