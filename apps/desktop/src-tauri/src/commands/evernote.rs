//! Evernote import IPC.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::domain::{AppError, EvernoteImportReport};
use crate::services::fs as fsx;
use crate::services::index::TagIndex;
use crate::services::session::{require_session, ActiveSession};
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
    active: tauri::State<'_, ActiveSession>,
    app: AppHandle<R>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
) -> Result<EvernoteImportReport, AppError> {
    require_session(&active)?;
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

    let paths: Vec<PathBuf> = paths
        .into_iter()
        .map(|fp| {
            fp.into_path()
                .map_err(|e| AppError::InvalidPath(e.to_string()))
        })
        .collect::<Result<_, _>>()?;

    let vault_root = config::current_vault_root()?;
    // The vault lock is taken **per note** inside the import (via
    // `blocking_lock` on the blocking thread), not for the whole run, so
    // autosave and other writes interleave instead of stalling for the
    // length of a multi-thousand-note import.
    let lock = locks.for_vault(&vault_root);
    let index = index.inner().clone();
    fsx::run_blocking(move || Ok(import_files(&app, &vault_root, &lock, &index, paths))).await
}

/// Blocking body of `evernote_import`: imports each file in turn,
/// emitting throttled progress and taking the vault lock per note.
fn import_files<R: Runtime>(
    app: &AppHandle<R>,
    vault_root: &Path,
    lock: &AsyncMutex<()>,
    index: &TagIndex,
    paths: Vec<PathBuf>,
) -> EvernoteImportReport {
    let total_files = paths.len();
    let mut merged = EvernoteImportReport::default();
    for (file_index, p) in paths.into_iter().enumerate() {
        let file_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        // Emit a note-level progress event, throttled to ~100 updates
        // per file so a 10k-note import doesn't flood the IPC channel.
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

        // We're on a blocking-pool thread, so `blocking_lock` is safe.
        let acquire = move || lock.blocking_lock();
        match evernote::import_enex_with_progress(vault_root, &p, acquire, on_progress) {
            Ok(r) => merge_report(&mut merged, r),
            Err(e) => {
                merged.failed_count += 1;
                merged.errors.push(format!("{}: {e}", p.display()));
            }
        }
        // Notes from this file are on disk; make tags/search/timeline
        // see them now rather than only after the last file.
        if merged.imported_count > 0 {
            index.invalidate(vault_root);
        }
    }
    merged
}

fn merge_report(into: &mut EvernoteImportReport, from: EvernoteImportReport) {
    into.imported_count += from.imported_count;
    into.skipped_count += from.skipped_count;
    into.failed_count += from.failed_count;
    into.notes.extend(from.notes);
    into.errors.extend(from.errors);
}
