//! AI Assist — calls an OpenAI-compatible Chat Completions endpoint with
//! the user-supplied config. Privacy-relevant: this is the only naiteh
//! feature that sends document content over the network. The UI is
//! responsible for surfacing that to the user; this service is a thin
//! transport. Takes `AiConfig` explicitly so callers (and tests) control
//! the endpoint.

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::config::AiConfig;

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const SYSTEM_PROMPT: &str = "\
You are a careful writing assistant inside a Markdown notes app. \
Apply the user's instruction to the supplied passage and return ONLY the \
revised text — no preamble, no commentary, no Markdown fencing. \
Preserve the input's language unless the instruction says otherwise.";

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

/// Attach a bearer token only when a non-empty key is configured. Local
/// providers like Ollama accept (and need) no key, so requiring one
/// would lock them out.
fn with_optional_auth(
    req: reqwest::RequestBuilder,
    api_key: Option<&str>,
) -> reqwest::RequestBuilder {
    match api_key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(key) => req.bearer_auth(key),
        None => req,
    }
}

/// Apply `instruction` to `text` via the configured Chat Completions
/// endpoint and return the revised text.
pub async fn improve(ai: &AiConfig, text: &str, instruction: &str) -> Result<String, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::Validation("nothing to improve".into()));
    }
    if instruction.trim().is_empty() {
        return Err(AppError::Validation("instruction is required".into()));
    }

    let prompt = build_user_prompt(text, instruction);
    let body = ChatRequest {
        model: &ai.model,
        messages: vec![
            ChatMessage {
                role: "system",
                content: SYSTEM_PROMPT.to_string(),
            },
            ChatMessage {
                role: "user",
                content: prompt,
            },
        ],
        temperature: 0.4,
    };

    let url = format!("{}/chat/completions", ai.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Network(format!("http client: {e}")))?;

    let resp = with_optional_auth(client.post(&url), ai.api_key.as_deref())
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Network(format!("ai request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(AppError::Upstream(format!(
            "ai request returned {status}: {}",
            truncate(&body_text, 400)
        )));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("ai response parse: {e}")))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content.trim().to_string())
        .ok_or_else(|| AppError::Upstream("ai response had no choices".into()))
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

/// List the models available at the configured endpoint via the
/// OpenAI-compatible `GET {base_url}/models`. Works for Ollama (returns
/// locally-pulled models) and OpenAI alike. Lets the Settings UI offer
/// a picker instead of a free-text model field.
pub async fn list_models(ai: &AiConfig) -> Result<Vec<String>, AppError> {
    let url = format!("{}/models", ai.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Network(format!("http client: {e}")))?;

    let resp = with_optional_auth(client.get(&url), ai.api_key.as_deref())
        .send()
        .await
        .map_err(|e| AppError::Network(format!("model list request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(AppError::Upstream(format!(
            "model list returned {status}: {}",
            truncate(&body_text, 400)
        )));
    }

    let parsed: ModelsResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("model list parse: {e}")))?;
    let mut ids: Vec<String> = parsed.data.into_iter().map(|m| m.id).collect();
    ids.sort();
    Ok(ids)
}

fn build_user_prompt(text: &str, instruction: &str) -> String {
    format!(
        "Instruction:\n{}\n\nText:\n---\n{}\n---",
        instruction.trim(),
        text
    )
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let head: String = s.chars().take(max_chars).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_includes_instruction_and_text_with_separator() {
        let prompt = build_user_prompt("body line", "make it shorter");
        assert!(prompt.contains("Instruction:"));
        assert!(prompt.contains("make it shorter"));
        assert!(prompt.contains("Text:"));
        assert!(prompt.contains("body line"));
        assert!(prompt.contains("---"));
    }

    #[test]
    fn truncate_appends_ellipsis_when_over_limit() {
        let out = truncate("0123456789", 5);
        assert_eq!(out, "01234…");
    }

    #[test]
    fn truncate_passes_short_strings_through() {
        let out = truncate("short", 100);
        assert_eq!(out, "short");
    }

    // ── HTTP behaviour against a mock OpenAI-compatible server ───────

    use httpmock::prelude::*;

    fn ai_config(base_url: &str, api_key: Option<&str>) -> AiConfig {
        AiConfig {
            api_key: api_key.map(str::to_string),
            model: "test-model".into(),
            base_url: base_url.to_string(),
        }
    }

    #[tokio::test]
    async fn improve_returns_trimmed_choice_and_sends_bearer_key() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/chat/completions")
                .header("authorization", "Bearer sk-test")
                .body_contains("test-model")
                .body_contains("make it shorter");
            then.status(200).json_body(serde_json::json!({
                "choices": [{ "message": { "content": "  improved text  " } }]
            }));
        });

        let cfg = ai_config(&format!("{}/v1", server.base_url()), Some("sk-test"));
        let out = improve(&cfg, "original", "make it shorter").await.unwrap();
        assert_eq!(out, "improved text");
        mock.assert();
    }

    #[tokio::test]
    async fn improve_sends_no_auth_header_for_keyless_local_provider() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/chat/completions")
                .matches(|req| {
                    !req.headers
                        .iter()
                        .flatten()
                        .any(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                });
            then.status(200).json_body(serde_json::json!({
                "choices": [{ "message": { "content": "local result" } }]
            }));
        });

        let cfg = ai_config(&format!("{}/v1", server.base_url()), None);
        let out = improve(&cfg, "original", "fix").await.unwrap();
        assert_eq!(out, "local result");
        mock.assert();
    }

    #[tokio::test]
    async fn improve_maps_non_2xx_to_upstream_error() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/chat/completions");
            then.status(429).body("rate limited");
        });

        let cfg = ai_config(&format!("{}/v1", server.base_url()), Some("sk"));
        let err = improve(&cfg, "x", "y").await.unwrap_err();
        match err {
            AppError::Upstream(msg) => {
                assert!(msg.contains("429"), "got: {msg}");
                assert!(msg.contains("rate limited"), "got: {msg}");
            }
            other => panic!("expected Upstream, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn improve_maps_connection_failure_to_network_error() {
        // Nothing listens on this port.
        let cfg = ai_config("http://127.0.0.1:1/v1", None);
        let err = improve(&cfg, "x", "y").await.unwrap_err();
        assert!(matches!(err, AppError::Network(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn improve_rejects_empty_inputs_before_any_request() {
        let cfg = ai_config("http://127.0.0.1:1/v1", None);
        assert!(matches!(
            improve(&cfg, "  ", "fix").await.unwrap_err(),
            AppError::Validation(_)
        ));
        assert!(matches!(
            improve(&cfg, "text", " ").await.unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[tokio::test]
    async fn list_models_returns_sorted_ids() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/v1/models");
            then.status(200).json_body(serde_json::json!({
                "data": [
                    { "id": "qwen2.5" },
                    { "id": "llama3.2" }
                ]
            }));
        });

        let cfg = ai_config(&format!("{}/v1", server.base_url()), None);
        let models = list_models(&cfg).await.unwrap();
        assert_eq!(models, vec!["llama3.2".to_string(), "qwen2.5".to_string()]);
    }
}
