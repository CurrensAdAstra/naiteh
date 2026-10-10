//! Vault IPC commands — see vault/wiki/ipc-api.md ("Vault") and
//! vault-and-data.md ("Where a vault may live").
//!
//! Each public `vault_*` function is a thin Tauri-facing wrapper around an
//! inner `*_impl` that takes the app config directory (and the vault-path
//! policy) explicitly so it can be unit-tested against a tempdir.
//!
//! Vault roots are validated when chosen (`services::vault_path`): an
//! absolute, canonical directory that is not a filesystem root, the home
//! folder, or a system / app-data location. `vault_set_active` further
//! requires an already-initialized vault.

use std::path::{Path, PathBuf};

use serde_json::json;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::DialogExt;

use crate::domain::{AppError, VaultInfo};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::session::{require_session, ActiveSession};
use crate::services::vault_path::{self, VaultPathPolicy};

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
pub async fn vault_pick_folder<R: Runtime>(
    active: tauri::State<'_, ActiveSession>,
    app: AppHandle<R>,
) -> Result<VaultInfo, AppError> {
    require_session(&active)?;
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
pub fn vault_init(
    active: tauri::State<'_, ActiveSession>,
    root: String,
) -> Result<VaultInfo, AppError> {
    require_session(&active)?;
    vault_init_impl(&root, &VaultPathPolicy::system())
}

/// Initialize `root` as a vault. The folder may be created if its parent
/// exists. Returns the canonical root.
fn vault_init_impl(root: &str, policy: &VaultPathPolicy) -> Result<VaultInfo, AppError> {
    let root = vault_path::validate_new_root(root, policy)?;
    if !root.exists() {
        // Parent was verified to exist; create just this one level.
        std::fs::create_dir(&root)?;
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

    Ok(vault_info_for(&root))
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
pub fn vault_create_default(
    active: tauri::State<'_, ActiveSession>,
) -> Result<VaultInfo, AppError> {
    require_session(&active)?;
    let config_dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&config_dir)?;
    let documents = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| AppError::NotFound("no Documents directory on this system".into()))?;
    vault_create_default_impl(&config_dir, &documents, &VaultPathPolicy::system())
}

fn vault_create_default_impl(
    config_dir: &Path,
    documents: &Path,
    policy: &VaultPathPolicy,
) -> Result<VaultInfo, AppError> {
    fsx::ensure_dir(documents)?;
    let root = available_default_root(documents)?;
    let info = vault_init_impl(&root.to_string_lossy(), policy)?;
    vault_set_active_impl(config_dir, &info.root, policy)
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
pub fn vault_current(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Option<VaultInfo>, AppError> {
    require_session(&active)?;
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
pub fn vault_set_active(
    active: tauri::State<'_, ActiveSession>,
    root: String,
) -> Result<VaultInfo, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    vault_set_active_impl(&dir, &root, &VaultPathPolicy::system())
}

/// Make `root` the active vault. It must pass the vault-path policy and
/// already be a naiteh vault (`.naiteh/`, or `notes/` + `journal/`).
/// The canonical path is what gets stored.
fn vault_set_active_impl(
    config_dir: &Path,
    root: &str,
    policy: &VaultPathPolicy,
) -> Result<VaultInfo, AppError> {
    let canonical = vault_path::validate_existing_root(root, policy)?;
    if !vault_path::is_naiteh_vault(&canonical) {
        return Err(AppError::InvalidPath(format!(
            "{} is not a naiteh vault — create a new vault there instead",
            canonical.display()
        )));
    }
    let root_str = canonical.to_string_lossy().to_string();
    let mut cfg = config::load(config_dir)?;
    cfg.active_vault = Some(root_str.clone());
    let same_as_root = |p: &String| {
        p == &root_str
            || Path::new(p)
                .canonicalize()
                .map(|c| vault_path::simplify(&c) == canonical)
                .unwrap_or(false)
    };
    if !cfg.known_vaults.iter().any(same_as_root) {
        cfg.known_vaults.insert(0, root_str);
    }
    config::save(config_dir, &cfg)?;
    Ok(vault_info_for(&canonical))
}

#[tauri::command]
pub fn vault_list_known(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<VaultInfo>, AppError> {
    require_session(&active)?;
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

    /// Tempdirs live under %LOCALAPPDATA% / $TMPDIR, which the system
    /// policy refuses — tests use an empty policy unless they test it.
    fn open_policy() -> VaultPathPolicy {
        VaultPathPolicy::default()
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    fn canon(p: &Path) -> PathBuf {
        vault_path::simplify(&p.canonicalize().unwrap())
    }

    #[test]
    fn init_creates_required_structure() {
        let root_dir = tempdir().unwrap();
        let info = vault_init_impl(&s(root_dir.path()), &open_policy()).unwrap();

        assert!(info.initialized);
        assert_eq!(info.root, s(&canon(root_dir.path())));

        assert!(root_dir.path().join(".naiteh").is_dir());
        assert!(root_dir.path().join(".naiteh/config.json").is_file());
        assert!(root_dir.path().join("attachments").is_dir());
        assert!(root_dir.path().join("journal").is_dir());
        assert!(root_dir.path().join("notes/_inbox").is_dir());
    }

    #[test]
    fn init_preserves_underscore_prefix_on_inbox() {
        let root_dir = tempdir().unwrap();
        vault_init_impl(&s(root_dir.path()), &open_policy()).unwrap();
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
        vault_init_impl(&s(root_dir.path()), &open_policy()).unwrap();
        let err = vault_init_impl(&s(root_dir.path()), &open_policy()).unwrap_err();
        assert!(
            matches!(err, AppError::AlreadyInitialized(_)),
            "got {err:?}"
        );
    }

    #[test]
    fn init_creates_a_missing_folder_when_parent_exists() {
        let dir = tempdir().unwrap();
        let fresh = dir.path().join("new-vault");
        let info = vault_init_impl(&s(&fresh), &open_policy()).unwrap();
        assert!(info.initialized);
        assert!(fresh.join(".naiteh").is_dir());
    }

    #[test]
    fn init_with_missing_parent_returns_invalid_path() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist").join("vault");
        let err = vault_init_impl(&s(&bogus), &open_policy()).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        assert!(!dir.path().join("does-not-exist").exists());
    }

    #[test]
    fn init_rejects_relative_paths_and_denied_locations() {
        let err = vault_init_impl("relative/vault", &open_policy()).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");

        let home = tempdir().unwrap();
        let policy = VaultPathPolicy::new(vec![home.path().to_path_buf()], vec![]);
        let err = vault_init_impl(&s(home.path()), &policy).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        assert!(!home.path().join(".naiteh").exists());
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
        vault_init_impl(&s(vault_dir.path()), &open_policy()).unwrap();
        let root_str = s(&canon(vault_dir.path()));

        let info =
            vault_set_active_impl(cfg_dir.path(), &s(vault_dir.path()), &open_policy()).unwrap();
        assert_eq!(info.root, root_str);

        let cfg = config::load(cfg_dir.path()).unwrap();
        assert_eq!(cfg.active_vault.as_deref(), Some(root_str.as_str()));
        assert_eq!(cfg.known_vaults, vec![root_str.clone()]);
    }

    #[test]
    fn set_active_does_not_duplicate_in_known() {
        let cfg_dir = tempdir().unwrap();
        let vault_dir = tempdir().unwrap();
        vault_init_impl(&s(vault_dir.path()), &open_policy()).unwrap();
        let root_str = s(vault_dir.path());

        vault_set_active_impl(cfg_dir.path(), &root_str, &open_policy()).unwrap();
        vault_set_active_impl(cfg_dir.path(), &root_str, &open_policy()).unwrap();

        let cfg = config::load(cfg_dir.path()).unwrap();
        assert_eq!(cfg.known_vaults.len(), 1);
    }

    #[test]
    fn set_active_requires_an_existing_naiteh_vault() {
        let cfg_dir = tempdir().unwrap();
        let plain = tempdir().unwrap();
        let err =
            vault_set_active_impl(cfg_dir.path(), &s(plain.path()), &open_policy()).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");

        let missing = plain.path().join("nope");
        assert!(vault_set_active_impl(cfg_dir.path(), &s(&missing), &open_policy()).is_err());
        assert!(config::load(cfg_dir.path()).unwrap().active_vault.is_none());

        // The notes/ + journal/ layout also counts as a vault.
        std::fs::create_dir_all(plain.path().join("notes")).unwrap();
        std::fs::create_dir_all(plain.path().join("journal")).unwrap();
        vault_set_active_impl(cfg_dir.path(), &s(plain.path()), &open_policy()).unwrap();
    }

    #[test]
    fn set_active_refuses_a_vault_in_a_denied_location() {
        let cfg_dir = tempdir().unwrap();
        let home = tempdir().unwrap();
        // A "vault" sitting directly in the home folder (e.g. via a
        // planted .naiteh) is still refused.
        std::fs::create_dir_all(home.path().join(".naiteh")).unwrap();
        let policy = VaultPathPolicy::new(vec![home.path().to_path_buf()], vec![]);
        let err = vault_set_active_impl(cfg_dir.path(), &s(home.path()), &policy).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn current_returns_active_after_set() {
        let cfg_dir = tempdir().unwrap();
        let vault_dir = tempdir().unwrap();
        vault_init_impl(&s(vault_dir.path()), &open_policy()).unwrap();
        vault_set_active_impl(cfg_dir.path(), &s(vault_dir.path()), &open_policy()).unwrap();

        let current = vault_current_impl(cfg_dir.path()).unwrap();
        let info = current.expect("expected Some");
        assert_eq!(info.root, s(&canon(vault_dir.path())));
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
        vault_init_impl(&s(initialized_vault.path()), &open_policy()).unwrap();
        let pristine_vault = tempdir().unwrap();

        let cfg = AppConfig {
            known_vaults: vec![s(initialized_vault.path()), s(pristine_vault.path())],
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

        let info = vault_create_default_impl(cfg_dir.path(), docs.path(), &open_policy()).unwrap();

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

        let info = vault_create_default_impl(cfg_dir.path(), docs.path(), &open_policy()).unwrap();
        assert_eq!(info.name, "duramen-2");
        assert!(info.initialized);
    }
}
