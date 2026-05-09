//! AI Assist IPC command — calls an OpenAI-compatible Chat Completions
//! endpoint with the user-supplied API key. Privacy-relevant: this is the
//! only naiteh feature that sends document content over the network. The
//! UI is responsible for surfacing that to the user; the backend is a
//! thin transport.

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::config;

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

#[tauri::command]
pub async fn ai_improve(text: String, instruction: String) -> Result<String, AppError> {
    let dir = config::default_app_config_dir()?;
    crate::services::fs::ensure_dir(&dir)?;
    let cfg = config::load(&dir)?;
    let api_key = cfg
        .ai
        .api_key
        .clone()
        .ok_or_else(|| AppError::NotFound("AI Assist API key not configured".into()))?;
    if text.trim().is_empty() {
        return Err(AppError::InvalidPath("nothing to improve".into()));
    }
    if instruction.trim().is_empty() {
        return Err(AppError::InvalidPath("instruction is required".into()));
    }

    let prompt = build_user_prompt(&text, &instruction);
    let body = ChatRequest {
        model: &cfg.ai.model,
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

    let url = format!("{}/chat/completions", cfg.ai.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Io(format!("http client: {e}")))?;

    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Io(format!("ai request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(AppError::Io(format!(
            "ai request returned {status}: {}",
            truncate(&body_text, 400)
        )));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| AppError::Io(format!("ai response parse: {e}")))?;
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content.trim().to_string())
        .ok_or_else(|| AppError::Io("ai response had no choices".into()))
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
}
