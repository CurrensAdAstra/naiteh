//! Settings IPC commands — exposes the OS-level app config (architecture
//! .md §8) to the frontend so the Settings panel can show + tweak prefs.
//!
//! Vault switching has its own commands (vault_set_active / vault_init) so
//! this module intentionally only touches editor / theme / calendar /
//! journal preferences — not active_vault or known_vaults.

use std::path::Path;

use crate::domain::AppError;
use crate::services::config::{self, AppConfig, EditorConfig};
use crate::services::fs as fsx;

const FONT_SIZE_MIN: u16 = 8;
const FONT_SIZE_MAX: u16 = 32;

#[tauri::command]
pub fn app_config_get() -> Result<AppConfig, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    config::load(&dir)
}

#[tauri::command]
pub fn app_config_set_editor(font_size: u16, line_wrapping: bool) -> Result<AppConfig, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_editor_impl(&dir, font_size, line_wrapping)
}

fn app_config_set_editor_impl(
    config_dir: &Path,
    font_size: u16,
    line_wrapping: bool,
) -> Result<AppConfig, AppError> {
    let clamped = font_size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
    let mut cfg = config::load(config_dir)?;
    cfg.editor = EditorConfig {
        font_size: clamped,
        line_wrapping,
    };
    config::save(config_dir, &cfg)?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn set_editor_persists_clamped_values() {
        let dir = tempdir().unwrap();
        let cfg = app_config_set_editor_impl(dir.path(), 16, false).unwrap();
        assert_eq!(cfg.editor.font_size, 16);
        assert!(!cfg.editor.line_wrapping);

        // Reload from disk to confirm persistence.
        let loaded = config::load(dir.path()).unwrap();
        assert_eq!(loaded.editor.font_size, 16);
        assert!(!loaded.editor.line_wrapping);
    }

    #[test]
    fn set_editor_clamps_below_minimum() {
        let dir = tempdir().unwrap();
        let cfg = app_config_set_editor_impl(dir.path(), 4, true).unwrap();
        assert_eq!(cfg.editor.font_size, FONT_SIZE_MIN);
    }

    #[test]
    fn set_editor_clamps_above_maximum() {
        let dir = tempdir().unwrap();
        let cfg = app_config_set_editor_impl(dir.path(), 999, true).unwrap();
        assert_eq!(cfg.editor.font_size, FONT_SIZE_MAX);
    }

    #[test]
    fn set_editor_preserves_other_sections() {
        let dir = tempdir().unwrap();
        // Seed config with vault data the editor command must not touch.
        let seed = AppConfig {
            active_vault: Some("/v".into()),
            known_vaults: vec!["/v".into(), "/w".into()],
            theme: "light".into(),
            ..AppConfig::default()
        };
        config::save(dir.path(), &seed).unwrap();

        let cfg = app_config_set_editor_impl(dir.path(), 18, false).unwrap();
        assert_eq!(cfg.active_vault.as_deref(), Some("/v"));
        assert_eq!(cfg.known_vaults, vec!["/v".to_string(), "/w".to_string()]);
        assert_eq!(cfg.editor.font_size, 18);
    }
}
