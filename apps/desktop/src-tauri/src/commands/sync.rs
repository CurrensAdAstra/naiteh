//! Sync IPC commands — see vault/wiki/ipc-api.md ("Sync") and
//! vault/wiki/concurrency-safety.md.
//!
//! User-facing wording stays in the frontend; this file is allowed to
//! reference git plumbing because it sits below the IPC boundary.
//!
//! Threading / locking model:
//!   - Every command is `async` and runs its blocking git / filesystem
//!     work on the blocking pool (`tauri::async_runtime::spawn_blocking`),
//!     never on the main thread or an async worker.
//!   - Sync operations are serialized against each other by a process-wide
//!     sync gate, so two syncs never interleave their phases.
//!   - The per-vault lock (shared with note writes) is held only around the
//!     *local* phases (commit, merge/checkout, state writes). The network
//!     phases (fetch, push) run without it, so saving a note never waits
//!     on a slow or unreachable remote.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex as AsyncMutex;

use crate::domain::{AppError, SyncStatus};
use crate::services::config;
use crate::services::conflicts::{self, ConflictPair};
use crate::services::git::{self, LocalChanges};
use crate::services::hooks;
use crate::services::index::TagIndex;
use crate::services::session::{require_session, ActiveSession};
use crate::services::sync_state;
use crate::services::vault_lock::VaultLocks;

/// Serializes sync operations (init / set_remote / pull / push / now).
fn sync_gate() -> &'static AsyncMutex<()> {
    static GATE: OnceLock<AsyncMutex<()>> = OnceLock::new();
    GATE.get_or_init(|| AsyncMutex::new(()))
}

/// Run blocking work on the blocking thread pool.
async fn blocking<T, F>(f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(format!("background task failed: {e}")))?
}

async fn vault_root() -> Result<PathBuf, AppError> {
    blocking(config::current_vault_root).await
}

#[tauri::command]
pub async fn sync_status(active: tauri::State<'_, ActiveSession>) -> Result<SyncStatus, AppError> {
    require_session(&active)?;
    blocking(|| {
        let vault_root = config::current_vault_root()?;
        sync_status_impl(&vault_root)
    })
    .await
}

fn sync_status_impl(vault_root: &Path) -> Result<SyncStatus, AppError> {
    let state = sync_state::load(vault_root)?;
    git::status(vault_root, state.last_sync, state.pending_merge.is_some())
}

#[tauri::command]
pub async fn sync_init(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let _gate = sync_gate().lock().await;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    blocking(move || git::init(&vault_root)).await
}

#[tauri::command]
pub async fn sync_set_remote(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    url: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let _gate = sync_gate().lock().await;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    blocking(move || git::set_remote(&vault_root, url.trim())).await
}

/// Shared pipeline for `sync_pull` / `sync_now`. Returns whether a push is
/// still wanted (i.e. a remote is configured).
async fn fetch_and_integrate(
    locks: &VaultLocks,
    index: &TagIndex,
    vault_root: &Path,
    mode: LocalChanges,
) -> Result<bool, AppError> {
    let lock = locks.for_vault(vault_root);

    // Phase 1 (locked): finish a resolved merge, commit / check local edits.
    let plan = {
        let _guard = lock.lock().await;
        let root = vault_root.to_path_buf();
        let result = blocking(move || git::prepare(&root, mode)).await;
        // Finalizing a merge doesn't change file contents, but stay honest.
        index.invalidate(vault_root);
        result?
    };
    if !plan.has_remote {
        return match mode {
            LocalChanges::RequireClean => Err(AppError::NotFound(
                "no backup destination configured".into(),
            )),
            LocalChanges::Commit => Ok(false),
        };
    }

    // Phase 2 (unlocked): network fetch.
    let fetched = {
        let root = vault_root.to_path_buf();
        let plan = plan.clone();
        blocking(move || git::fetch(&root, &plan)).await?
    };

    // Phase 3 (locked): merge / fast-forward / join.
    if let Some(remote_oid) = fetched {
        let _guard = lock.lock().await;
        let root = vault_root.to_path_buf();
        let result = blocking(move || git::integrate(&root, &plan, remote_oid, mode)).await;
        // Integration touches arbitrary files; invalidate even on failure
        // since a conflict still leaves sidecar files on disk.
        index.invalidate(vault_root);
        result?;
    }
    Ok(true)
}

async fn record_sync_locked(locks: &VaultLocks, vault_root: &Path) -> Result<SyncStatus, AppError> {
    let lock = locks.for_vault(vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.to_path_buf();
    blocking(move || {
        record_sync(&root)?;
        sync_status_impl(&root)
    })
    .await
}

#[tauri::command]
pub async fn sync_pull(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
) -> Result<SyncStatus, AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let _gate = sync_gate().lock().await;
    fetch_and_integrate(&locks, &index, &vault_root, LocalChanges::RequireClean).await?;
    record_sync_locked(&locks, &vault_root).await
}

#[tauri::command]
pub async fn sync_push(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
) -> Result<SyncStatus, AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let _gate = sync_gate().lock().await;
    {
        // Network phase: no vault lock.
        let root = vault_root.clone();
        blocking(move || git::push(&root)).await?;
    }
    record_sync_locked(&locks, &vault_root).await
}

#[tauri::command]
pub async fn sync_now(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
) -> Result<SyncStatus, AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let _gate = sync_gate().lock().await;
    let has_remote = fetch_and_integrate(&locks, &index, &vault_root, LocalChanges::Commit).await?;
    if has_remote {
        // Network phase: no vault lock.
        let root = vault_root.clone();
        blocking(move || git::push(&root)).await?;
    }
    let status = record_sync_locked(&locks, &vault_root).await?;
    if let Ok(config_dir) = config::default_app_config_dir() {
        hooks::fire(&config_dir, hooks::HookEvent::Sync, &vault_root, None);
    }
    Ok(status)
}

#[tauri::command]
pub async fn sync_list_conflicts(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<ConflictPair>, AppError> {
    require_session(&active)?;
    blocking(|| {
        let vault_root = config::current_vault_root()?;
        conflicts::list(&vault_root)
    })
    .await
}

/// After a resolution, record the pending merge locally as soon as its
/// last sidecar is gone (best-effort: the next sync retries anyway).
fn finalize_after_resolve(vault_root: &Path) {
    if let Err(e) = git::finalize_pending_merge(vault_root) {
        eprintln!("naiteh: could not record resolved merge yet: {e}");
    }
}

#[tauri::command]
pub async fn sync_resolve_keep_ours(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    conflict_rel_path: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = blocking(move || {
        conflicts::resolve_keep_ours(&root, &conflict_rel_path)?;
        finalize_after_resolve(&root);
        Ok(())
    })
    .await;
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
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    conflict_rel_path: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = vault_root().await?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    // keep_theirs overwrites the live note's bytes, which can change its
    // front-matter tags — invalidate so Tags reflects the new content.
    let result = blocking(move || {
        conflicts::resolve_keep_theirs(&root, &conflict_rel_path)?;
        finalize_after_resolve(&root);
        Ok(())
    })
    .await;
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
        assert!(!s.merge_pending);
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

    #[tokio::test]
    async fn pipeline_commits_without_remote_and_locks_are_released() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        git::init(v.path()).unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x v2").unwrap();

        let locks = VaultLocks::default();
        let index = TagIndex::default();
        let has_remote = fetch_and_integrate(&locks, &index, v.path(), LocalChanges::Commit)
            .await
            .unwrap();
        assert!(!has_remote);
        let s = record_sync_locked(&locks, v.path()).await.unwrap();
        assert!(!s.dirty);
        assert!(s.last_sync.is_some());
        // Vault lock is free again.
        assert!(locks.for_vault(v.path()).try_lock().is_ok());

        // Pull without a remote is a clear NotFound.
        let err = fetch_and_integrate(&locks, &index, v.path(), LocalChanges::RequireClean)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
