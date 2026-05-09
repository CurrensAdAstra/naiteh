//! App-level config (per-OS) — see architecture.md §8.
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
