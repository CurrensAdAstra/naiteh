//! Settings IPC commands — exposes the OS-level app config (wiki
//! app-config.md) to the frontend so the Settings panel can show + tweak
//! prefs.
//!
//! Vault switching has its own commands (vault_set_active / vault_init) so
//! this module intentionally only touches editor / theme / calendar /
//! journal / AI / appearance / clipping preferences — not active_vault or known_vaults.
//!
//! Every command returns [`AppConfigView`], never the raw [`AppConfig`]:
//! the AI API key stays on disk and is reported only as `hasApiKey`.

use std::path::Path;

use crate::domain::AppError;
use serde::Deserialize;

use crate::services::chat_doc;
use crate::services::config::{
    self, AppConfigView, AppearanceConfig, ClippingConfig, EditorConfig, ProviderConfig,
};
use crate::services::fs as fsx;
use crate::services::notes;
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

/// The scalar AI settings (`app_config_set_ai` payload; wire camelCase).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInput {
    pub default_model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub stream: bool,
    pub heading_level: u8,
    pub infer_title_language: String,
    pub chats_folder: String,
    pub agents_folder: String,
}

/// Update the chat settings (everything in `ai` except `providers`).
/// Nothing is saved unless every field validates.
#[tauri::command]
pub fn app_config_set_ai(
    active: tauri::State<'_, ActiveSession>,
    settings: AiSettingsInput,
) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_ai_impl(&dir, settings)
}

fn app_config_set_ai_impl(
    config_dir: &Path,
    s: AiSettingsInput,
) -> Result<AppConfigView, AppError> {
    let invalid = |m: String| AppError::Validation(m);
    let (provider, model) = chat_doc::parse_model(&s.default_model)?;
    if !(s.temperature.is_finite() && (0.0..=config::AI_TEMPERATURE_MAX).contains(&s.temperature)) {
        return Err(invalid(format!(
            "temperature must be between 0 and {}",
            config::AI_TEMPERATURE_MAX
        )));
    }
    if !(1..=config::AI_MAX_TOKENS_MAX).contains(&s.max_tokens) {
        return Err(invalid(format!(
            "maxTokens must be between 1 and {}",
            config::AI_MAX_TOKENS_MAX
        )));
    }
    if !(1..=6).contains(&s.heading_level) {
        return Err(invalid("headingLevel must be between 1 and 6".into()));
    }
    let language = s.infer_title_language.trim().to_string();
    if language.is_empty()
        || language.chars().count() > config::AI_LANGUAGE_MAX_LEN
        || language.chars().any(char::is_control)
    {
        return Err(invalid(format!(
            "inferTitleLanguage must be 1–{} characters",
            config::AI_LANGUAGE_MAX_LEN
        )));
    }
    let chats_folder = notes::normalize_rel_path(s.chats_folder.trim())?;
    let agents_folder = notes::normalize_rel_path(s.agents_folder.trim())?;

    let mut cfg = config::load(config_dir)?;
    cfg.ai.default_model = format!("{}@{model}", provider.id());
    cfg.ai.temperature = s.temperature;
    cfg.ai.max_tokens = s.max_tokens;
    cfg.ai.stream = s.stream;
    cfg.ai.heading_level = s.heading_level;
    cfg.ai.infer_title_language = language;
    cfg.ai.chats_folder = chats_folder;
    cfg.ai.agents_folder = agents_folder;
    config::save(config_dir, &cfg)?;
    Ok(AppConfigView::from(&cfg))
}

/// Update one provider's endpoint / key.
///
/// - `base_url`: `None`/blank keeps the current URL; otherwise it must
///   pass [`config::validate_ai_base_url`].
/// - `api_key`: `Some(non-blank)` replaces the stored key; `None`/blank
///   keeps it — unless `clear_api_key`, which removes it (and wins).
#[tauri::command]
pub fn app_config_set_ai_provider(
    active: tauri::State<'_, ActiveSession>,
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    clear_api_key: bool,
) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_ai_provider_impl(&dir, provider, base_url, api_key, clear_api_key)
}

fn app_config_set_ai_provider_impl(
    config_dir: &Path,
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    clear_api_key: bool,
) -> Result<AppConfigView, AppError> {
    let id = provider.trim();
    let default_url = config::default_provider_base_url(id)
        .ok_or_else(|| AppError::Validation(format!("unknown provider {provider:?}")))?;
    let new_url = match base_url.map(|u| u.trim().trim_end_matches('/').to_string()) {
        Some(u) if !u.is_empty() => {
            config::validate_ai_base_url(&u)?;
            Some(u)
        }
        _ => None,
    };
    let mut cfg = config::load(config_dir)?;
    let slot = cfg
        .ai
        .providers
        .entry(id.to_string())
        .or_insert_with(|| ProviderConfig {
            api_key: None,
            base_url: default_url.to_string(),
        });
    if let Some(u) = new_url {
        slot.base_url = u;
    }
    if clear_api_key {
        slot.api_key = None;
    } else if let Some(k) = api_key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
    {
        slot.api_key = Some(k);
    }
    config::save(config_dir, &cfg)?;
    Ok(AppConfigView::from(&cfg))
}

/// Update palette + font families. Fonts are trimmed; empty means the
/// built-in default stack.
#[tauri::command]
pub fn app_config_set_appearance(
    active: tauri::State<'_, ActiveSession>,
    palette: String,
    ui_font: String,
    editor_font: String,
) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_appearance_impl(&dir, palette, ui_font, editor_font)
}

fn app_config_set_appearance_impl(
    config_dir: &Path,
    palette: String,
    ui_font: String,
    editor_font: String,
) -> Result<AppConfigView, AppError> {
    let palette = palette.trim().to_string();
    if !config::PALETTES.contains(&palette.as_str()) {
        return Err(AppError::Validation(format!("unknown palette {palette:?}")));
    }
    let ui_font = ui_font.trim().to_string();
    let editor_font = editor_font.trim().to_string();
    config::validate_font_family(&ui_font)?;
    config::validate_font_family(&editor_font)?;
    let mut cfg = config::load(config_dir)?;
    cfg.appearance = AppearanceConfig {
        palette,
        ui_font,
        editor_font,
    };
    config::save(config_dir, &cfg)?;
    Ok(AppConfigView::from(&cfg))
}

/// Replace the HTML → Markdown clipping options (all fields at once).
#[tauri::command]
pub fn app_config_set_clipping(
    active: tauri::State<'_, ActiveSession>,
    clipping: ClippingConfig,
) -> Result<AppConfigView, AppError> {
    require_session(&active)?;
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    app_config_set_clipping_impl(&dir, clipping)
}

fn app_config_set_clipping_impl(
    config_dir: &Path,
    clipping: ClippingConfig,
) -> Result<AppConfigView, AppError> {
    clipping.validate()?;
    let mut cfg = config::load(config_dir)?;
    cfg.clipping = clipping;
    config::save(config_dir, &cfg)?;
    Ok(AppConfigView::from(&cfg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::config::{AiConfig, AppConfig};
    use tempfile::tempdir;

    fn stored_key(dir: &Path, provider: &str) -> Option<String> {
        config::load(dir).unwrap().ai.providers[provider]
            .api_key
            .clone()
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
        let mut seed = AppConfig::default();
        seed.ai.providers.get_mut("openai").unwrap().api_key = Some("sk-secret".into());
        config::save(dir.path(), &seed).unwrap();
        let view = app_config_set_editor_impl(dir.path(), 15, true).unwrap();
        assert!(view.ai.providers["openai"].has_api_key);
        assert!(!serde_json::to_string(&view).unwrap().contains("sk-secret"));
        // …and the key is still on disk.
        assert_eq!(
            stored_key(dir.path(), "openai").as_deref(),
            Some("sk-secret")
        );
    }

    fn input() -> AiSettingsInput {
        AiSettingsInput {
            default_model: "anthropic@claude-sonnet-4".into(),
            temperature: 0.3,
            max_tokens: 2000,
            stream: false,
            heading_level: 2,
            infer_title_language: " Korean ".into(),
            chats_folder: "notes/ai/chats/".into(),
            agents_folder: "agents".into(),
        }
    }

    #[test]
    fn set_ai_persists_validated_settings() {
        let dir = tempdir().unwrap();
        let view = app_config_set_ai_impl(dir.path(), input()).unwrap();
        assert_eq!(view.ai.default_model, "anthropic@claude-sonnet-4");
        assert_eq!(view.ai.temperature, 0.3);
        assert_eq!(view.ai.max_tokens, 2000);
        assert!(!view.ai.stream);
        assert_eq!(view.ai.heading_level, 2);
        assert_eq!(view.ai.infer_title_language, "Korean");
        assert_eq!(view.ai.chats_folder, "notes/ai/chats");
        assert_eq!(view.ai.agents_folder, "agents");
        assert_eq!(config::load(dir.path()).unwrap().ai.heading_level, 2);
        // A bare model is stored with the default provider.
        let view = app_config_set_ai_impl(
            dir.path(),
            AiSettingsInput {
                default_model: "gpt-4o".into(),
                ..input()
            },
        )
        .unwrap();
        assert_eq!(view.ai.default_model, "openai@gpt-4o");
    }

    #[test]
    fn set_ai_rejects_bad_values_without_saving() {
        let dir = tempdir().unwrap();
        let bad = [
            AiSettingsInput {
                default_model: "nope@x".into(),
                ..input()
            },
            AiSettingsInput {
                default_model: " ".into(),
                ..input()
            },
            AiSettingsInput {
                temperature: 2.5,
                ..input()
            },
            AiSettingsInput {
                temperature: f64::NAN,
                ..input()
            },
            AiSettingsInput {
                max_tokens: 0,
                ..input()
            },
            AiSettingsInput {
                heading_level: 7,
                ..input()
            },
            AiSettingsInput {
                heading_level: 0,
                ..input()
            },
            AiSettingsInput {
                infer_title_language: "".into(),
                ..input()
            },
            AiSettingsInput {
                chats_folder: "../out".into(),
                ..input()
            },
            AiSettingsInput {
                agents_folder: "/abs".into(),
                ..input()
            },
        ];
        for s in bad {
            let label = format!("{s:?}");
            assert!(
                matches!(
                    app_config_set_ai_impl(dir.path(), s),
                    Err(AppError::Validation(_) | AppError::InvalidPath(_))
                ),
                "{label}"
            );
        }
        assert_eq!(config::load(dir.path()).unwrap().ai, AiConfig::default());
    }

    #[test]
    fn set_ai_provider_sets_keeps_and_clears_keys() {
        let dir = tempdir().unwrap();
        let view = app_config_set_ai_provider_impl(
            dir.path(),
            "openai".into(),
            None,
            Some(" sk-1 ".into()),
            false,
        )
        .unwrap();
        assert!(view.ai.providers["openai"].has_api_key);
        assert_eq!(stored_key(dir.path(), "openai").as_deref(), Some("sk-1"));
        // None / blank keeps the key; a URL change leaves it alone.
        app_config_set_ai_provider_impl(
            dir.path(),
            "openai".into(),
            Some("https://proxy.example.com/v1/".into()),
            Some("  ".into()),
            false,
        )
        .unwrap();
        assert_eq!(stored_key(dir.path(), "openai").as_deref(), Some("sk-1"));
        let ai = config::load(dir.path()).unwrap().ai;
        assert_eq!(
            ai.providers["openai"].base_url,
            "https://proxy.example.com/v1"
        );
        // clear wins over a new key.
        let view = app_config_set_ai_provider_impl(
            dir.path(),
            "openai".into(),
            None,
            Some("sk-2".into()),
            true,
        )
        .unwrap();
        assert!(!view.ai.providers["openai"].has_api_key);
        assert!(!serde_json::to_string(&view).unwrap().contains("sk-"));
    }

    #[test]
    fn set_ai_provider_rejects_unknown_or_insecure_without_saving() {
        let dir = tempdir().unwrap();
        for (p, url) in [
            ("nope", None),
            ("openai", Some("http://api.example.com/v1")),
            ("ollama", Some("file:///etc")),
        ] {
            assert!(matches!(
                app_config_set_ai_provider_impl(
                    dir.path(),
                    p.into(),
                    url.map(str::to_string),
                    Some("k".into()),
                    false
                ),
                Err(AppError::Validation(_))
            ));
        }
        assert_eq!(config::load(dir.path()).unwrap().ai, AiConfig::default());
        let view = app_config_set_ai_provider_impl(
            dir.path(),
            "ollama".into(),
            Some("http://127.0.0.1:11434".into()),
            None,
            false,
        )
        .unwrap();
        assert_eq!(
            view.ai.providers["ollama"].base_url,
            "http://127.0.0.1:11434"
        );
    }

    #[test]
    fn set_ai_and_set_ai_provider_leave_each_other_alone() {
        let dir = tempdir().unwrap();
        app_config_set_ai_provider_impl(dir.path(), "gemini".into(), None, Some("g".into()), false)
            .unwrap();
        let view = app_config_set_ai_impl(dir.path(), input()).unwrap();
        assert!(view.ai.providers["gemini"].has_api_key);
        let view = app_config_set_ai_provider_impl(
            dir.path(),
            "zai".into(),
            None,
            Some("z".into()),
            false,
        )
        .unwrap();
        assert_eq!(view.ai.default_model, "anthropic@claude-sonnet-4");
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

    #[test]
    fn set_appearance_persists_trimmed_values() {
        let dir = tempdir().unwrap();
        let view = app_config_set_appearance_impl(
            dir.path(),
            " forest ".into(),
            "  Inter, sans-serif ".into(),
            String::new(),
        )
        .unwrap();
        assert_eq!(view.appearance.palette, "forest");
        assert_eq!(view.appearance.ui_font, "Inter, sans-serif");
        assert_eq!(
            config::load(dir.path()).unwrap().appearance,
            view.appearance
        );
    }

    #[test]
    fn set_appearance_rejects_unknown_palette_or_bad_font() {
        let dir = tempdir().unwrap();
        assert!(
            app_config_set_appearance_impl(dir.path(), "neon".into(), "".into(), "".into())
                .is_err()
        );
        assert!(app_config_set_appearance_impl(
            dir.path(),
            "default".into(),
            "x; color: red".into(),
            "".into()
        )
        .is_err());
        assert_eq!(
            config::load(dir.path()).unwrap().appearance,
            AppearanceConfig::default()
        );
    }

    #[test]
    fn set_clipping_validates_and_persists() {
        let dir = tempdir().unwrap();
        let next = ClippingConfig {
            html_paste: "plain".into(),
            ..ClippingConfig::default()
        };
        let view = app_config_set_clipping_impl(dir.path(), next.clone()).unwrap();
        assert_eq!(view.clipping, next);
        let bad = ClippingConfig {
            tables: "csv".into(),
            ..ClippingConfig::default()
        };
        assert!(app_config_set_clipping_impl(dir.path(), bad).is_err());
        assert_eq!(config::load(dir.path()).unwrap().clipping, next);
    }
}
