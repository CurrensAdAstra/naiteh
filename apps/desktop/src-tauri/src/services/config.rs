//! App-level config (per-OS) — see vault/wiki/app-config.md.
//!
//! - macOS:   `~/Library/Application Support/naiteh/config.json`
//! - Linux:   `~/.config/naiteh/config.json`           (or `$XDG_CONFIG_HOME/naiteh`)
//! - Windows: `%APPDATA%\naiteh\config.json`
//!
//! Per-vault config (`<vault>/.naiteh/config.json`) is a separate concern and
//! is created with a minimal stub by `vault_init`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::domain::AppError;
use crate::services::credentials::{self, CredentialRef, CredentialStore, Transaction};
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

/// Provider ids with their default base URLs (wiki app-config.md, "AI").
/// The order is the order the Settings UI lists them in.
pub const AI_PROVIDERS: &[(&str, &str)] = &[
    ("openai", "https://api.openai.com/v1"),
    ("anthropic", "https://api.anthropic.com"),
    ("gemini", "https://generativelanguage.googleapis.com"),
    ("openrouter", "https://openrouter.ai/api/v1"),
    ("zai", "https://api.z.ai/api/paas/v4"),
    ("ollama", "http://localhost:11434"),
    ("lmstudio", "http://localhost:1234/v1"),
];

/// Default base URL of a known provider id.
pub fn default_provider_base_url(id: &str) -> Option<&'static str> {
    AI_PROVIDERS
        .iter()
        .find(|(p, _)| *p == id)
        .map(|(_, url)| *url)
}

/// Chat-in-note AI settings (a port of the chatgpt-md Obsidian plugin;
/// wiki app-config.md, "AI"). Deserialized through [`AiConfigOnDisk`] so
/// pre-chat `config.json` files (`apiKey` / `model` / `baseUrl`, plus the
/// removed `chat` section) still load and are migrated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "AiConfigOnDisk", rename_all = "camelCase")]
pub struct AiConfig {
    /// Providers explicitly added in Settings, in display order.
    pub added_providers: Vec<String>,
    /// `provider@model`.
    pub default_model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub stream: bool,
    /// Markdown heading level (1–6) of the `role::` headers the renderer writes.
    pub heading_level: u8,
    pub infer_title_language: String,
    /// Vault-relative folder new chat notes are created in.
    pub chats_folder: String,
    /// Vault-relative folder `agent: <name>` resolves against.
    pub agents_folder: String,
    /// Keyed by provider id; always holds every id in [`AI_PROVIDERS`].
    pub providers: BTreeMap<String, ProviderConfig>,
}

/// Legacy plaintext is deserialize-only. New writes persist `apiKeyRef`.
#[derive(Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_ref: Option<CredentialRef>,
    pub base_url: String,
}

impl ProviderConfig {
    pub fn has_key(&self) -> bool {
        self.api_key_ref.is_some() || self.key().is_some()
    }

    /// In-memory key, when non-blank. Network callers must use
    /// [`resolve_provider`] first, never send a loaded legacy value directly.
    pub fn key(&self) -> Option<&str> {
        self.api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
    }
}

impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("has_api_key", &self.has_key())
            .field("base_url", &self.base_url)
            .finish()
    }
}

pub const AI_TEMPERATURE_MAX: f64 = 2.0;
pub const AI_MAX_TOKENS_MAX: u32 = 1_000_000;
pub const AI_LANGUAGE_MAX_LEN: usize = 50;

/// Raw on-disk shape: every field optional plus the legacy (pre-chat)
/// fields. Unknown fields (e.g. the removed `chat`) are ignored.
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AiConfigOnDisk {
    added_providers: Option<Vec<String>>,
    default_model: Option<String>,
    temperature: Option<f64>,
    max_tokens: Option<u32>,
    stream: Option<bool>,
    heading_level: Option<u8>,
    infer_title_language: Option<String>,
    chats_folder: Option<String>,
    agents_folder: Option<String>,
    providers: BTreeMap<String, ProviderConfig>,
    // Legacy single-endpoint settings (AI Assist era).
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
}

/// `http://localhost:11434…` (or `127.0.0.1` / `[::1]`) — the legacy
/// OpenAI-compatible Ollama endpoint. Returns the origin to use as the
/// native Ollama base URL.
fn legacy_ollama_origin(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]");
    (loopback && url.port_or_known_default() == Some(11434))
        .then(|| format!("{}://{}:11434", url.scheme(), host))
}

impl From<AiConfigOnDisk> for AiConfig {
    fn from(raw: AiConfigOnDisk) -> Self {
        let d = AiConfig::default();
        let mut providers = d.providers.clone();
        for (id, p) in raw.providers {
            if let Some(slot) = providers.get_mut(&id) {
                if !p.base_url.trim().is_empty() {
                    slot.base_url = p.base_url.trim().to_string();
                }
                slot.api_key = p.api_key.filter(|k| !k.trim().is_empty());
                slot.api_key_ref = p.api_key_ref;
            }
        }
        let mut default_model = raw.default_model.filter(|m| !m.trim().is_empty());
        let has_legacy = raw.api_key.is_some() || raw.model.is_some() || raw.base_url.is_some();
        if default_model.is_none() && has_legacy {
            let legacy_model = raw
                .model
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty());
            let legacy_url = raw.base_url.unwrap_or_default();
            if let Some(origin) = legacy_ollama_origin(&legacy_url) {
                if let Some(p) = providers.get_mut("ollama") {
                    p.base_url = origin;
                }
                default_model = legacy_model.map(|m| format!("ollama@{m}"));
            } else {
                if let Some(p) = providers.get_mut("openai") {
                    if !legacy_url.trim().is_empty() {
                        p.base_url = legacy_url.trim().to_string();
                    }
                    if let Some(k) = raw
                        .api_key
                        .filter(|k| p.api_key_ref.is_none() && !k.trim().is_empty())
                    {
                        p.api_key = Some(k.trim().to_string());
                    }
                }
                default_model = legacy_model.map(|m| format!("openai@{m}"));
            }
        }
        let default_model = default_model.unwrap_or(d.default_model);
        let added_providers = match raw.added_providers {
            Some(ids) => {
                let mut added = Vec::new();
                for id in ids {
                    let id = id.trim().to_string();
                    if providers.contains_key(&id) && !added.contains(&id) {
                        added.push(id);
                    }
                }
                added
            }
            None => AI_PROVIDERS
                .iter()
                .filter(|(id, url)| {
                    let p = &providers[*id];
                    p.has_key()
                        || (matches!(*id, "ollama" | "lmstudio")
                            && (default_model.starts_with(&format!("{id}@"))
                                || p.base_url.trim_end_matches('/') != url.trim_end_matches('/')))
                })
                .map(|(id, _)| id.to_string())
                .collect(),
        };
        AiConfig {
            added_providers,
            default_model,
            temperature: raw
                .temperature
                .filter(|t| t.is_finite() && (0.0..=AI_TEMPERATURE_MAX).contains(t))
                .unwrap_or(d.temperature),
            max_tokens: raw
                .max_tokens
                .filter(|t| (1..=AI_MAX_TOKENS_MAX).contains(t))
                .unwrap_or(d.max_tokens),
            stream: raw.stream.unwrap_or(d.stream),
            heading_level: raw
                .heading_level
                .filter(|h| (1..=6).contains(h))
                .unwrap_or(d.heading_level),
            infer_title_language: raw
                .infer_title_language
                .filter(|l| !l.trim().is_empty())
                .unwrap_or(d.infer_title_language),
            chats_folder: raw
                .chats_folder
                .filter(|f| !f.trim().is_empty())
                .unwrap_or(d.chats_folder),
            agents_folder: raw
                .agents_folder
                .filter(|f| !f.trim().is_empty())
                .unwrap_or(d.agents_folder),
            providers,
        }
    }
}

impl AiConfig {
    /// A known provider's settings; `None` for an unknown id.
    pub fn provider(&self, id: &str) -> Option<ProviderConfig> {
        let default = default_provider_base_url(id)?;
        Some(self.providers.get(id).cloned().unwrap_or(ProviderConfig {
            api_key: None,
            api_key_ref: None,
            base_url: default.to_string(),
        }))
    }
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
/// `config.json` stores credential references; legacy plaintext is never exposed.
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

/// Wire shape of the AI settings (wiki app-config.md, "AI"): the
/// [`AiConfig`] scalars plus `providers: { <id>: { hasApiKey, baseUrl } }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigView {
    pub added_providers: Vec<String>,
    pub default_model: String,
    pub temperature: f64,
    pub max_tokens: u32,
    pub stream: bool,
    pub heading_level: u8,
    pub infer_title_language: String,
    pub chats_folder: String,
    pub agents_folder: String,
    pub providers: BTreeMap<String, ProviderView>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub has_api_key: bool,
    pub base_url: String,
}

impl From<&AiConfig> for AiConfigView {
    fn from(ai: &AiConfig) -> Self {
        Self {
            added_providers: ai.added_providers.clone(),
            default_model: ai.default_model.clone(),
            temperature: ai.temperature,
            max_tokens: ai.max_tokens,
            stream: ai.stream,
            heading_level: ai.heading_level,
            infer_title_language: ai.infer_title_language.clone(),
            chats_folder: ai.chats_folder.clone(),
            agents_folder: ai.agents_folder.clone(),
            providers: ai
                .providers
                .iter()
                .map(|(id, p)| {
                    (
                        id.clone(),
                        ProviderView {
                            has_api_key: p.has_key(),
                            base_url: p.base_url.clone(),
                        },
                    )
                })
                .collect(),
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
            added_providers: Vec::new(),
            default_model: "openai@gpt-4.1-mini".to_string(),
            temperature: 0.7,
            max_tokens: 4096,
            stream: true,
            heading_level: 3,
            infer_title_language: "English".to_string(),
            chats_folder: "notes/chats".to_string(),
            agents_folder: "notes/agents".to_string(),
            providers: AI_PROVIDERS
                .iter()
                .map(|(id, url)| {
                    (
                        id.to_string(),
                        ProviderConfig {
                            api_key: None,
                            api_key_ref: None,
                            base_url: url.to_string(),
                        },
                    )
                })
                .collect(),
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

/// Serializes config read-modify-write cycles, including credential staging.
/// This is a process-local lock, not a multi-process file lock.
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

/// Load metadata only. No native credential access or migration on ordinary reads.
pub fn load(config_dir: &Path) -> Result<AppConfig, AppError> {
    credentials::read_json(&config_path(config_dir)).map(|(_, cfg)| cfg)
}

/// Persist a supplied config, staging any supplied plaintext keys first.
/// Use [`modify`] for read-modify-write operations to avoid lost updates.
#[cfg(test)]
pub fn save(config_dir: &Path, cfg: &AppConfig) -> Result<(), AppError> {
    credentials::with_store(|store| {
        let touched: Vec<&str> = cfg.ai.providers.keys().map(String::as_str).collect();
        modify_with_store(config_dir, store, &touched, |current| {
            *current = cfg.clone();
            Ok(())
        })
        .map(|_| ())
    })
}

pub fn modify(
    config_dir: &Path,
    f: impl FnOnce(&mut AppConfig) -> Result<(), AppError>,
) -> Result<AppConfig, AppError> {
    credentials::with_store(|store| modify_with_store(config_dir, store, &[], f))
}

/// `touch_key` forces migration even when explicitly setting the same legacy key.
pub fn modify_ai_provider(
    config_dir: &Path,
    id: &str,
    touch_key: bool,
    f: impl FnOnce(&mut ProviderConfig) -> Result<(), AppError>,
) -> Result<AppConfig, AppError> {
    let touched = [id];
    credentials::with_store(|store| {
        modify_with_store(
            config_dir,
            store,
            if touch_key { &touched } else { &[] },
            |cfg| {
                let slot = cfg
                    .ai
                    .providers
                    .get_mut(id)
                    .ok_or_else(|| AppError::Validation("Unknown AI provider".into()))?;
                f(slot)
            },
        )
    })
}

fn modify_with_store(
    config_dir: &Path,
    store: &dyn CredentialStore,
    touched: &[&str],
    f: impl FnOnce(&mut AppConfig) -> Result<(), AppError>,
) -> Result<AppConfig, AppError> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (mut raw, before): (_, AppConfig) = credentials::read_json(&config_path(config_dir))?;
    let previous = raw.clone();
    let mut after = before.clone();
    f(&mut after)?;
    let legacy_provider = if raw
        .pointer("/ai/baseUrl")
        .and_then(Value::as_str)
        .and_then(legacy_ollama_origin)
        .is_some()
    {
        "ollama"
    } else {
        "openai"
    };
    let legacy_endpoint_changed = before
        .ai
        .providers
        .get(legacy_provider)
        .map(|p| &p.base_url)
        != after.ai.providers.get(legacy_provider).map(|p| &p.base_url);
    let normalizes_legacy = raw.get("ai").is_some_and(|ai| {
        !ai.get("defaultModel")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty())
            && ["model", "baseUrl", "apiKey"]
                .iter()
                .any(|key| ai.get(key).is_some())
    }) && (before.ai.default_model != after.ai.default_model
        || legacy_endpoint_changed);
    let migrate_root = normalizes_legacy && uses_legacy_root_key(&raw);
    let mut transaction = Transaction::new(store);
    for (id, slot) in &mut after.ai.providers {
        let old = before.ai.providers.get(id).cloned().unwrap_or_default();
        let key_changed = touched.contains(&id.as_str()) || old.api_key != slot.api_key;
        let superseded = key_changed || old.api_key_ref != slot.api_key_ref;
        if superseded || (migrate_root && id == "openai") {
            migrate_provider(&mut raw, id, &mut transaction, superseded)?;
            if key_changed || slot.api_key_ref.is_none() {
                if let Some(key) = slot.key() {
                    slot.api_key_ref = Some(transaction.stage(key)?);
                }
            }
            slot.api_key = None;
            let object = provider_object(&mut raw, id);
            object.remove("apiKey");
            credentials::set_reference(object, "apiKeyRef", slot.api_key_ref.as_ref())?;
        }
    }
    credentials::merge_changes(
        &mut raw,
        &credentials::json(&before)?,
        &credentials::json(&after)?,
    );
    if normalizes_legacy {
        // Adding defaultModel disables the old model/baseUrl interpretation.
        // Preserve its effective endpoints, and migrate the effective root key
        // first rather than silently losing it or sending it to a default host.
        for (id, slot) in &after.ai.providers {
            provider_object(&mut raw, id)
                .insert("baseUrl".into(), Value::String(slot.base_url.clone()));
        }
        raw["ai"]["defaultModel"] = Value::String(after.ai.default_model.clone());
    }
    transaction.finish(&previous, &raw, || {
        fsx::write_json(&config_path(config_dir), &raw)
    })?;
    Ok(after)
}

fn provider_object<'a>(raw: &'a mut Value, id: &str) -> &'a mut Map<String, Value> {
    raw.as_object_mut()
        .unwrap()
        .entry("ai")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .unwrap()
        .entry("providers")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .unwrap()
        .entry(id)
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .unwrap()
}

fn uses_legacy_root_key(raw: &Value) -> bool {
    let Some(ai) = raw.get("ai") else {
        return false;
    };
    !ai.get("defaultModel")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
        && ai.get("apiKey").is_some()
        && legacy_ollama_origin(ai.get("baseUrl").and_then(Value::as_str).unwrap_or("")).is_none()
}

fn migrate_provider(
    raw: &mut Value,
    id: &str,
    transaction: &mut Transaction<'_>,
    superseded: bool,
) -> Result<usize, AppError> {
    let root_key = id == "openai" && uses_legacy_root_key(raw);
    let has_legacy = raw
        .get("ai")
        .and_then(|ai| ai.get("providers"))
        .and_then(|p| p.get(id))
        .is_some_and(|p| p.get("apiKey").is_some());
    if !(root_key || has_legacy) {
        return Ok(0);
    }
    let object = provider_object(raw, id);
    let had_reference = object.get("apiKeyRef").is_some_and(|r| !r.is_null());
    if root_key && had_reference && !superseded {
        let existing = serde_json::from_value(object["apiKeyRef"].clone())
            .map_err(|_| AppError::ConfigCorrupt("Invalid AI credential reference".into()))?;
        transaction.check_reference(&existing)?;
    }
    let mut count =
        credentials::migrate_slot(transaction, object, "apiKey", "apiKeyRef", true, superseded)?;
    if root_key {
        let legacy = raw["ai"].as_object_mut().unwrap().remove("apiKey");
        if let Some(key) = legacy
            .as_ref()
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let staged = transaction.stage(key)?;
            count += 1;
            if !had_reference {
                credentials::set_reference(provider_object(raw, id), "apiKeyRef", Some(&staged))?;
            }
        }
    }
    Ok(count)
}

pub fn migrate_credentials(config_dir: &Path) -> Result<usize, AppError> {
    credentials::with_store(|store| migrate_credentials_with_store(config_dir, store))
}

fn migrate_credentials_with_store(
    config_dir: &Path,
    store: &dyn CredentialStore,
) -> Result<usize, AppError> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (mut raw, _): (_, AppConfig) = credentials::read_json(&config_path(config_dir))?;
    let previous = raw.clone();
    let mut transaction = Transaction::new(store);
    let mut ids: Vec<String> = raw
        .pointer("/ai/providers")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    if uses_legacy_root_key(&raw) && !ids.iter().any(|id| id == "openai") {
        ids.push("openai".into());
    }
    let mut count = 0;
    for id in ids {
        count += migrate_provider(&mut raw, &id, &mut transaction, false)?;
    }
    // Obsolete root keys (including old Ollama keys) are not used, but must
    // still be stored successfully before their plaintext can be removed.
    if let Some(ai) = raw.get_mut("ai").and_then(Value::as_object_mut) {
        if let Some(key) = ai.remove("apiKey") {
            if let Some(key) = key.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                transaction.stage(key)?;
                count += 1;
            }
        }
    }
    if raw != previous {
        transaction.finish(&previous, &raw, || {
            fsx::write_json(&config_path(config_dir), &raw)
        })?;
    }
    Ok(count)
}

/// Resolve only this provider, migrating its effective legacy key on use.
/// A missing/unavailable referenced credential never falls back to plaintext.
pub fn resolve_provider(config_dir: &Path, id: &str) -> Result<ProviderConfig, AppError> {
    credentials::with_store(|store| resolve_provider_with_store(config_dir, id, store))
}

fn resolve_provider_with_store(
    config_dir: &Path,
    id: &str,
    store: &dyn CredentialStore,
) -> Result<ProviderConfig, AppError> {
    let _guard = CONFIG_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (mut raw, before): (_, AppConfig) = credentials::read_json(&config_path(config_dir))?;
    if before.ai.provider(id).is_none() {
        return Err(AppError::Validation("Unknown AI provider".into()));
    }
    let previous = raw.clone();
    let mut transaction = Transaction::new(store);
    migrate_provider(&mut raw, id, &mut transaction, false)?;
    if raw != previous {
        transaction.finish(&previous, &raw, || {
            fsx::write_json(&config_path(config_dir), &raw)
        })?;
    }
    let cfg: AppConfig = serde_json::from_value(raw)
        .map_err(|_| AppError::ConfigCorrupt("Invalid AI configuration".into()))?;
    let mut provider = cfg.ai.provider(id).unwrap();
    provider.api_key = provider
        .api_key_ref
        .as_ref()
        .map(|reference| credentials::resolve(store, reference))
        .transpose()?;
    Ok(provider)
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
                temperature: 0.2,
                default_model: "anthropic@claude-x".into(),
                ..AiConfig::default()
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
        let mut cfg = AppConfig::default();
        cfg.ai.providers.get_mut("anthropic").unwrap().api_key = Some("sk-secret".into());
        let view = AppConfigView::from(&cfg);
        assert!(view.ai.providers["anthropic"].has_api_key);
        assert!(!view.ai.providers["openai"].has_api_key);
        let json = serde_json::to_value(&view).unwrap();
        assert!(!json.to_string().contains("sk-secret"));
        assert_eq!(json["ai"]["defaultModel"], "openai@gpt-4.1-mini");
        assert_eq!(json["ai"]["temperature"], 0.7);
        assert_eq!(json["ai"]["maxTokens"], 4096);
        assert_eq!(json["ai"]["stream"], true);
        assert_eq!(json["ai"]["headingLevel"], 3);
        assert_eq!(json["ai"]["inferTitleLanguage"], "English");
        assert_eq!(json["ai"]["chatsFolder"], "notes/chats");
        assert_eq!(json["ai"]["agentsFolder"], "notes/agents");
        assert_eq!(
            json["ai"]["providers"]["anthropic"],
            serde_json::json!({ "hasApiKey": true, "baseUrl": "https://api.anthropic.com" })
        );
        assert_eq!(json["ai"]["providers"].as_object().unwrap().len(), 7);
        assert!(json.get("activeVault").is_some());
    }

    #[test]
    fn ai_config_round_trips_with_references_only_on_disk() {
        let dir = tempdir().unwrap();
        let mut cfg = AppConfig::default();
        cfg.ai.providers.get_mut("openai").unwrap().api_key = Some("sk-1".into());
        cfg.ai.heading_level = 2;
        save(dir.path(), &cfg).unwrap();
        let back = load(dir.path()).unwrap();
        assert_eq!(back.ai.heading_level, cfg.ai.heading_level);
        assert!(back.ai.providers["openai"].api_key.is_none());
        assert!(back.ai.providers["openai"].api_key_ref.is_some());
        assert_eq!(
            resolve_provider(dir.path(), "openai").unwrap().key(),
            Some("sk-1")
        );
        let raw = std::fs::read_to_string(config_path(dir.path())).unwrap();
        assert!(!raw.contains("sk-1"));
        assert!(raw.contains("apiKeyRef"));
        assert!(!format!("{back:?}").contains("sk-1"));
    }

    #[test]
    fn migration_is_idempotent_and_preserves_legacy_endpoint_and_unknown_fields() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        let legacy = serde_json::json!({"theme":"dark", "extra":true, "ai":{
            "apiKey":" sk-old ", "model":"old-model", "baseUrl":"https://proxy.example/v1",
            "providers":{"gemini":{"apiKey":"g-secret"}, "future":{"apiKey":"f-secret"}}
        }});
        fsx::write_json(&config_path(dir.path()), &legacy).unwrap();
        assert_eq!(
            migrate_credentials_with_store(dir.path(), &store).unwrap(),
            3
        );
        let raw = std::fs::read_to_string(config_path(dir.path())).unwrap();
        for secret in ["sk-old", "g-secret", "f-secret"] {
            assert!(!raw.contains(secret));
        }
        let cfg = load(dir.path()).unwrap();
        assert_eq!(cfg.ai.default_model, "openai@old-model");
        let provider = resolve_provider_with_store(dir.path(), "openai", &store).unwrap();
        assert_eq!(provider.base_url, "https://proxy.example/v1");
        assert_eq!(provider.key(), Some("sk-old"));
        assert!(serde_json::from_str::<Value>(&raw).unwrap()["extra"]
            .as_bool()
            .unwrap());
        assert_eq!(
            migrate_credentials_with_store(dir.path(), &store).unwrap(),
            0
        );
        assert_eq!(
            std::fs::read_to_string(config_path(dir.path())).unwrap(),
            raw
        );
        assert_eq!(store.len(), 3);
    }

    #[test]
    fn failed_migration_preserves_original_bytes_and_is_retryable() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        let original = br#"{"ai":{"providers":{"openai":{"apiKey":"old-secret"},"zai":{"apiKey":"other-secret"}}}}"#;
        fsx::atomic_write(&config_path(dir.path()), original).unwrap();
        store.fail_after_writes(1);
        let error = migrate_credentials_with_store(dir.path(), &store).unwrap_err();
        assert!(!format!("{error:?}").contains("old-secret"));
        assert_eq!(std::fs::read(config_path(dir.path())).unwrap(), original);
        assert_eq!(store.len(), 0);
        store.fail_after_writes(usize::MAX);
        assert_eq!(
            migrate_credentials_with_store(dir.path(), &store).unwrap(),
            2
        );
    }

    #[test]
    fn locked_store_does_not_block_unrelated_reads_or_vault_updates() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        store.unavailable(true);
        fsx::atomic_write(
            &config_path(dir.path()),
            br#"{"ai":{"apiKey":"old-secret","model":"m"}}"#,
        )
        .unwrap();
        assert!(AppConfigView::from(&load(dir.path()).unwrap()).ai.providers["openai"].has_api_key);
        modify_with_store(dir.path(), &store, &[], |cfg| {
            cfg.active_vault = Some("/vault".into());
            cfg.editor.font_size = 20;
            Ok(())
        })
        .unwrap();
        assert_eq!(
            load(dir.path()).unwrap().ai.providers["openai"].key(),
            Some("old-secret")
        );
        assert!(resolve_provider_with_store(dir.path(), "ollama", &store)
            .unwrap()
            .key()
            .is_none());
        let before = std::fs::read(config_path(dir.path())).unwrap();
        for clear in [false, true] {
            assert!(modify_with_store(dir.path(), &store, &["openai"], |cfg| {
                let slot = cfg.ai.providers.get_mut("openai").unwrap();
                slot.api_key = (!clear).then(|| "new-secret".into());
                slot.api_key_ref = None;
                Ok(())
            })
            .is_err());
            assert_eq!(std::fs::read(config_path(dir.path())).unwrap(), before);
        }
        assert!(resolve_provider_with_store(dir.path(), "openai", &store).is_err());
    }

    #[test]
    fn changing_legacy_default_model_migrates_key_without_changing_endpoint() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        fsx::atomic_write(
            &config_path(dir.path()),
            br#"{"ai":{"apiKey":"old-secret","model":"m","baseUrl":"https://proxy.example/v1"}}"#,
        )
        .unwrap();
        modify_with_store(dir.path(), &store, &[], |cfg| {
            cfg.ai.default_model = "ollama@local".into();
            Ok(())
        })
        .unwrap();
        let provider = resolve_provider_with_store(dir.path(), "openai", &store).unwrap();
        assert_eq!(provider.key(), Some("old-secret"));
        assert_eq!(provider.base_url, "https://proxy.example/v1");
        assert_eq!(load(dir.path()).unwrap().ai.default_model, "ollama@local");
    }

    #[test]
    fn mixed_ai_normalization_preserves_authoritative_reference() {
        for change_model in [true, false] {
            let dir = tempdir().unwrap();
            let store = credentials::MemoryStore::default();
            let mut transaction = Transaction::new(&store);
            let reference = transaction.stage("authoritative-key").unwrap();
            let original = serde_json::json!({"ai": {
                "apiKey": "root-shadowed-key", "model": "old-model",
                "baseUrl": "https://old.example/v1",
                "providers": {"openai": {
                    "apiKey": "provider-shadowed-key", "apiKeyRef": reference
                }}
            }});
            transaction
                .finish(&Value::Null, &original, || {
                    fsx::write_json(&config_path(dir.path()), &original)
                })
                .unwrap();
            let cfg = modify_with_store(dir.path(), &store, &[], |cfg| {
                if change_model {
                    cfg.ai.default_model = "ollama@local".into();
                } else {
                    cfg.ai.providers.get_mut("openai").unwrap().base_url =
                        "https://new.example/v1".into();
                }
                Ok(())
            })
            .unwrap();
            assert_eq!(
                cfg.ai.providers["openai"].api_key_ref.as_ref(),
                Some(&reference)
            );
            let loaded = load(dir.path()).unwrap();
            assert_eq!(
                loaded.ai.providers["openai"].api_key_ref.as_ref(),
                Some(&reference)
            );
            assert_eq!(
                credentials::resolve(&store, &reference).unwrap(),
                "authoritative-key"
            );
            assert_eq!(
                resolve_provider_with_store(dir.path(), "openai", &store)
                    .unwrap()
                    .key(),
                Some("authoritative-key")
            );
            assert_eq!(store.len(), 1);
            let raw = std::fs::read_to_string(config_path(dir.path())).unwrap();
            assert!(!raw.contains("shadowed-key"));
        }
    }

    #[test]
    fn mixed_ai_set_clear_recovers_missing_reference() {
        for root_legacy in [false, true] {
            for clear in [false, true] {
                let dir = tempdir().unwrap();
                let mut original = serde_json::json!({"ai": {
                    "model": "old-model", "baseUrl": "https://proxy.example/v1",
                    "providers": {"openai": {
                        "apiKey": "provider-legacy-key",
                        "apiKeyRef": "v1-00000000000000000000000000000000"
                    }}
                }});
                if root_legacy {
                    original["ai"]["apiKey"] = "root-legacy-key".into();
                }
                fsx::write_json(&config_path(dir.path()), &original).unwrap();
                let before = std::fs::read(config_path(dir.path())).unwrap();
                assert!(resolve_provider(dir.path(), "openai").is_err());
                assert!(migrate_credentials(dir.path()).is_err());
                assert_eq!(std::fs::read(config_path(dir.path())).unwrap(), before);

                let edit = |slot: &mut ProviderConfig| {
                    slot.api_key = (!clear).then(|| "new-api-key".into());
                    slot.api_key_ref = None;
                    Ok(())
                };
                let store = credentials::MemoryStore::default();
                store.fail_after_writes(0);
                let error = modify_with_store(dir.path(), &store, &["openai"], |cfg| {
                    edit(cfg.ai.providers.get_mut("openai").unwrap())
                })
                .unwrap_err();
                assert!(matches!(error, AppError::Io(_)), "{error:?}");
                assert_eq!(std::fs::read(config_path(dir.path())).unwrap(), before);
                assert_eq!(store.len(), 0);

                let cfg = modify_ai_provider(dir.path(), "openai", true, edit).unwrap();
                assert_eq!(cfg.ai.providers["openai"].has_key(), !clear);
                assert_eq!(
                    resolve_provider(dir.path(), "openai").unwrap().key(),
                    (!clear).then_some("new-api-key")
                );
                let raw = std::fs::read_to_string(config_path(dir.path())).unwrap();
                assert!(!raw.contains("legacy-key"));
                assert!(!raw.contains("new-api-key"));
            }
        }
    }

    #[test]
    fn referenced_key_never_falls_back_to_legacy_plaintext() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        fsx::atomic_write(&config_path(dir.path()), br#"{"ai":{"providers":{"openai":{"apiKey":"old-secret","apiKeyRef":"v1-00000000000000000000000000000000"}}}}"#).unwrap();
        let before = std::fs::read(config_path(dir.path())).unwrap();
        assert!(resolve_provider_with_store(dir.path(), "openai", &store).is_err());
        assert_eq!(store.len(), 0);
        assert_eq!(std::fs::read(config_path(dir.path())).unwrap(), before);
    }

    #[test]
    fn concurrent_config_modifications_do_not_lose_updates() {
        let dir = tempdir().unwrap();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..10 {
                        modify(dir.path(), |cfg| {
                            cfg.ai.max_tokens += 1;
                            Ok(())
                        })
                        .unwrap();
                    }
                });
            }
        });
        assert_eq!(
            load(dir.path()).unwrap().ai.max_tokens,
            AiConfig::default().max_tokens + 80
        );
    }

    fn load_ai(json: &str) -> AiConfig {
        let dir = tempdir().unwrap();
        std::fs::write(config_path(dir.path()), json).unwrap();
        load(dir.path()).unwrap().ai
    }

    #[test]
    fn added_providers_migrate_effective_legacy_configuration_only() {
        assert!(AiConfig::default().added_providers.is_empty());
        let ai = load_ai(
            r#"{"ai":{"defaultModel":"ollama@local","providers":{"openai":{"apiKeyRef":"v1-00000000000000000000000000000000"},"lmstudio":{"baseUrl":"http://localhost:4321/v1"}}}}"#,
        );
        assert_eq!(ai.added_providers, ["openai", "ollama", "lmstudio"]);
        let ai = load_ai(
            r#"{"ai":{"addedProviders":[],"defaultModel":"ollama@local","providers":{"openai":{"apiKey":"legacy"}}}}"#,
        );
        assert!(ai.added_providers.is_empty());
        let ai = load_ai(r#"{"ai":{"addedProviders":["lmstudio","unknown","ollama","lmstudio"]}}"#);
        assert_eq!(ai.added_providers, ["lmstudio", "ollama"]);
    }

    #[test]
    fn legacy_openai_settings_migrate_to_the_provider_table() {
        let ai = load_ai(
            r#"{"ai":{"apiKey":"sk-old","model":"gpt-4o","baseUrl":"https://proxy.example.com/v1",
                "chat":{"provider":"claude","customUrl":null}}}"#,
        );
        assert_eq!(ai.default_model, "openai@gpt-4o");
        assert_eq!(ai.added_providers, ["openai"]);
        let openai = ai.provider("openai").unwrap();
        assert_eq!(openai.api_key.as_deref(), Some("sk-old"));
        assert_eq!(openai.base_url, "https://proxy.example.com/v1");
        assert_eq!(ai.providers.len(), 7);
        assert_eq!(ai.temperature, 0.7);
    }

    #[test]
    fn legacy_ollama_settings_migrate_to_ollama() {
        for url in ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1/"] {
            let ai = load_ai(&format!(
                r#"{{"ai":{{"model":"llama3.2","baseUrl":"{url}"}}}}"#
            ));
            assert_eq!(ai.default_model, "ollama@llama3.2");
            assert_eq!(ai.added_providers, ["ollama"]);
            let ollama = ai.provider("ollama").unwrap();
            assert!(ollama.base_url.ends_with(":11434"), "{}", ollama.base_url);
            assert!(!ollama.base_url.contains("/v1"));
            assert_eq!(ai.provider("openai").unwrap().api_key, None);
        }
    }

    #[test]
    fn new_format_wins_over_legacy_and_bad_values_fall_back() {
        let ai = load_ai(
            r#"{"ai":{"defaultModel":"gemini@g","model":"old","headingLevel":9,"temperature":5,
                "maxTokens":0,"providers":{"zai":{"apiKey":"k","baseUrl":""},"bogus":{"baseUrl":"x"}}}}"#,
        );
        assert_eq!(ai.default_model, "gemini@g");
        assert_eq!(ai.heading_level, 3);
        assert_eq!(ai.temperature, 0.7);
        assert_eq!(ai.max_tokens, 4096);
        let zai = ai.provider("zai").unwrap();
        assert_eq!(zai.key(), Some("k"));
        assert_eq!(zai.base_url, "https://api.z.ai/api/paas/v4");
        assert!(!ai.providers.contains_key("bogus"));
        assert!(ai.provider("bogus").is_none());
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
