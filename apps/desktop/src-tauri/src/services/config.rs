//! App-level config (per-OS) — see vault/wiki/app-config.md.
//!
//! - macOS:   `~/Library/Application Support/naiteh/config.json`
//! - Linux:   `~/.config/naiteh/config.json`           (or `$XDG_CONFIG_HOME/naiteh`)
//! - Windows: `%APPDATA%\naiteh\config.json`
//!
//! Per-vault config (`<vault>/.naiteh/config.json`) is a separate concern and
//! is created with a minimal stub by `vault_init`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::fs as fsx;

const APP_DIR_NAME: &str = "naiteh";
const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub active_vault: Option<String>,
    pub known_vaults: Vec<String>,
    pub theme: String,
    pub editor: EditorConfig,
    pub calendar: CalendarConfig,
    pub journal: JournalConfig,
    pub ai: AiConfig,
    pub appearance: AppearanceConfig,
    pub clipping: ClippingConfig,
}

/// Color palette + font families. An empty font string means "use the
/// built-in default stack" (wiki app-config.md, Appearance).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppearanceConfig {
    pub palette: String,
    pub ui_font: String,
    pub editor_font: String,
}

/// Palette ids the renderer ships CSS for. Keep in sync with
/// `apps/desktop/src/styles/palettes.ts`.
pub const PALETTES: &[&str] = &[
    "default", "ocean", "forest", "sunset", "lavender", "rose", "nord", "midnight",
];

/// Longest accepted font-family string.
pub const FONT_FAMILY_MAX_LEN: usize = 200;

/// How pasted / clipped HTML is turned into Markdown (wiki app-config.md,
/// Clipping). Every field is a closed set of string values, see
/// [`ClippingConfig::validate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ClippingConfig {
    /// `markdown` (convert) | `plain` (text only) | `html` (insert raw HTML).
    pub html_paste: String,
    /// `atx` (`# H`) | `setext` (underlined, h1/h2 only).
    pub heading_style: String,
    /// `-` | `*` | `+`.
    pub bullet_marker: String,
    /// `fenced` | `indented`.
    pub code_block_style: String,
    /// `_` | `*`.
    pub emphasis: String,
    /// `**` | `__`.
    pub strong: String,
    /// `inline` (`[t](url)`) | `reference` (`[t][1]` + link list at the end).
    pub link_style: String,
    /// `keep` (`![alt](src)`) | `drop`.
    pub images: String,
    /// `gfm` (pipe tables) | `html` (keep `<table>`) | `text` (cells as lines).
    pub tables: String,
}

impl ClippingConfig {
    pub fn validate(&self) -> Result<(), AppError> {
        fn one_of(field: &str, value: &str, allowed: &[&str]) -> Result<(), AppError> {
            if allowed.contains(&value) {
                Ok(())
            } else {
                Err(AppError::Validation(format!(
                    "clipping.{field} must be one of {allowed:?}, not {value:?}"
                )))
            }
        }
        one_of(
            "htmlPaste",
            &self.html_paste,
            &["markdown", "plain", "html"],
        )?;
        one_of("headingStyle", &self.heading_style, &["atx", "setext"])?;
        one_of("bulletMarker", &self.bullet_marker, &["-", "*", "+"])?;
        one_of(
            "codeBlockStyle",
            &self.code_block_style,
            &["fenced", "indented"],
        )?;
        one_of("emphasis", &self.emphasis, &["_", "*"])?;
        one_of("strong", &self.strong, &["**", "__"])?;
        one_of("linkStyle", &self.link_style, &["inline", "reference"])?;
        one_of("images", &self.images, &["keep", "drop"])?;
        one_of("tables", &self.tables, &["gfm", "html", "text"])?;
        Ok(())
    }
}

/// A font-family value must be short and free of characters that could
/// break out of a CSS declaration.
pub fn validate_font_family(raw: &str) -> Result<(), AppError> {
    if raw.chars().count() > FONT_FAMILY_MAX_LEN {
        return Err(AppError::Validation(format!(
            "font family is longer than {FONT_FAMILY_MAX_LEN} characters"
        )));
    }
    if raw
        .chars()
        .any(|c| matches!(c, ';' | '{' | '}' | '<' | '>' | '\\') || c.is_control())
    {
        return Err(AppError::Validation(
            "font family contains a forbidden character".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiConfig {
    pub api_key: Option<String>,
    pub model: String,
    pub base_url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorConfig {
    pub font_size: u16,
    pub line_wrapping: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CalendarConfig {
    pub sub_view: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct JournalConfig {
    pub split_ratio: f32,
}

/// The IPC shape of [`AppConfig`]: identical except that `ai` is an
/// [`AiConfigView`], so the API key never reaches the renderer. Every
/// command that returns app config returns this view; the on-disk
/// `config.json` keeps the full [`AppConfig`] (key included) unchanged.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfigView {
    pub active_vault: Option<String>,
    pub known_vaults: Vec<String>,
    pub theme: String,
    pub editor: EditorConfig,
    pub calendar: CalendarConfig,
    pub journal: JournalConfig,
    pub ai: AiConfigView,
    pub appearance: AppearanceConfig,
    pub clipping: ClippingConfig,
}

/// Wire shape of the AI settings: `{ hasApiKey, model, baseUrl }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    pub has_api_key: bool,
    pub model: String,
    pub base_url: String,
}

impl From<&AiConfig> for AiConfigView {
    fn from(ai: &AiConfig) -> Self {
        Self {
            has_api_key: ai.api_key.as_deref().is_some_and(|k| !k.trim().is_empty()),
            model: ai.model.clone(),
            base_url: ai.base_url.clone(),
        }
    }
}

impl From<&AppConfig> for AppConfigView {
    fn from(cfg: &AppConfig) -> Self {
        Self {
            active_vault: cfg.active_vault.clone(),
            known_vaults: cfg.known_vaults.clone(),
            theme: cfg.theme.clone(),
            editor: cfg.editor.clone(),
            calendar: cfg.calendar.clone(),
            journal: cfg.journal.clone(),
            ai: AiConfigView::from(&cfg.ai),
            appearance: cfg.appearance.clone(),
            clipping: cfg.clipping.clone(),
        }
    }
}

/// Validate an AI endpoint base URL: it must parse, and use `https` —
/// or plain `http` only for a loopback host (`localhost`, `127.0.0.1`,
/// `[::1]`), e.g. a local Ollama. Anything else would send the API key
/// and document text in clear text, or to a non-web scheme. Used both
/// when saving settings and right before every AI request.
pub fn validate_ai_base_url(raw: &str) -> Result<(), AppError> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|e| AppError::Validation(format!("AI base URL is not a valid URL: {e}")))?;
    match url.scheme() {
        "https" => {
            if url.host().is_none() {
                return Err(AppError::Validation("AI base URL has no host".into()));
            }
            Ok(())
        }
        "http" => {
            // The WHATWG parser normalizes hosts (lowercase domains,
            // canonical IPv4 such as `127.1` → `127.0.0.1`, bracketed
            // compressed IPv6), so exact comparison is sound.
            let loopback = matches!(
                url.host_str().map(str::to_ascii_lowercase).as_deref(),
                Some("localhost" | "127.0.0.1" | "[::1]")
            );
            if loopback {
                Ok(())
            } else {
                Err(AppError::Validation(
                    "AI base URL must use https (plain http is allowed only for localhost, \
                     127.0.0.1 or [::1])"
                        .into(),
                ))
            }
        }
        other => Err(AppError::Validation(format!(
            "AI base URL scheme must be https, not {other}"
        ))),
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            active_vault: None,
            known_vaults: Vec::new(),
            theme: "light".to_string(),
            editor: EditorConfig::default(),
            calendar: CalendarConfig::default(),
            journal: JournalConfig::default(),
            ai: AiConfig::default(),
            appearance: AppearanceConfig::default(),
            clipping: ClippingConfig::default(),
        }
    }
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            palette: "default".to_string(),
            ui_font: String::new(),
            editor_font: String::new(),
        }
    }
}

impl Default for ClippingConfig {
    fn default() -> Self {
        Self {
            html_paste: "markdown".to_string(),
            heading_style: "atx".to_string(),
            bullet_marker: "-".to_string(),
            code_block_style: "fenced".to_string(),
            emphasis: "_".to_string(),
            strong: "**".to_string(),
            link_style: "inline".to_string(),
            images: "keep".to_string(),
            tables: "gfm".to_string(),
        }
    }
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            model: "gpt-4o-mini".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
        }
    }
}

impl Default for EditorConfig {
    fn default() -> Self {
        Self {
            font_size: 14,
            line_wrapping: true,
        }
    }
}

impl Default for CalendarConfig {
    fn default() -> Self {
        Self {
            sub_view: "timeline".to_string(),
        }
    }
}

impl Default for JournalConfig {
    fn default() -> Self {
        Self { split_ratio: 0.5 }
    }
}

/// Per-OS app config directory (e.g. `~/Library/Application Support/naiteh`).
pub fn default_app_config_dir() -> Result<PathBuf, AppError> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::NotFound("OS app config directory unavailable".into()))?;
    Ok(base.join(APP_DIR_NAME))
}

/// `<config_dir>/config.json`.
pub fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join(CONFIG_FILE)
}

/// Load app config. If the file does not exist yet, returns `Default::default()`.
pub fn load(config_dir: &Path) -> Result<AppConfig, AppError> {
    let path = config_path(config_dir);
    match fsx::read_json::<AppConfig>(&path) {
        Ok(cfg) => Ok(cfg),
        Err(AppError::NotFound(_)) => Ok(AppConfig::default()),
        Err(e) => Err(e),
    }
}

/// Persist app config atomically.
pub fn save(config_dir: &Path, cfg: &AppConfig) -> Result<(), AppError> {
    fsx::write_json(&config_path(config_dir), cfg)
}

/// Resolve the active vault root from app config. Errors if no vault
/// has been chosen yet (`AppError::NotFound`).
pub fn current_vault_root() -> Result<PathBuf, AppError> {
    let dir = default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    let cfg = load(&dir)?;
    cfg.active_vault
        .map(PathBuf::from)
        .ok_or_else(|| AppError::NotFound("no active vault selected".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_dir_ends_with_naiteh() {
        let dir = default_app_config_dir().unwrap();
        assert_eq!(dir.file_name().and_then(|n| n.to_str()), Some(APP_DIR_NAME));
    }

    #[test]
    fn default_dir_matches_os_convention() {
        let dir = default_app_config_dir().unwrap();
        let dir_str = dir.to_string_lossy();
        if cfg!(target_os = "macos") {
            assert!(
                dir_str.contains("Library/Application Support"),
                "macOS path mismatch: {dir_str}"
            );
        } else if cfg!(target_os = "linux") {
            assert!(
                dir_str.contains("/.config/") || dir_str.contains("/config/"),
                "Linux path mismatch: {dir_str}"
            );
        } else if cfg!(target_os = "windows") {
            let lower = dir_str.to_ascii_lowercase();
            assert!(
                lower.contains("appdata"),
                "Windows path mismatch: {dir_str}"
            );
        }
    }

    #[test]
    fn default_config_round_trip() {
        let dir = tempdir().unwrap();
        let cfg = AppConfig::default();
        save(dir.path(), &cfg).unwrap();
        let back = load(dir.path()).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn populated_config_round_trip() {
        let dir = tempdir().unwrap();
        let cfg = AppConfig {
            active_vault: Some("/tmp/vault-a".into()),
            known_vaults: vec!["/tmp/vault-a".into(), "/tmp/vault-b".into()],
            theme: "light".into(),
            editor: EditorConfig {
                font_size: 16,
                line_wrapping: false,
            },
            calendar: CalendarConfig {
                sub_view: "month".into(),
            },
            journal: JournalConfig { split_ratio: 0.3 },
            ai: AiConfig {
                api_key: Some("sk-test".into()),
                model: "gpt-4o-mini".into(),
                base_url: "https://api.openai.com/v1".into(),
            },
            appearance: AppearanceConfig {
                palette: "ocean".into(),
                ui_font: "Inter, sans-serif".into(),
                editor_font: "\"JetBrains Mono\", monospace".into(),
            },
            clipping: ClippingConfig {
                link_style: "reference".into(),
                ..ClippingConfig::default()
            },
        };
        save(dir.path(), &cfg).unwrap();
        let back = load(dir.path()).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn load_missing_returns_default() {
        let dir = tempdir().unwrap();
        let cfg = load(dir.path()).unwrap();
        assert_eq!(cfg, AppConfig::default());
    }

    #[test]
    fn load_corrupt_returns_config_corrupt() {
        let dir = tempdir().unwrap();
        std::fs::write(config_path(dir.path()), b"{ broken").unwrap();
        let err = load(dir.path()).unwrap_err();
        assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
    }

    #[test]
    fn view_hides_the_api_key() {
        let cfg = AppConfig {
            ai: AiConfig {
                api_key: Some("sk-secret".into()),
                ..AiConfig::default()
            },
            ..AppConfig::default()
        };
        let view = AppConfigView::from(&cfg);
        assert!(view.ai.has_api_key);
        let json = serde_json::to_value(&view).unwrap();
        assert!(!json.to_string().contains("sk-secret"));
        assert_eq!(
            json["ai"],
            serde_json::json!({
                "hasApiKey": true,
                "model": "gpt-4o-mini",
                "baseUrl": "https://api.openai.com/v1"
            })
        );
        assert!(json.get("activeVault").is_some());
        assert!(!AppConfigView::from(&AppConfig::default()).ai.has_api_key);
    }

    #[test]
    fn ai_base_url_validation() {
        for ok in [
            "https://api.openai.com/v1",
            "https://example.com",
            "http://localhost:11434/v1",
            "http://LOCALHOST:11434/v1",
            "http://127.0.0.1:11434/v1",
            "http://[::1]:11434/v1",
        ] {
            assert!(validate_ai_base_url(ok).is_ok(), "{ok} should be accepted");
        }
        for bad in [
            "",
            "not a url",
            "http://api.openai.com/v1",
            "http://192.168.1.10:11434/v1",
            "http://localhost.evil.com/v1",
            "file:///etc/passwd",
            "ftp://example.com",
            "javascript:alert(1)",
        ] {
            assert!(
                matches!(validate_ai_base_url(bad), Err(AppError::Validation(_))),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn old_config_without_new_sections_loads_defaults() {
        let dir = tempdir().unwrap();
        std::fs::write(config_path(dir.path()), br#"{"theme":"light"}"#).unwrap();
        let cfg = load(dir.path()).unwrap();
        assert_eq!(cfg.appearance, AppearanceConfig::default());
        assert_eq!(cfg.clipping, ClippingConfig::default());
    }

    #[test]
    fn clipping_validation() {
        assert!(ClippingConfig::default().validate().is_ok());
        let bad = ClippingConfig {
            bullet_marker: "#".into(),
            ..ClippingConfig::default()
        };
        assert!(matches!(bad.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn font_family_validation() {
        assert!(validate_font_family("").is_ok());
        assert!(validate_font_family("\"Noto Sans KR\", sans-serif").is_ok());
        for bad in ["a; color: red", "x}", "<b>", "a\\b"] {
            assert!(validate_font_family(bad).is_err(), "{bad:?}");
        }
        assert!(validate_font_family(&"a".repeat(FONT_FAMILY_MAX_LEN + 1)).is_err());
    }

    #[test]
    fn camel_case_serialization() {
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"activeVault\""));
        assert!(json.contains("\"knownVaults\""));
        assert!(json.contains("\"fontSize\""));
        assert!(json.contains("\"lineWrapping\""));
        assert!(json.contains("\"subView\""));
        assert!(json.contains("\"splitRatio\""));
    }
}
