//! Tiny per-vault key/value store for sync metadata that doesn't belong in
//! git history (last successful sync timestamp). Lives at
//! `<vault>/.naiteh/sync-state.json`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::fs as fsx;

const FILE: &str = "sync-state.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncState {
    pub last_sync: Option<i64>,
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

pub fn record_sync(vault_root: &Path, unix_seconds: i64) -> Result<(), AppError> {
    save(
        vault_root,
        &SyncState {
            last_sync: Some(unix_seconds),
        },
    )
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
    fn camel_case_serialization() {
        let s = SyncState { last_sync: Some(7) };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"lastSync\":7"));
    }
}
