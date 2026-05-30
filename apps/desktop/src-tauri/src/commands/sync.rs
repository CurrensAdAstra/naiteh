//! Sync IPC commands — see architecture.md §7.7 / §9.
//!
//! User-facing wording stays in the frontend; this file is allowed to
//! reference git plumbing because it sits below the IPC boundary.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::{AppError, SyncStatus};
use crate::services::config;
use crate::services::conflicts::{self, ConflictPair};
use crate::services::git;
use crate::services::index::TagIndex;
use crate::services::sync_state;
use crate::services::vault_lock::VaultLocks;

#[tauri::command]
pub fn sync_status() -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    sync_status_impl(&vault_root)
}

fn sync_status_impl(vault_root: &Path) -> Result<SyncStatus, AppError> {
    let last_sync = sync_state::load(vault_root)?.last_sync;
    git::status(vault_root, last_sync)
}

#[tauri::command]
pub async fn sync_init(
    locks: tauri::State<'_, VaultLocks>,
) -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    git::init(&vault_root)
}

#[tauri::command]
pub async fn sync_set_remote(
    locks: tauri::State<'_, VaultLocks>,
    url: String,
) -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    git::set_remote(&vault_root, url.trim())
}

#[tauri::command]
pub async fn sync_pull(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
) -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let pull_result = git::pull_ff_only(&vault_root);
    // Pulls touch arbitrary files; invalidate even on partial failure
    // since a conflict still leaves sidecar files on disk.
    index.invalidate(&vault_root);
    pull_result?;
    record_sync(&vault_root)?;
    sync_status_impl(&vault_root)
}

#[tauri::command]
pub async fn sync_push(
    locks: tauri::State<'_, VaultLocks>,
) -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    git::push(&vault_root)?;
    record_sync(&vault_root)?;
    sync_status_impl(&vault_root)
}

#[tauri::command]
pub async fn sync_now(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
) -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let sync_result = git::sync_now(&vault_root);
    index.invalidate(&vault_root);
    sync_result?;
    record_sync(&vault_root)?;
    sync_status_impl(&vault_root)
}

#[tauri::command]
pub fn sync_list_conflicts() -> Result<Vec<ConflictPair>, AppError> {
    let vault_root = config::current_vault_root()?;
    conflicts::list(&vault_root)
}

#[tauri::command]
pub async fn sync_resolve_keep_ours(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    conflict_rel_path: String,
) -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = conflicts::resolve_keep_ours(&vault_root, &conflict_rel_path);
    // Removing a sidecar can't change the live file's tags, but invalidate
    // anyway to stay honest if the live file was edited out-of-band
    // between list and resolve.
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

#[tauri::command]
pub async fn sync_resolve_keep_theirs(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    conflict_rel_path: String,
) -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    // keep_theirs overwrites the live note's bytes, which can change its
    // front-matter tags — invalidate so Tags reflects the new content.
    let result = conflicts::resolve_keep_theirs(&vault_root, &conflict_rel_path);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn record_sync(vault_root: &Path) -> Result<(), AppError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    sync_state::record_sync(vault_root, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::fs as fsx;
    use tempfile::tempdir;

    #[test]
    fn sync_status_propagates_persisted_last_sync() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        git::init(v.path()).unwrap();
        sync_state::record_sync(v.path(), 1_700_000_000).unwrap();

        let s = sync_status_impl(v.path()).unwrap();
        assert_eq!(s.last_sync, Some(1_700_000_000));
        assert!(!s.dirty);
    }

    #[test]
    fn sync_now_with_no_remote_just_commits_locally() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        git::init(v.path()).unwrap();

        fsx::atomic_write(&v.path().join("notes/x.md"), b"x v2").unwrap();
        git::sync_now(v.path()).unwrap();
        record_sync(v.path()).unwrap();

        let s = sync_status_impl(v.path()).unwrap();
        assert!(!s.dirty);
        assert!(s.last_sync.is_some());
    }
}
