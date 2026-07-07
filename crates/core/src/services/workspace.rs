//! Per-vault machine-local UI state (e.g. "last opened file"). Lives at
//! `<vault>/.naiteh/workspace.json`. Same gitignore treatment as
//! sync-state.json — see services/git.rs::ensure_gitignore.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::fs as fsx;

const FILE: &str = "workspace.json";

/// Variants stay PascalCase on the wire (matches the convention we use for
/// TimelineItem); field names inside each variant are camelCased.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum LastOpened {
    #[serde(rename_all = "camelCase")]
    Note { rel_path: String },
    #[serde(rename_all = "camelCase")]
    Journal { date: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceState {
    pub last_opened: Option<LastOpened>,
}

fn path_for(vault_root: &Path) -> PathBuf {
    vault_root.join(".naiteh").join(FILE)
}

pub fn load(vault_root: &Path) -> Result<WorkspaceState, AppError> {
    let path = path_for(vault_root);
    match fsx::read_json::<WorkspaceState>(&path) {
        Ok(state) => Ok(state),
        Err(AppError::NotFound(_)) => Ok(WorkspaceState::default()),
        // A stale / corrupt workspace.json should never block the app —
        // recover by treating it as default and let the next save overwrite it.
        Err(AppError::ConfigCorrupt(_)) => Ok(WorkspaceState::default()),
        Err(e) => Err(e),
    }
}

pub fn save(vault_root: &Path, state: &WorkspaceState) -> Result<(), AppError> {
    let dir = vault_root.join(".naiteh");
    fsx::ensure_dir(&dir)?;
    fsx::write_json(&path_for(vault_root), state)
}

pub fn set_last_opened(
    vault_root: &Path,
    last_opened: Option<LastOpened>,
) -> Result<WorkspaceState, AppError> {
    let mut state = load(vault_root)?;
    state.last_opened = last_opened;
    save(vault_root, &state)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn load_returns_default_when_missing() {
        let v = tempdir().unwrap();
        assert_eq!(load(v.path()).unwrap(), WorkspaceState::default());
    }

    #[test]
    fn save_then_load_round_trip_for_note() {
        let v = tempdir().unwrap();
        let state = WorkspaceState {
            last_opened: Some(LastOpened::Note {
                rel_path: "notes/work/x.md".into(),
            }),
        };
        save(v.path(), &state).unwrap();
        let back = load(v.path()).unwrap();
        assert_eq!(back, state);
    }

    #[test]
    fn save_then_load_round_trip_for_journal() {
        let v = tempdir().unwrap();
        let state = WorkspaceState {
            last_opened: Some(LastOpened::Journal {
                date: "2026-05-09".into(),
            }),
        };
        save(v.path(), &state).unwrap();
        let back = load(v.path()).unwrap();
        assert_eq!(back, state);
    }

    #[test]
    fn corrupt_file_is_treated_as_default() {
        let v = tempdir().unwrap();
        std::fs::create_dir_all(v.path().join(".naiteh")).unwrap();
        std::fs::write(path_for(v.path()), b"{ not json").unwrap();
        assert_eq!(load(v.path()).unwrap(), WorkspaceState::default());
    }

    #[test]
    fn set_last_opened_persists_and_can_be_cleared() {
        let v = tempdir().unwrap();
        let after_set = set_last_opened(
            v.path(),
            Some(LastOpened::Note {
                rel_path: "notes/a.md".into(),
            }),
        )
        .unwrap();
        assert!(matches!(
            after_set.last_opened,
            Some(LastOpened::Note { .. })
        ));

        let after_clear = set_last_opened(v.path(), None).unwrap();
        assert_eq!(after_clear.last_opened, None);
    }

    #[test]
    fn camel_case_serialization() {
        let state = WorkspaceState {
            last_opened: Some(LastOpened::Note {
                rel_path: "notes/x.md".into(),
            }),
        };
        let json = serde_json::to_string(&state).unwrap();
        assert!(json.contains("\"lastOpened\""));
        assert!(json.contains("\"kind\":\"Note\""));
        assert!(json.contains("\"relPath\":\"notes/x.md\""));
    }
}
