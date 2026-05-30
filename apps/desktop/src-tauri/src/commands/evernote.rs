//! Evernote import IPC.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::domain::{AppError, EvernoteImportReport};
use crate::services::index::TagIndex;
use crate::services::vault_lock::VaultLocks;
use crate::services::{config, evernote};

/// Progress event pushed to the frontend during a multi-file import.
/// Emitted on the `evernote-import-progress` channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    /// 0-based index of the file currently being imported.
    file_index: usize,
    total_files: usize,
    file_name: String,
    /// Notes written so far in the current file.
    note_done: usize,
    /// Total notes in the current file (known after parsing).
    note_total: usize,
}

const PROGRESS_EVENT: &str = "evernote-import-progress";

/// Open a native file dialog filtered to `.enex`, then import every
/// selected file into the active vault. Returns a merged report.
/// Cancelling the dialog yields `AppError::Cancelled` so the UI can
/// tell the difference from an actual failure.
#[tauri::command]
pub async fn evernote_import<R: Runtime>(
    app: AppHandle<R>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
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
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let total_files = paths.len();
    let mut merged = EvernoteImportReport::default();
    for (file_index, fp) in paths.into_iter().enumerate() {
        let p: PathBuf = fp
            .into_path()
            .map_err(|e| AppError::InvalidPath(e.to_string()))?;
        let file_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        // Emit a note-level progress event, throttled to ~100 updates
        // per file so a 10k-note import doesn't flood the IPC channel.
        let app = app.clone();
        let mut last_emitted = usize::MAX;
        let on_progress = |done: usize, total: usize| {
            let step = (total / 100).max(1);
            if done == 0 || done == total || done.saturating_sub(last_emitted) >= step {
                last_emitted = done;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    ImportProgress {
                        file_index,
                        total_files,
                        file_name: file_name.clone(),
                        note_done: done,
                        note_total: total,
                    },
                );
            }
        };

        match evernote::import_enex_with_progress(&vault_root, &p, on_progress) {
            Ok(r) => merge_report(&mut merged, r),
            Err(e) => {
                merged.failed_count += 1;
                merged
                    .errors
                    .push(format!("{}: {e}", p.display()));
            }
        }
    }
    // Import may partially succeed; invalidate if any note landed on disk.
    if merged.imported_count > 0 {
        index.invalidate(&vault_root);
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
