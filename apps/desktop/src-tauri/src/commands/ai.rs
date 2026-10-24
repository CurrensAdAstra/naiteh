//! AI chat-in-note IPC commands — a port of the chatgpt-md Obsidian
//! plugin (https://github.com/bramses/chatgpt-md, MIT). See
//! vault/wiki/ipc-api.md ("AI chat").
//!
//! Privacy-relevant: these commands send note content to the configured
//! provider. File reads run on the blocking pool without the vault lock;
//! network work runs on the async runtime, never on the UI thread.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter};

use crate::domain::AppError;
use crate::services::chat_doc::{self, Message, Role, SettingsLayer};
use crate::services::config::{self, AiConfig};
use crate::services::credentials;
use crate::services::fs as fsx;
use crate::services::llm::{self, ChatRequests, Provider};
use crate::services::session::{require_session, ActiveSession};

/// Event carrying one streamed text delta.
pub const CHUNK_EVENT: &str = "ai:chat-chunk";
const TITLE_MAX_CHARS: usize = 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendResult {
    /// `provider@model` actually used.
    pub model: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChunkPayload<'a> {
    request_id: &'a str,
    delta: &'a str,
}

fn prepare_request(
    config_dir: &Path,
    prepare: impl FnOnce(&AiConfig) -> Result<llm::PreparedChat, AppError>,
) -> Result<llm::PreparedChat, AppError> {
    let mut ai = config::load(config_dir)?.ai;
    // Pure document/agent resolution checks key presence. Use only non-secret
    // markers until it has selected and validated the actual provider/endpoint.
    for provider in ai.providers.values_mut() {
        provider.api_key = provider.has_key().then(|| "credential-pending".into());
    }
    let mut prepared = prepare(&ai)?;
    let provider = config::resolve_provider(config_dir, prepared.provider.id())?;
    if provider.base_url.trim().trim_end_matches('/') != prepared.base_url {
        return Err(AppError::Conflict(
            "AI settings changed; retry the request".into(),
        ));
    }
    prepared.api_key = provider.key().map(str::to_string);
    if prepared.provider.needs_key() && prepared.api_key.is_none() {
        return Err(AppError::Validation(
            "AI API key is not set. Add it in Settings.".into(),
        ));
    }
    Ok(prepared)
}

/// Send the chat note `content` (live editor text of `doc_rel_path`).
#[tauri::command]
pub async fn ai_chat_send(
    active: tauri::State<'_, ActiveSession>,
    requests: tauri::State<'_, ChatRequests>,
    app: AppHandle,
    request_id: String,
    doc_rel_path: String,
    content: String,
) -> Result<ChatSendResult, AppError> {
    require_session(&active)?;
    let requests = requests.inner().clone();
    let prepared = fsx::run_blocking(move || {
        let dir = config::default_app_config_dir()?;
        let root = config::current_vault_root()?;
        prepare_request(&dir, |ai| {
            chat_doc::prepare_chat(&root, &doc_rel_path, &content, ai)
        })
    })
    .await?;
    let model = prepared.model_label();
    let rid = request_id.clone();
    let secret = prepared.api_key.clone();
    let text = requests
        .run(&request_id, async move {
            llm::execute_chat(&prepared, &mut |delta| {
                let _ = app.emit(
                    CHUNK_EVENT,
                    ChunkPayload {
                        request_id: &rid,
                        delta,
                    },
                );
            })
            .await
        })
        .await
        .map_err(|e| {
            credentials::redact_error(e, &secret.as_deref().into_iter().collect::<Vec<_>>())
        })?;
    Ok(ChatSendResult { model, text })
}

/// Abort the in-flight `ai_chat_send` with this id (no-op if none).
#[tauri::command]
pub async fn ai_chat_stop(
    active: tauri::State<'_, ActiveSession>,
    requests: tauri::State<'_, ChatRequests>,
    request_id: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    requests.stop(&request_id);
    Ok(())
}

/// Infer a short, filename-safe title for a chat (default model).
#[tauri::command]
pub async fn ai_infer_title(
    active: tauri::State<'_, ActiveSession>,
    content: String,
) -> Result<String, AppError> {
    require_session(&active)?;
    let prepared = fsx::run_blocking(move || {
        let dir = config::default_app_config_dir()?;
        prepare_request(&dir, |ai| title_request(ai, &content))
    })
    .await?;
    let raw = llm::execute_chat(&prepared, &mut |_| {})
        .await
        .map_err(|e| {
            credentials::redact_error(
                e,
                &prepared.api_key.as_deref().into_iter().collect::<Vec<_>>(),
            )
        })?;
    let title = sanitize_title(&raw);
    if title.is_empty() {
        return Err(AppError::Upstream("the model returned no title".into()));
    }
    Ok(title)
}

fn title_request(ai: &AiConfig, content: &str) -> Result<llm::PreparedChat, AppError> {
    let (_, body) = chat_doc::split_document(content);
    let msgs = chat_doc::parse_messages(body);
    let transcript = if msgs.is_empty() {
        body.trim().to_string()
    } else {
        msgs.iter()
            .map(|m| format!("{}: {}", m.role.as_str(), m.content))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    if transcript.is_empty() {
        return Err(AppError::Validation(
            "No messages to infer a title from".into(),
        ));
    }
    let prompt = format!(
        "Infer title from the summary of the content of these messages. The title **cannot** \
         contain any of the following characters: colon, back slash or forward slash, asterisk, \
         question mark, double quote, less than, greater than, pipe. Just return the title. \
         Keep it under {TITLE_MAX_CHARS} characters. Write the title in {}.\nMessages:\n\n{}",
        ai.infer_title_language, transcript
    );
    let layer = SettingsLayer {
        stream: Some(false),
        ..SettingsLayer::default()
    };
    chat_doc::resolve_request(ai, &layer, vec![Message::new(Role::User, prompt)])
}

/// Strip quotes / Markdown heading marks and characters illegal in file
/// names; collapse whitespace; cap at 60 characters.
fn sanitize_title(raw: &str) -> String {
    let first = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let cleaned: String = first
        .trim_start_matches('#')
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '"' | '\'' | '`' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|'
            )
        })
        .filter(|c| !c.is_control())
        .collect();
    let words: Vec<&str> = cleaned.split_whitespace().collect();
    let joined = words.join(" ");
    let capped: String = joined.chars().take(TITLE_MAX_CHARS).collect();
    capped.trim().trim_end_matches('.').trim().to_string()
}

/// Models offered by `provider` (ids prefixed `provider@`).
#[tauri::command]
pub async fn ai_list_models(
    active: tauri::State<'_, ActiveSession>,
    provider: String,
) -> Result<Vec<String>, AppError> {
    require_session(&active)?;
    let p = Provider::from_id(provider.trim())
        .ok_or_else(|| AppError::Validation(format!("unknown provider {provider:?}")))?;
    let pcfg = fsx::run_blocking(move || {
        let dir = config::default_app_config_dir()?;
        config::resolve_provider(&dir, p.id())
    })
    .await?;
    if p.needs_key() && pcfg.key().is_none() {
        return Err(AppError::Validation(format!(
            "No API key for {}. Add it in Settings → AI.",
            p.id()
        )));
    }
    llm::list_models(p, &pcfg.base_url, pcfg.key())
        .await
        .map_err(|e| credentials::redact_error(e, &pcfg.key().into_iter().collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_sanitized() {
        assert_eq!(sanitize_title("\"Rust: async/await\"\n"), "Rust asyncawait");
        assert_eq!(sanitize_title("## Plan   for *Q3*?"), "Plan for Q3");
        assert_eq!(sanitize_title(&"x".repeat(100)).chars().count(), 60);
        assert_eq!(sanitize_title("  \n  Title.  "), "Title");
    }

    #[test]
    fn title_request_uses_default_model_without_streaming() {
        let mut ai = AiConfig {
            infer_title_language: "Korean".into(),
            ..AiConfig::default()
        };
        ai.providers.get_mut("openai").unwrap().api_key = Some("k".into());
        let doc = format!(
            "---\nmodel: ollama@x\n---\nhello\n{}\n### role::assistant\nhi",
            chat_doc::HR
        );
        let p = title_request(&ai, &doc).unwrap();
        assert_eq!(p.model_label(), "openai@gpt-4.1-mini");
        assert!(!p.stream);
        assert_eq!(p.messages.len(), 1);
        assert!(p.messages[0].content.contains("Write the title in Korean."));
        assert!(p.messages[0]
            .content
            .contains("user: hello\n\nassistant: hi"));
        assert!(title_request(&ai, "---\na: b\n---\n  ").is_err());
    }

    #[test]
    fn preparation_resolves_only_the_effective_note_or_agent_provider() {
        let dir = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        fsx::atomic_write(&config::config_path(dir.path()), br#"{"ai":{"providers":{"openai":{"apiKeyRef":"v1-00000000000000000000000000000000"}}}}"#).unwrap();
        fsx::atomic_write(
            &vault.path().join("notes/agents/Local.md"),
            b"---\nmodel: ollama@local\n---\nBe concise.",
        )
        .unwrap();
        let prepared = prepare_request(dir.path(), |ai| {
            chat_doc::prepare_chat(vault.path(), "chat.md", "---\nagent: Local\n---\nhello", ai)
        })
        .unwrap();
        assert_eq!(prepared.provider, Provider::Ollama);
        assert!(prepared.api_key.is_none());
        let error = prepare_request(dir.path(), |ai| {
            chat_doc::prepare_chat(vault.path(), "chat.md", "hello", ai)
        })
        .unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)));
    }

    #[test]
    fn selected_legacy_key_migrates_only_after_endpoint_validation() {
        let dir = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let original = br#"{"ai":{"providers":{"openai":{"apiKey":"selected-secret"},"zai":{"apiKey":"unrelated-secret"}}}}"#;
        fsx::atomic_write(&config::config_path(dir.path()), original).unwrap();
        assert!(prepare_request(dir.path(), |ai| {
            chat_doc::prepare_chat(
                vault.path(),
                "chat.md",
                "---\nurl: https://untrusted.example\n---\nhello",
                ai,
            )
        })
        .is_err());
        assert_eq!(
            std::fs::read(config::config_path(dir.path())).unwrap(),
            original
        );
        let prepared = prepare_request(dir.path(), |ai| {
            chat_doc::prepare_chat(vault.path(), "chat.md", "hello", ai)
        })
        .unwrap();
        assert_eq!(prepared.api_key.as_deref(), Some("selected-secret"));
        let raw = std::fs::read_to_string(config::config_path(dir.path())).unwrap();
        assert!(!raw.contains("selected-secret"));
        assert!(raw.contains("unrelated-secret"));
    }
}
