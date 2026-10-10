//! Tiny per-vault key/value store for sync metadata that doesn't belong in
//! git history. Lives at `<vault>/.naiteh/sync-state.json`, which
//! `services::git::ensure_gitignore` keeps out of git.
//!
//! Holds:
//!   - `last_sync` — unix seconds of the last successful sync.
//!   - `pending_merge` — set when a pull stopped on conflicting edits. It
//!     records the remote commit being merged plus the conflict sidecars
//!     written for that pull. Once every listed sidecar is gone (the user
//!     picked "Keep mine" / "Keep theirs", or deleted it by hand), the next
//!     sync records a merge commit whose parents are the local head and
//!     this remote commit, with the working tree as the resolved content.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::fs as fsx;

const FILE: &str = "sync-state.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncState {
    pub last_sync: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_merge: Option<PendingMerge>,
}

/// A pull that stopped on conflicts and is waiting for the user.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PendingMerge {
    /// Hex OID of the fetched remote head being merged.
    pub remote_oid: String,
    /// Vault-relative (`/`-separated) sidecar paths written for this pull.
    pub sidecars: Vec<String>,
    /// When the conflict was detected (unix seconds).
    pub created_at: i64,
}

fn path_for(vault_root: &Path) -> PathBuf {
    vault_root.join(".naiteh").join(FILE)
}

pub fn load(vault_root: &Path) -> Result<SyncState, AppError> {
    let path = path_for(vault_root);
    match fsx::read_json::<SyncState>(&path) {
        Ok(state) => Ok(state),
        Err(AppError::NotFound(_)) => Ok(SyncState::default()),
        Err(e) => Err(e),
    }
}

pub fn save(vault_root: &Path, state: &SyncState) -> Result<(), AppError> {
    let dir = vault_root.join(".naiteh");
    fsx::ensure_dir(&dir)?;
    fsx::write_json(&path_for(vault_root), state)
}

/// Record a successful sync, preserving any other state.
pub fn record_sync(vault_root: &Path, unix_seconds: i64) -> Result<(), AppError> {
    let mut state = load(vault_root)?;
    state.last_sync = Some(unix_seconds);
    save(vault_root, &state)
}

pub fn set_pending_merge(vault_root: &Path, pending: PendingMerge) -> Result<(), AppError> {
    let mut state = load(vault_root)?;
    state.pending_merge = Some(pending);
    save(vault_root, &state)
}

pub fn clear_pending_merge(vault_root: &Path) -> Result<(), AppError> {
    let mut state = load(vault_root)?;
    if state.pending_merge.take().is_some() {
        save(vault_root, &state)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_returns_default_when_missing() {
        let v = tempdir().unwrap();
        assert_eq!(load(v.path()).unwrap(), SyncState::default());
    }

    #[test]
    fn save_then_load_round_trip() {
        let v = tempdir().unwrap();
        save(
            v.path(),
            &SyncState {
                last_sync: Some(1_700_000_000),
                pending_merge: None,
            },
        )
        .unwrap();
        let back = load(v.path()).unwrap();
        assert_eq!(back.last_sync, Some(1_700_000_000));
    }

    #[test]
    fn record_sync_updates_timestamp() {
        let v = tempdir().unwrap();
        record_sync(v.path(), 42).unwrap();
        assert_eq!(load(v.path()).unwrap().last_sync, Some(42));
        record_sync(v.path(), 99).unwrap();
        assert_eq!(load(v.path()).unwrap().last_sync, Some(99));
    }

    #[test]
    fn record_sync_preserves_pending_merge() {
        let v = tempdir().unwrap();
        let pending = PendingMerge {
            remote_oid: "abc".into(),
            sidecars: vec!["notes/a.conflict-ts.md".into()],
            created_at: 1,
        };
        set_pending_merge(v.path(), pending.clone()).unwrap();
        record_sync(v.path(), 5).unwrap();
        let s = load(v.path()).unwrap();
        assert_eq!(s.pending_merge, Some(pending));
        assert_eq!(s.last_sync, Some(5));
        clear_pending_merge(v.path()).unwrap();
        let s = load(v.path()).unwrap();
        assert_eq!(s.pending_merge, None);
        assert_eq!(s.last_sync, Some(5));
    }

    #[test]
    fn legacy_file_without_pending_merge_still_loads() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&path_for(v.path()), br#"{ "lastSync": 3 }"#).unwrap();
        let s = load(v.path()).unwrap();
        assert_eq!(s.last_sync, Some(3));
        assert!(s.pending_merge.is_none());
    }

    #[test]
    fn camel_case_serialization() {
        let s = SyncState {
            last_sync: Some(7),
            pending_merge: Some(PendingMerge {
                remote_oid: "x".into(),
                sidecars: vec![],
                created_at: 2,
            }),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"lastSync\":7"));
        assert!(json.contains("\"pendingMerge\""));
        assert!(json.contains("\"remoteOid\":\"x\""));
        assert!(json.contains("\"createdAt\":2"));
    }
}
