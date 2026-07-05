//! Vault IPC commands — see architecture.md §7.1.
//!
//! Each public `vault_*` function is a thin Tauri-facing wrapper around an
//! inner `*_impl` that takes the app config directory explicitly so it can be
//! unit-tested against a tempdir.

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::domain::{AppError, VaultInfo};
use crate::services::config;
use crate::services::fs as fsx;

const NAITEH_DIR: &str = ".naiteh";

fn vault_info_for(root: &Path) -> VaultInfo {
    let root_str = root.to_string_lossy().to_string();
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_str.clone());
    let initialized = root.join(NAITEH_DIR).is_dir();
    VaultInfo {
        root: root_str,
        name,
        initialized,
    }
}

// ── vault_pick_folder ────────────────────────────────────────────────────

#[tauri::command]
pub async fn vault_pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<VaultInfo, AppError> {
    // The native folder picker (NSOpenPanel on macOS) must run on the main
    // thread. Calling `blocking_pick_folder()` from a Tauri worker thread
    // deadlocks; use the async callback form and bridge it via a oneshot
    // channel instead.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |folder| {
        let _ = tx.send(folder);
    });
    let picked = rx
        .await
        .map_err(|e| AppError::Io(format!("dialog channel closed: {e}")))?;
    let Some(path) = picked else {
        return Err(AppError::Cancelled);
    };
    let path_buf: PathBuf = path
        .into_path()
        .map_err(|e| AppError::InvalidPath(e.to_string()))?;
    if !path_buf.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "not a directory: {}",
            path_buf.display()
        )));
    }
    Ok(vault_info_for(&path_buf))
}

// ── vault_init ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_init(root: String) -> Result<VaultInfo, AppError> {
    vault_init_impl(Path::new(&root))
}

fn vault_init_impl(root: &Path) -> Result<VaultInfo, AppError> {
    if !root.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "not a directory: {}",
            root.display()
        )));
    }
    let naiteh_dir = root.join(NAITEH_DIR);
    if naiteh_dir.exists() {
        return Err(AppError::AlreadyInitialized(
            root.to_string_lossy().to_string(),
        ));
    }

    fsx::ensure_dir(&naiteh_dir)?;
    fsx::ensure_dir(&root.join("attachments"))?;
    fsx::ensure_dir(&root.join("journal"))?;
    fsx::ensure_dir(&root.join("notes").join("_inbox"))?;

    let stub = json!({ "version": 1 });
    fsx::write_json(&naiteh_dir.join("config.json"), &stub)?;

    Ok(vault_info_for(root))
}

// ── vault_create_default ─────────────────────────────────────────────────

/// Default vault folder name, created under the user's Documents dir by
/// the first-run "quick create" path. The vault's display name is the
/// folder name, so a fresh setup shows up as "duramen".
const DEFAULT_VAULT_NAME: &str = "duramen";

/// One-click first-run setup: create `~/Documents/duramen` (falling
/// back to `duramen-2`, `duramen-3`, … if the name is taken),
/// initialize it as a vault, and make it active.
#[tauri::command]
pub fn vault_create_default() -> Result<VaultInfo, AppError> {
    let config_dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&config_dir)?;
    let documents = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| AppError::NotFound("no Documents directory on this system".into()))?;
    vault_create_default_impl(&config_dir, &documents)
}

fn vault_create_default_impl(
    config_dir: &Path,
    documents: &Path,
) -> Result<VaultInfo, AppError> {
    let root = available_default_root(documents)?;
    fsx::ensure_dir(&root)?;
    let info = vault_init_impl(&root)?;
    vault_set_active_impl(config_dir, &info.root)?;
    Ok(info)
}

fn available_default_root(documents: &Path) -> Result<PathBuf, AppError> {
    let base = documents.join(DEFAULT_VAULT_NAME);
    if !base.exists() {
        return Ok(base);
    }
    for i in 2..1000 {
        let candidate = documents.join(format!("{DEFAULT_VAULT_NAME}-{i}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(format!(
        "could not find a free folder name for {DEFAULT_VAULT_NAME} under {}",
        documents.display()
    )))
}

// ── vault_current / vault_set_active / vault_list_known ──────────────────

#[tauri::command]
pub fn vault_current() -> Result<Option<VaultInfo>, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    vault_current_impl(&dir)
}

fn vault_current_impl(config_dir: &Path) -> Result<Option<VaultInfo>, AppError> {
    let cfg = config::load(config_dir)?;
    Ok(cfg
        .active_vault
        .as_deref()
        .map(|p| vault_info_for(Path::new(p))))
}

#[tauri::command]
pub fn vault_set_active(root: String) -> Result<VaultInfo, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    vault_set_active_impl(&dir, &root)
}

fn vault_set_active_impl(config_dir: &Path, root: &str) -> Result<VaultInfo, AppError> {
    let mut cfg = config::load(config_dir)?;
    cfg.active_vault = Some(root.to_string());
    if !cfg.known_vaults.iter().any(|p| p == root) {
        cfg.known_vaults.insert(0, root.to_string());
    }
    config::save(config_dir, &cfg)?;
    Ok(vault_info_for(Path::new(root)))
}

#[tauri::command]
pub fn vault_list_known() -> Result<Vec<VaultInfo>, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    vault_list_known_impl(&dir)
}

fn vault_list_known_impl(config_dir: &Path) -> Result<Vec<VaultInfo>, AppError> {
    let cfg = config::load(config_dir)?;
    Ok(cfg
        .known_vaults
        .iter()
        .map(|p| vault_info_for(Path::new(p)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::config::AppConfig;
    use tempfile::tempdir;

    #[test]
    fn init_creates_required_structure() {
        let root_dir = tempdir().unwrap();
        let info = vault_init_impl(root_dir.path()).unwrap();

        assert!(info.initialized);
        assert_eq!(info.root, root_dir.path().to_string_lossy());

        assert!(root_dir.path().join(".naiteh").is_dir());
        assert!(root_dir.path().join(".naiteh/config.json").is_file());
        assert!(root_dir.path().join("attachments").is_dir());
        assert!(root_dir.path().join("journal").is_dir());
        assert!(root_dir.path().join("notes/_inbox").is_dir());
    }

    #[test]
    fn init_preserves_underscore_prefix_on_inbox() {
        let root_dir = tempdir().unwrap();
        vault_init_impl(root_dir.path()).unwrap();
        let inbox = root_dir.path().join("notes/_inbox");
        assert_eq!(
            inbox.file_name().unwrap().to_string_lossy(),
            "_inbox",
            "leading underscore must be preserved"
        );
    }

    #[test]
    fn init_twice_returns_already_initialized() {
        let root_dir = tempdir().unwrap();
        vault_init_impl(root_dir.path()).unwrap();
        let err = vault_init_impl(root_dir.path()).unwrap_err();
        assert!(
            matches!(err, AppError::AlreadyInitialized(_)),
            "got {err:?}"
        );
    }

    #[test]
    fn init_on_missing_root_returns_invalid_path() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist");
        let err = vault_init_impl(&bogus).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn current_is_none_when_no_active_vault() {
        let cfg_dir = tempdir().unwrap();
        let result = vault_current_impl(cfg_dir.path()).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn set_active_persists_and_adds_to_known() {
        let cfg_dir = tempdir().unwrap();
        let vault_dir = tempdir().unwrap();
        let root_str = vault_dir.path().to_string_lossy().to_string();

        let info = vault_set_active_impl(cfg_dir.path(), &root_str).unwrap();
        assert_eq!(info.root, root_str);

        let cfg = config::load(cfg_dir.path()).unwrap();
        assert_eq!(cfg.active_vault.as_deref(), Some(root_str.as_str()));
        assert_eq!(cfg.known_vaults, vec![root_str.clone()]);
    }

    #[test]
    fn set_active_does_not_duplicate_in_known() {
        let cfg_dir = tempdir().unwrap();
        let vault_dir = tempdir().unwrap();
        let root_str = vault_dir.path().to_string_lossy().to_string();

        vault_set_active_impl(cfg_dir.path(), &root_str).unwrap();
        vault_set_active_impl(cfg_dir.path(), &root_str).unwrap();

        let cfg = config::load(cfg_dir.path()).unwrap();
        assert_eq!(cfg.known_vaults.len(), 1);
    }

    #[test]
    fn current_returns_active_after_set() {
        let cfg_dir = tempdir().unwrap();
        let vault_dir = tempdir().unwrap();
        vault_init_impl(vault_dir.path()).unwrap();
        let root_str = vault_dir.path().to_string_lossy().to_string();
        vault_set_active_impl(cfg_dir.path(), &root_str).unwrap();

        let current = vault_current_impl(cfg_dir.path()).unwrap();
        let info = current.expect("expected Some");
        assert_eq!(info.root, root_str);
        assert!(info.initialized);
    }

    #[test]
    fn list_known_handles_missing_paths_without_panic() {
        let cfg_dir = tempdir().unwrap();
        let cfg = AppConfig {
            known_vaults: vec![
                "/path/that/does/not/exist".to_string(),
                "/another/missing/vault".to_string(),
            ],
            ..AppConfig::default()
        };
        config::save(cfg_dir.path(), &cfg).unwrap();

        let listed = vault_list_known_impl(cfg_dir.path()).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|v| !v.initialized));
    }

    #[test]
    fn list_known_reflects_init_state_on_disk() {
        let cfg_dir = tempdir().unwrap();
        let initialized_vault = tempdir().unwrap();
        vault_init_impl(initialized_vault.path()).unwrap();
        let pristine_vault = tempdir().unwrap();

        let cfg = AppConfig {
            known_vaults: vec![
                initialized_vault.path().to_string_lossy().to_string(),
                pristine_vault.path().to_string_lossy().to_string(),
            ],
            ..AppConfig::default()
        };
        config::save(cfg_dir.path(), &cfg).unwrap();

        let listed = vault_list_known_impl(cfg_dir.path()).unwrap();
        assert!(listed[0].initialized);
        assert!(!listed[1].initialized);
    }

    // ── vault_create_default ────────────────────────────────────────

    #[test]
    fn create_default_makes_duramen_and_activates_it() {
        let cfg_dir = tempfile::tempdir().unwrap();
        let docs = tempfile::tempdir().unwrap();

        let info = vault_create_default_impl(cfg_dir.path(), docs.path()).unwrap();

        assert_eq!(info.name, "duramen");
        assert!(info.initialized);
        let root = Path::new(&info.root);
        assert!(root.join(".naiteh/config.json").is_file());
        assert!(root.join("notes/_inbox").is_dir());
        assert!(root.join("journal").is_dir());

        // Registered as the active vault in app config.
        let active = vault_current_impl(cfg_dir.path()).unwrap().unwrap();
        assert_eq!(active.root, info.root);
    }

    #[test]
    fn create_default_dedups_when_duramen_exists() {
        let cfg_dir = tempfile::tempdir().unwrap();
        let docs = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(docs.path().join("duramen")).unwrap();

        let info = vault_create_default_impl(cfg_dir.path(), docs.path()).unwrap();
        assert_eq!(info.name, "duramen-2");
        assert!(info.initialized);
    }
}
