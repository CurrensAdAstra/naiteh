//! Settings IPC commands — exposes the OS-level app config (wiki
//! app-config.md) to the frontend so the Settings panel can show + tweak
//! prefs.
//!
//! Vault switching has its own commands (vault_set_active / vault_init) so
//! this module intentionally only touches editor / theme / calendar /
//! journal / AI preferences — not active_vault or known_vaults.
//!
//! Every command returns [`AppConfigView`], never the raw [`AppConfig`]:
//! the AI API key stays on disk and is reported only as `hasApiKey`.

use std::path::Path;

use crate::domain::AppError;
use crate::services::config::{self, AppConfigView, EditorConfig};
use crate::services::fs as fsx;
use crate::services::session::{require_session, ActiveSession};

const FONT_SIZE_MIN: u16 = 8;
const FONT_SIZE_MAX: u16 = 32;

#[tauri::command]
pub fn app_config_get(active: tauri::State<'_, ActiveSession>) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    config::load(&dir).map(|cfg| AppConfigView::from(&cfg))
}

#[tauri::command]
pub fn app_config_set_editor(
    active: tauri::State<'_, ActiveSession>,
    font_size: u16,
    line_wrapping: bool,
) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_editor_impl(&dir, font_size, line_wrapping)
}

fn app_config_set_editor_impl(
    config_dir: &Path,
    font_size: u16,
    line_wrapping: bool,
) -> Result<AppConfigView, AppError> {
    let clamped = font_size.clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
    let mut cfg = config::load(config_dir)?;
    cfg.editor = EditorConfig {
        font_size: clamped,
        line_wrapping,
    };
    config::save(config_dir, &cfg)?;
    Ok(AppConfigView::from(&cfg))
}

/// Update the AI settings.
///
/// - `api_key`: `Some(non-empty)` replaces the stored key; `None` (or an
///   all-whitespace string) keeps it — unless `clear_api_key` is true,
///   which removes it (and wins over `api_key`).
/// - `base_url`: `None`/empty keeps the current URL; otherwise it must
///   pass [`config::validate_ai_base_url`].
#[tauri::command]
pub fn app_config_set_ai(
    active: tauri::State<'_, ActiveSession>,
    api_key: Option<String>,
    clear_api_key: bool,
    model: String,
    base_url: Option<String>,
) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_ai_impl(&dir, api_key, clear_api_key, model, base_url)
}

fn app_config_set_ai_impl(
    config_dir: &Path,
    api_key: Option<String>,
    clear_api_key: bool,
    model: String,
    base_url: Option<String>,
) -> Result<AppConfigView, AppError> {
    let mut cfg = config::load(config_dir)?;
    let trimmed_model = model.trim().to_string();
    if trimmed_model.is_empty() {
        return Err(AppError::Validation("model is required".into()));
    }
    let new_base_url = match base_url.map(|u| u.trim().to_string()) {
        Some(u) if !u.is_empty() => {
            config::validate_ai_base_url(&u)?;
            u
        }
        _ => cfg.ai.base_url.clone(),
    };
    let new_key = api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty());
    if clear_api_key {
        cfg.ai.api_key = None;
    } else if let Some(key) = new_key {
        cfg.ai.api_key = Some(key);
    }
    cfg.ai.model = trimmed_model;
    cfg.ai.base_url = new_base_url;
    config::save(config_dir, &cfg)?;
    Ok(AppConfigView::from(&cfg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::config::{AiConfig, AppConfig};
    use tempfile::tempdir;

    fn stored_key(dir: &Path) -> Option<String> {
        config::load(dir).unwrap().ai.api_key
    }

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
    fn set_editor_returns_view_without_key() {
        let dir = tempdir().unwrap();
        let seed = AppConfig {
            ai: AiConfig {
                api_key: Some("sk-secret".into()),
                ..AiConfig::default()
            },
            ..AppConfig::default()
        };
        config::save(dir.path(), &seed).unwrap();
        let view = app_config_set_editor_impl(dir.path(), 15, true).unwrap();
        assert!(view.ai.has_api_key);
        assert!(!serde_json::to_string(&view).unwrap().contains("sk-secret"));
        // …and the key is still on disk.
        assert_eq!(stored_key(dir.path()).as_deref(), Some("sk-secret"));
    }

    #[test]
    fn set_ai_persists_trimmed_key_and_model() {
        let dir = tempdir().unwrap();
        let view = app_config_set_ai_impl(
            dir.path(),
            Some("  sk-test  ".into()),
            false,
            "  gpt-4o-mini  ".into(),
            None,
        )
        .unwrap();
        assert!(view.ai.has_api_key);
        assert_eq!(stored_key(dir.path()).as_deref(), Some("sk-test"));
        assert_eq!(view.ai.model, "gpt-4o-mini");
        // Default base url is preserved when none is supplied.
        assert!(view.ai.base_url.contains("openai.com"));
    }

    #[test]
    fn set_ai_keeps_existing_key_when_none_or_blank() {
        let dir = tempdir().unwrap();
        app_config_set_ai_impl(dir.path(), Some("sk-1".into()), false, "m".into(), None).unwrap();
        let view = app_config_set_ai_impl(dir.path(), None, false, "m2".into(), None).unwrap();
        assert!(view.ai.has_api_key);
        assert_eq!(stored_key(dir.path()).as_deref(), Some("sk-1"));
        app_config_set_ai_impl(dir.path(), Some("   ".into()), false, "m".into(), None).unwrap();
        assert_eq!(stored_key(dir.path()).as_deref(), Some("sk-1"));
    }

    #[test]
    fn set_ai_replaces_or_clears_key() {
        let dir = tempdir().unwrap();
        app_config_set_ai_impl(dir.path(), Some("sk-1".into()), false, "m".into(), None).unwrap();
        app_config_set_ai_impl(dir.path(), Some("sk-2".into()), false, "m".into(), None).unwrap();
        assert_eq!(stored_key(dir.path()).as_deref(), Some("sk-2"));
        // clear wins even if a key is also supplied.
        let view = app_config_set_ai_impl(dir.path(), Some("sk-3".into()), true, "m".into(), None)
            .unwrap();
        assert!(!view.ai.has_api_key);
        assert!(stored_key(dir.path()).is_none());
    }

    #[test]
    fn set_ai_rejects_empty_model() {
        let dir = tempdir().unwrap();
        let err = app_config_set_ai_impl(
            dir.path(),
            Some("sk-test".into()),
            false,
            "   ".into(),
            None,
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Validation(_)));
    }

    #[test]
    fn set_ai_overrides_base_url_when_provided() {
        let dir = tempdir().unwrap();
        let view = app_config_set_ai_impl(
            dir.path(),
            None,
            false,
            "gpt-4o-mini".into(),
            Some("https://example.com/v1".into()),
        )
        .unwrap();
        assert_eq!(view.ai.base_url, "https://example.com/v1");
        let view = app_config_set_ai_impl(
            dir.path(),
            None,
            false,
            "llama3.2".into(),
            Some("http://localhost:11434/v1".into()),
        )
        .unwrap();
        assert_eq!(view.ai.base_url, "http://localhost:11434/v1");
    }

    #[test]
    fn set_ai_rejects_insecure_or_invalid_base_url_without_saving() {
        let dir = tempdir().unwrap();
        for bad in ["http://evil.example/v1", "file:///etc/passwd", "nope"] {
            let err = app_config_set_ai_impl(
                dir.path(),
                Some("sk-x".into()),
                false,
                "m".into(),
                Some(bad.into()),
            )
            .unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{bad}: {err:?}");
        }
        assert!(stored_key(dir.path()).is_none(), "nothing persisted");
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
