//! Settings IPC commands — exposes the OS-level app config (architecture
//! .md §8) to the frontend so the Settings panel can show + tweak prefs.
//!
//! Vault switching has its own commands (vault_set_active / vault_init) so
//! this module intentionally only touches editor / theme / calendar /
//! journal preferences — not active_vault or known_vaults.

use std::path::Path;

use crate::domain::AppError;
use crate::services::config::{self, AiConfig, AppConfig, EditorConfig};
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

#[tauri::command]
pub fn app_config_set_ai(
    api_key: Option<String>,
    model: String,
    base_url: Option<String>,
) -> Result<AppConfig, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_ai_impl(&dir, api_key, model, base_url)
}

fn app_config_set_ai_impl(
    config_dir: &Path,
    api_key: Option<String>,
    model: String,
    base_url: Option<String>,
) -> Result<AppConfig, AppError> {
    let mut cfg = config::load(config_dir)?;
    let trimmed_key = api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    let trimmed_model = model.trim().to_string();
    if trimmed_model.is_empty() {
        return Err(AppError::InvalidPath("model is required".into()));
    }
    cfg.ai = AiConfig {
        api_key: trimmed_key,
        model: trimmed_model,
        base_url: base_url
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or(cfg.ai.base_url),
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
    fn set_ai_persists_trimmed_key_and_model() {
        let dir = tempdir().unwrap();
        let cfg = app_config_set_ai_impl(
            dir.path(),
            Some("  sk-test  ".into()),
            "  gpt-4o-mini  ".into(),
            None,
        )
        .unwrap();
        assert_eq!(cfg.ai.api_key.as_deref(), Some("sk-test"));
        assert_eq!(cfg.ai.model, "gpt-4o-mini");
        // Default base url is preserved when none is supplied.
        assert!(cfg.ai.base_url.contains("openai.com"));
    }

    #[test]
    fn set_ai_treats_empty_api_key_as_none() {
        let dir = tempdir().unwrap();
        let cfg =
            app_config_set_ai_impl(dir.path(), Some("   ".into()), "gpt-4o-mini".into(), None)
                .unwrap();
        assert!(cfg.ai.api_key.is_none());
    }

    #[test]
    fn set_ai_rejects_empty_model() {
        let dir = tempdir().unwrap();
        let err = app_config_set_ai_impl(dir.path(), Some("sk-test".into()), "   ".into(), None)
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[test]
    fn set_ai_overrides_base_url_when_provided() {
        let dir = tempdir().unwrap();
        let cfg = app_config_set_ai_impl(
            dir.path(),
            None,
            "gpt-4o-mini".into(),
            Some("https://example.com/v1".into()),
        )
        .unwrap();
        assert_eq!(cfg.ai.base_url, "https://example.com/v1");
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
