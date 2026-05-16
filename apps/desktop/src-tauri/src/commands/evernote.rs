//! Evernote import IPC.

use std::path::PathBuf;

use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::domain::{AppError, EvernoteImportReport};
use crate::services::{config, evernote};

/// Open a native file dialog filtered to `.enex`, then import every
/// selected file into the active vault. Returns a merged report.
/// Cancelling the dialog yields `AppError::Cancelled` so the UI can
/// tell the difference from an actual failure.
#[tauri::command]
pub async fn evernote_import<R: Runtime>(
    app: AppHandle<R>,
) -> Result<EvernoteImportReport, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Evernote export", &["enex"])
        .pick_files(move |files| {
            let _ = tx.send(files);
        });
    let picked = rx
        .await
        .map_err(|e| AppError::Io(format!("dialog channel closed: {e}")))?;
    let Some(paths) = picked else {
        return Err(AppError::Cancelled);
    };
    if paths.is_empty() {
        return Err(AppError::Cancelled);
    }

    let vault_root = config::current_vault_root()?;
    let mut merged = EvernoteImportReport::default();
    for fp in paths {
        let p: PathBuf = fp
            .into_path()
            .map_err(|e| AppError::InvalidPath(e.to_string()))?;
        match evernote::import_enex(&vault_root, &p) {
            Ok(r) => merge_report(&mut merged, r),
            Err(e) => {
                merged.failed_count += 1;
                merged
                    .errors
                    .push(format!("{}: {e}", p.display()));
            }
        }
    }
    Ok(merged)
}

fn merge_report(into: &mut EvernoteImportReport, from: EvernoteImportReport) {
    into.imported_count += from.imported_count;
    into.skipped_count += from.skipped_count;
    into.failed_count += from.failed_count;
    into.notes.extend(from.notes);
    into.errors.extend(from.errors);
}
