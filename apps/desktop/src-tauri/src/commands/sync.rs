//! Sync IPC commands — see architecture.md §7.7 / §9.
//!
//! User-facing wording stays in the frontend; this file is allowed to
//! reference git plumbing because it sits below the IPC boundary.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::domain::{AppError, SyncStatus};
use crate::services::config;
use crate::services::git;
use crate::services::sync_state;

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
pub fn sync_init() -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    git::init(&vault_root)
}

#[tauri::command]
pub fn sync_set_remote(url: String) -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    git::set_remote(&vault_root, url.trim())
}

#[tauri::command]
pub fn sync_pull() -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    git::pull_ff_only(&vault_root)?;
    record_sync(&vault_root)?;
    sync_status_impl(&vault_root)
}

#[tauri::command]
pub fn sync_push() -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    git::push(&vault_root)?;
    record_sync(&vault_root)?;
    sync_status_impl(&vault_root)
}

#[tauri::command]
pub fn sync_now() -> Result<SyncStatus, AppError> {
    let vault_root = config::current_vault_root()?;
    git::sync_now(&vault_root)?;
    record_sync(&vault_root)?;
    sync_status_impl(&vault_root)
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
