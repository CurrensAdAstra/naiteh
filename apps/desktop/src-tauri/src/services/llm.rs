//! LLM providers for chat notes (chatgpt-md port; wiki ipc-api.md,
//! "AI chat"). Pure request builders and stream decoders per wire
//! protocol, plus the HTTP transport and the cancellation registry.
//!
//! Privacy-relevant: this is the only naiteh code that sends note
//! content over the network.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::sync::oneshot;

use crate::domain::AppError;
use crate::services::chat_doc::{Message, Role};

const CONNECT_TIMEOUT_SECS: u64 = 30;
/// Longest silence tolerated between response bytes (models can think
/// for a while before the first token).
const READ_TIMEOUT_SECS: u64 = 300;
const ANTHROPIC_VERSION: &str = "2023-06-01";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    Anthropic,
    Gemini,
    OpenRouter,
    Zai,
    Ollama,
    LmStudio,
}

/// The four HTTP dialects the providers speak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wire {
    OpenAi,
    Anthropic,
    Gemini,
    Ollama,
}

impl Provider {
    pub const ALL: [Provider; 7] = [
        Provider::OpenAi,
        Provider::Anthropic,
        Provider::Gemini,
        Provider::OpenRouter,
        Provider::Zai,
        Provider::Ollama,
        Provider::LmStudio,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Provider::OpenAi => "openai",
            Provider::Anthropic => "anthropic",
            Provider::Gemini => "gemini",
            Provider::OpenRouter => "openrouter",
            Provider::Zai => "zai",
            Provider::Ollama => "ollama",
            Provider::LmStudio => "lmstudio",
        }
    }

    pub fn from_id(id: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == id)
    }

    pub fn needs_key(self) -> bool {
        !matches!(self, Provider::Ollama | Provider::LmStudio)
    }

    pub fn wire(self) -> Wire {
        match self {
            Provider::Anthropic => Wire::Anthropic,
            Provider::Gemini => Wire::Gemini,
            Provider::Ollama => Wire::Ollama,
            _ => Wire::OpenAi,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GenParams {
    pub temperature: f64,
    pub max_tokens: u32,
    pub top_p: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
}

/// A fully resolved chat request (see `chat_doc::prepare_chat`).
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedChat {
    pub provider: Provider,
    pub model: String,
    /// Validated, no trailing `/`.
    pub base_url: String,
    pub api_key: Option<String>,
    pub params: GenParams,
    pub stream: bool,
    pub messages: Vec<Message>,
}

impl PreparedChat {
    /// `provider@model`.
    pub fn model_label(&self) -> String {
        format!("{}@{}", self.provider.id(), self.model)
    }
}

/// An HTTP request as data, so builders are testable without a server.
#[derive(Debug, Clone, PartialEq)]
pub struct WireRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

fn auth_headers(provider: Provider, key: Option<&str>) -> Vec<(&'static str, String)> {
    let Some(key) = key.map(str::trim).filter(|k| !k.is_empty()) else {
        return Vec::new();
    };
    match provider.wire() {
        Wire::Anthropic => vec![
            ("x-api-key", key.to_string()),
            ("anthropic-version", ANTHROPIC_VERSION.to_string()),
        ],
        Wire::Gemini => vec![("x-goog-api-key", key.to_string())],
        Wire::OpenAi | Wire::Ollama => vec![("authorization", format!("Bearer {key}"))],
    }
}

fn insert_opt(map: &mut Map<String, Value>, key: &str, v: Option<f64>) {
    if let Some(v) = v {
        map.insert(key.into(), json!(v));
    }
}

/// Build the chat request for `chat`.
pub fn build_chat_request(chat: &PreparedChat) -> WireRequest {
    let base = chat.base_url.trim_end_matches('/');
    let p = &chat.params;
    let mut headers = auth_headers(chat.provider, chat.api_key.as_deref());
    if chat.provider.wire() == Wire::Anthropic && headers.is_empty() {
        headers.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
    }
    let (url, body) = match chat.provider.wire() {
        Wire::OpenAi => {
            // Only OpenAI itself knows the `developer` role.
            let keep_dev = chat.provider == Provider::OpenAi;
            let messages: Vec<Value> = chat
                .messages
                .iter()
                .map(|m| {
                    let role = match m.role {
                        Role::Developer if !keep_dev => "system",
                        r => r.as_str(),
                    };
                    json!({ "role": role, "content": m.content })
                })
                .collect();
            let mut b = Map::new();
            b.insert("model".into(), json!(chat.model));
            b.insert("messages".into(), json!(messages));
            b.insert("temperature".into(), json!(p.temperature));
            b.insert("max_tokens".into(), json!(p.max_tokens));
            insert_opt(&mut b, "top_p", p.top_p);
            insert_opt(&mut b, "presence_penalty", p.presence_penalty);
            insert_opt(&mut b, "frequency_penalty", p.frequency_penalty);
            b.insert("stream".into(), json!(chat.stream));
            (format!("{base}/chat/completions"), Value::Object(b))
        }
        Wire::Anthropic => {
            let system: Vec<&str> = chat
                .messages
                .iter()
                .filter(|m| matches!(m.role, Role::System | Role::Developer))
                .map(|m| m.content.as_str())
                .collect();
            let messages: Vec<Value> = chat
                .messages
                .iter()
                .filter(|m| matches!(m.role, Role::User | Role::Assistant))
                .map(|m| json!({ "role": m.role.as_str(), "content": m.content }))
                .collect();
            let mut b = Map::new();
            b.insert("model".into(), json!(chat.model));
            b.insert("max_tokens".into(), json!(p.max_tokens));
            if !system.is_empty() {
                b.insert("system".into(), json!(system.join("\n\n")));
            }
            b.insert("messages".into(), json!(messages));
            b.insert("temperature".into(), json!(p.temperature.min(1.0)));
            insert_opt(&mut b, "top_p", p.top_p);
            b.insert("stream".into(), json!(chat.stream));
            (format!("{base}/v1/messages"), Value::Object(b))
        }
        Wire::Gemini => {
            let system: Vec<Value> = chat
                .messages
                .iter()
                .filter(|m| matches!(m.role, Role::System | Role::Developer))
                .map(|m| json!({ "text": m.content }))
                .collect();
            let contents: Vec<Value> = chat
                .messages
                .iter()
                .filter(|m| matches!(m.role, Role::User | Role::Assistant))
                .map(|m| {
                    let role = if m.role == Role::Assistant {
                        "model"
                    } else {
                        "user"
                    };
                    json!({ "role": role, "parts": [{ "text": m.content }] })
                })
                .collect();
            let mut gen = Map::new();
            gen.insert("temperature".into(), json!(p.temperature));
            gen.insert("maxOutputTokens".into(), json!(p.max_tokens));
            insert_opt(&mut gen, "topP", p.top_p);
            insert_opt(&mut gen, "presencePenalty", p.presence_penalty);
            insert_opt(&mut gen, "frequencyPenalty", p.frequency_penalty);
            let mut b = Map::new();
            b.insert("contents".into(), json!(contents));
            if !system.is_empty() {
                b.insert("systemInstruction".into(), json!({ "parts": system }));
            }
            b.insert("generationConfig".into(), Value::Object(gen));
            let model = chat.model.strip_prefix("models/").unwrap_or(&chat.model);
            let url = if chat.stream {
                format!("{base}/v1beta/models/{model}:streamGenerateContent?alt=sse")
            } else {
                format!("{base}/v1beta/models/{model}:generateContent")
            };
            (url, Value::Object(b))
        }
        Wire::Ollama => {
            let messages: Vec<Value> = chat
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == Role::Developer {
                        "system"
                    } else {
                        m.role.as_str()
                    };
                    json!({ "role": role, "content": m.content })
                })
                .collect();
            let mut opts = Map::new();
            opts.insert("temperature".into(), json!(p.temperature));
            opts.insert("num_predict".into(), json!(p.max_tokens));
            insert_opt(&mut opts, "top_p", p.top_p);
            insert_opt(&mut opts, "presence_penalty", p.presence_penalty);
            insert_opt(&mut opts, "frequency_penalty", p.frequency_penalty);
            let body = json!({
                "model": chat.model,
                "messages": messages,
                "stream": chat.stream,
                "options": Value::Object(opts),
            });
            (format!("{base}/api/chat"), body)
        }
    };
    WireRequest { url, headers, body }
}

/// Build the model-list request for `provider`.
pub fn build_models_request(provider: Provider, base_url: &str, key: Option<&str>) -> WireRequest {
    let base = base_url.trim().trim_end_matches('/');
    let url = match provider.wire() {
        Wire::OpenAi => format!("{base}/models"),
        Wire::Anthropic => format!("{base}/v1/models?limit=1000"),
        Wire::Gemini => format!("{base}/v1beta/models?pageSize=1000"),
        Wire::Ollama => format!("{base}/api/tags"),
    };
    let mut headers = auth_headers(provider, key);
    if provider.wire() == Wire::Anthropic && headers.is_empty() {
        headers.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
    }
    WireRequest {
        url,
        headers,
        body: Value::Null,
    }
}

/// Model ids from a model-list response, sorted and prefixed `provider@`.
pub fn parse_models(provider: Provider, v: &Value) -> Vec<String> {
    let str_field = |arr: Option<&Value>, field: &str| -> Vec<String> {
        arr.and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|m| m.get(field).and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut ids = match provider.wire() {
        Wire::OpenAi | Wire::Anthropic => str_field(v.get("data"), "id"),
        Wire::Ollama => str_field(v.get("models"), "name"),
        Wire::Gemini => v
            .get("models")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|m| {
                        m.get("supportedGenerationMethods")
                            .and_then(Value::as_array)
                            .is_none_or(|ms| ms.iter().any(|x| x == "generateContent"))
                    })
                    .filter_map(|m| m.get("name").and_then(Value::as_str))
                    .map(|n| n.strip_prefix("models/").unwrap_or(n).to_string())
                    .collect()
            })
            .unwrap_or_default(),
    };
    ids.sort();
    ids.dedup();
    ids.into_iter()
        .map(|id| format!("{}@{id}", provider.id()))
        .collect()
}

fn error_message(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(
        e.get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| e.as_str().map(str::to_string))
            .unwrap_or_else(|| e.to_string()),
    )
}

/// Text of a complete (non-streaming) response.
pub fn parse_response(wire: Wire, v: &Value) -> Result<String, AppError> {
    if let Some(msg) = error_message(v) {
        return Err(AppError::Upstream(msg));
    }
    let text = match wire {
        Wire::OpenAi => v
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        Wire::Anthropic => v.get("content").and_then(Value::as_array).map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect()
        }),
        Wire::Gemini => gemini_text(v),
        Wire::Ollama => v
            .pointer("/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    text.ok_or_else(|| AppError::Upstream("response had no message content".into()))
}

fn gemini_text(v: &Value) -> Option<String> {
    let parts = v.pointer("/candidates/0/content/parts")?.as_array()?;
    Some(
        parts
            .iter()
            .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect(),
    )
}

/// Incremental decoder for streamed responses: SSE (`data: {json}`) for
/// OpenAI-compatible, Anthropic and Gemini; NDJSON for Ollama.
pub struct StreamDecoder {
    wire: Wire,
    buf: Vec<u8>,
    pub done: bool,
}

impl StreamDecoder {
    pub fn new(wire: Wire) -> Self {
        Self {
            wire,
            buf: Vec::new(),
            done: false,
        }
    }

    /// Feed raw bytes; returns the text deltas completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, AppError> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            if let Some(d) = self.line(line.trim_end_matches(['\n', '\r']))? {
                out.push(d);
            }
        }
        Ok(out)
    }

    /// Flush a final line that had no trailing newline.
    pub fn finish(&mut self) -> Result<Vec<String>, AppError> {
        if self.buf.is_empty() {
            return Ok(Vec::new());
        }
        let rest = std::mem::take(&mut self.buf);
        let line = String::from_utf8_lossy(&rest).into_owned();
        Ok(self
            .line(line.trim_end_matches('\r'))?
            .into_iter()
            .collect())
    }

    fn line(&mut self, line: &str) -> Result<Option<String>, AppError> {
        if self.done {
            return Ok(None);
        }
        let payload = match self.wire {
            Wire::Ollama => line.trim(),
            _ => match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => return Ok(None),
            },
        };
        if payload.is_empty() {
            return Ok(None);
        }
        if payload == "[DONE]" {
            self.done = true;
            return Ok(None);
        }
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            return Ok(None);
        };
        if let Some(msg) = error_message(&v) {
            return Err(AppError::Upstream(msg));
        }
        let delta = match self.wire {
            Wire::OpenAi => v
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .map(str::to_string),
            Wire::Anthropic => match v.get("type").and_then(Value::as_str) {
                Some("content_block_delta") => v
                    .pointer("/delta/text")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                Some("message_stop") => {
                    self.done = true;
                    None
                }
                _ => None,
            },
            Wire::Gemini => gemini_text(&v),
            Wire::Ollama => {
                if v.get("done").and_then(Value::as_bool) == Some(true) {
                    self.done = true;
                }
                v.pointer("/message/content")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }
        };
        Ok(delta.filter(|d| !d.is_empty()))
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let head: String = s.chars().take(max_chars).collect();
    format!("{head}…")
}

fn client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(READ_TIMEOUT_SECS))
        .build()
        .map_err(|e| AppError::Network(format!("http client: {e}")))
}

async fn send(
    provider: Provider,
    req: &WireRequest,
    post: bool,
) -> Result<reqwest::Response, AppError> {
    let c = client()?;
    let mut rb = if post {
        c.post(&req.url).json(&req.body)
    } else {
        c.get(&req.url)
    };
    for (k, v) in &req.headers {
        rb = rb.header(*k, v);
    }
    let resp = rb
        .send()
        .await
        .map_err(|e| AppError::Network(format!("{} request failed: {e}", provider.id())))?;
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| error_message(&v))
        .unwrap_or(text);
    Err(AppError::Upstream(format!(
        "{} returned {status}: {}",
        provider.id(),
        truncate(&detail, 400)
    )))
}

/// Run the chat request. With `stream`, every delta goes to `on_delta`
/// as it arrives; the full text is returned either way.
pub async fn execute_chat(
    chat: &PreparedChat,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<String, AppError> {
    crate::services::config::validate_ai_base_url(&chat.base_url)?;
    let req = build_chat_request(chat);
    let wire = chat.provider.wire();
    let mut resp = send(chat.provider, &req, true).await?;
    let is_json = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.contains("application/json"));
    if !chat.stream || (is_json && wire != Wire::Ollama) {
        let v: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Upstream(format!("response parse: {e}")))?;
        let text = parse_response(wire, &v)?;
        if chat.stream && !text.is_empty() {
            on_delta(&text);
        }
        return Ok(text);
    }
    let mut dec = StreamDecoder::new(wire);
    let mut full = String::new();
    loop {
        let chunk = resp
            .chunk()
            .await
            .map_err(|e| AppError::Network(format!("stream interrupted: {e}")))?;
        let deltas = match &chunk {
            Some(bytes) => dec.push(bytes)?,
            None => dec.finish()?,
        };
        for d in deltas {
            on_delta(&d);
            full.push_str(&d);
        }
        if chunk.is_none() || dec.done {
            break;
        }
    }
    Ok(full)
}

/// List a provider's models (ids prefixed `provider@`).
pub async fn list_models(
    provider: Provider,
    base_url: &str,
    key: Option<&str>,
) -> Result<Vec<String>, AppError> {
    crate::services::config::validate_ai_base_url(base_url)?;
    let req = build_models_request(provider, base_url, key);
    let resp = send(provider, &req, false).await?;
    let v: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Upstream(format!("model list parse: {e}")))?;
    Ok(parse_models(provider, &v))
}

/// In-flight chat requests by `requestId`, so `ai_chat_stop` can abort one.
#[derive(Default, Clone)]
pub struct ChatRequests(Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>);

impl ChatRequests {
    /// Run `fut` under `id`; resolves to `Cancelled` if [`stop`](Self::stop)
    /// is called first. An id already in flight is rejected.
    pub async fn run<T>(
        &self,
        id: &str,
        fut: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        let (tx, rx) = oneshot::channel();
        {
            let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if map.contains_key(id) {
                return Err(AppError::Validation(format!(
                    "request {id} is already running"
                )));
            }
            map.insert(id.to_string(), tx);
        }
        let out = tokio::select! {
            r = fut => r,
            _ = rx => Err(AppError::Cancelled),
        };
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        out
    }

    /// Abort request `id`. Returns false when nothing by that id runs.
    pub fn stop(&self, id: &str) -> bool {
        let tx = self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        tx.map(|tx| tx.send(()).is_ok()).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    fn chat(provider: Provider, stream: bool) -> PreparedChat {
        PreparedChat {
            provider,
            model: "m1".into(),
            base_url: "https://h.example/".trim_end_matches('/').into(),
            api_key: Some("sk".into()),
            params: GenParams {
                temperature: 0.5,
                max_tokens: 100,
                top_p: Some(0.9),
                presence_penalty: None,
                frequency_penalty: Some(0.1),
            },
            stream,
            messages: vec![
                Message::new(Role::System, "sys"),
                Message::new(Role::Developer, "dev"),
                Message::new(Role::User, "hi"),
                Message::new(Role::Assistant, "yo"),
            ],
        }
    }

    #[test]
    fn openai_compatible_body() {
        let r = build_chat_request(&chat(Provider::OpenAi, true));
        assert_eq!(r.url, "https://h.example/chat/completions");
        assert_eq!(r.headers, vec![("authorization", "Bearer sk".to_string())]);
        assert_eq!(
            r.body,
            json!({
                "model": "m1",
                "messages": [
                    {"role":"system","content":"sys"},
                    {"role":"developer","content":"dev"},
                    {"role":"user","content":"hi"},
                    {"role":"assistant","content":"yo"}
                ],
                "temperature": 0.5, "max_tokens": 100, "top_p": 0.9,
                "frequency_penalty": 0.1, "stream": true
            })
        );
        let r = build_chat_request(&PreparedChat {
            api_key: None,
            ..chat(Provider::LmStudio, false)
        });
        assert!(r.headers.is_empty());
        assert_eq!(r.body["messages"][1]["role"], "system");
        assert_eq!(r.body["stream"], false);
    }

    #[test]
    fn anthropic_body() {
        let r = build_chat_request(&chat(Provider::Anthropic, true));
        assert_eq!(r.url, "https://h.example/v1/messages");
        assert!(r.headers.contains(&("x-api-key", "sk".into())));
        assert!(r
            .headers
            .contains(&("anthropic-version", ANTHROPIC_VERSION.into())));
        assert_eq!(r.body["system"], "sys\n\ndev");
        assert_eq!(
            r.body["messages"],
            json!([{"role":"user","content":"hi"},{"role":"assistant","content":"yo"}])
        );
        assert_eq!(r.body["max_tokens"], 100);
        assert_eq!(r.body["stream"], true);
        assert!(r.body.get("frequency_penalty").is_none());
    }

    #[test]
    fn gemini_body() {
        let r = build_chat_request(&chat(Provider::Gemini, true));
        assert_eq!(
            r.url,
            "https://h.example/v1beta/models/m1:streamGenerateContent?alt=sse"
        );
        assert_eq!(r.headers, vec![("x-goog-api-key", "sk".to_string())]);
        assert_eq!(
            r.body["contents"],
            json!([
                {"role":"user","parts":[{"text":"hi"}]},
                {"role":"model","parts":[{"text":"yo"}]}
            ])
        );
        assert_eq!(
            r.body["systemInstruction"],
            json!({"parts":[{"text":"sys"},{"text":"dev"}]})
        );
        assert_eq!(r.body["generationConfig"]["maxOutputTokens"], 100);
        let r = build_chat_request(&chat(Provider::Gemini, false));
        assert!(r.url.ends_with("/v1beta/models/m1:generateContent"));
    }

    #[test]
    fn ollama_body() {
        let r = build_chat_request(&PreparedChat {
            api_key: None,
            ..chat(Provider::Ollama, true)
        });
        assert_eq!(r.url, "https://h.example/api/chat");
        assert!(r.headers.is_empty());
        assert_eq!(r.body["options"]["num_predict"], 100);
        assert_eq!(r.body["options"]["temperature"], 0.5);
        assert_eq!(r.body["messages"][1]["role"], "system");
        assert_eq!(r.body["stream"], true);
    }

    fn decode_all(wire: Wire, input: &str) -> Result<String, AppError> {
        let mut d = StreamDecoder::new(wire);
        let mut out = String::new();
        // Feed in awkward 7-byte pieces to exercise line buffering.
        for piece in input.as_bytes().chunks(7) {
            out.extend(d.push(piece)?);
        }
        out.extend(d.finish()?);
        Ok(out)
    }

    #[test]
    fn openai_sse_stream() {
        let s = ": keep-alive\n\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n\
                 data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\r\n\r\n\
                 data: {\"choices\":[{\"delta\":{\"content\":\"lo ü\"}}]}\n\n\
                 data: [DONE]\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"X\"}}]}\n";
        assert_eq!(decode_all(Wire::OpenAi, s).unwrap(), "Hello ü");
        let err =
            decode_all(Wire::OpenAi, "data: {\"error\":{\"message\":\"boom\"}}\n").unwrap_err();
        assert!(matches!(err, AppError::Upstream(m) if m == "boom"));
    }

    #[test]
    fn anthropic_sse_stream() {
        let s = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{}}\n\n\
                 event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n\
                 event: ping\ndata: {\"type\":\"ping\"}\n\n\
                 event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\n\
                 event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        assert_eq!(decode_all(Wire::Anthropic, s).unwrap(), "Hi there");
        let err = decode_all(
            Wire::Anthropic,
            "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n",
        )
        .unwrap_err();
        assert!(matches!(err, AppError::Upstream(m) if m == "Overloaded"));
    }

    #[test]
    fn gemini_sse_stream() {
        let s = "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"A\"},{\"text\":\"B\"}],\"role\":\"model\"}}]}\r\n\r\n\
                 data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"C\"}]},\"finishReason\":\"STOP\"}]}";
        assert_eq!(decode_all(Wire::Gemini, s).unwrap(), "ABC");
    }

    #[test]
    fn ollama_ndjson_stream() {
        let s = "{\"message\":{\"role\":\"assistant\",\"content\":\"one \"},\"done\":false}\n\
                 {\"message\":{\"role\":\"assistant\",\"content\":\"two\"},\"done\":false}\n\
                 {\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true}\n";
        assert_eq!(decode_all(Wire::Ollama, s).unwrap(), "one two");
        assert!(decode_all(Wire::Ollama, "{\"error\":\"model not found\"}\n").is_err());
    }

    #[test]
    fn non_stream_responses() {
        assert_eq!(
            parse_response(
                Wire::OpenAi,
                &json!({"choices":[{"message":{"content":"x"}}]})
            )
            .unwrap(),
            "x"
        );
        assert_eq!(
            parse_response(
                Wire::Anthropic,
                &json!({"content":[{"type":"thinking","thinking":"t"},{"type":"text","text":"y"}]})
            )
            .unwrap(),
            "y"
        );
        assert_eq!(
            parse_response(
                Wire::Gemini,
                &json!({"candidates":[{"content":{"parts":[{"text":"z"}]}}]})
            )
            .unwrap(),
            "z"
        );
        assert_eq!(
            parse_response(Wire::Ollama, &json!({"message":{"content":"w"}})).unwrap(),
            "w"
        );
        assert!(parse_response(Wire::OpenAi, &json!({})).is_err());
    }

    #[test]
    fn model_lists() {
        assert_eq!(
            parse_models(Provider::OpenAi, &json!({"data":[{"id":"b"},{"id":"a"}]})),
            vec!["openai@a", "openai@b"]
        );
        assert_eq!(
            parse_models(Provider::Ollama, &json!({"models":[{"name":"llama3:8b"}]})),
            vec!["ollama@llama3:8b"]
        );
        assert_eq!(
            parse_models(
                Provider::Gemini,
                &json!({"models":[
                    {"name":"models/gemini-2.5-flash","supportedGenerationMethods":["generateContent"]},
                    {"name":"models/embedding","supportedGenerationMethods":["embedContent"]}
                ]})
            ),
            vec!["gemini@gemini-2.5-flash"]
        );
        let r = build_models_request(Provider::Anthropic, "https://a.example/", Some("k"));
        assert_eq!(r.url, "https://a.example/v1/models?limit=1000");
        let r = build_models_request(Provider::Ollama, "http://localhost:11434", None);
        assert_eq!(r.url, "http://localhost:11434/api/tags");
    }

    // ── end to end against a mock OpenAI-compatible server ──────────

    fn local(server: &MockServer, stream: bool) -> PreparedChat {
        PreparedChat {
            base_url: format!("{}/v1", server.base_url()),
            ..chat(Provider::OpenAi, stream)
        }
    }

    #[tokio::test]
    async fn streams_deltas_end_to_end() {
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(POST)
                .path("/v1/chat/completions")
                .header("authorization", "Bearer sk")
                .body_contains("\"stream\":true");
            then.status(200)
                .header("content-type", "text/event-stream")
                .body(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n\
                     data: {\"choices\":[{\"delta\":{\"content\":\", world\"}}]}\n\n\
                     data: [DONE]\n\n",
                );
        });
        let mut seen = Vec::new();
        let text = execute_chat(&local(&server, true), &mut |d| seen.push(d.to_string()))
            .await
            .unwrap();
        assert_eq!(text, "Hello, world");
        assert_eq!(seen, vec!["Hello", ", world"]);
        mock.assert();
    }

    #[tokio::test]
    async fn non_stream_and_upstream_errors() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/chat/completions");
            then.status(200)
                .json_body(json!({"choices":[{"message":{"content":"whole"}}]}));
        });
        let text = execute_chat(&local(&server, false), &mut |_| panic!("no deltas"))
            .await
            .unwrap();
        assert_eq!(text, "whole");

        let bad = MockServer::start();
        bad.mock(|when, then| {
            when.method(POST).path("/v1/chat/completions");
            then.status(401)
                .json_body(json!({"error":{"message":"Incorrect API key"}}));
        });
        let err = execute_chat(&local(&bad, true), &mut |_| {})
            .await
            .unwrap_err();
        assert!(
            matches!(&err, AppError::Upstream(m) if m.contains("401") && m.contains("Incorrect API key")),
            "{err:?}"
        );
        let mut c = local(&bad, true);
        c.base_url = "http://127.0.0.1:1/v1".into();
        assert!(matches!(
            execute_chat(&c, &mut |_| {}).await.unwrap_err(),
            AppError::Network(_)
        ));
        c.base_url = "http://evil.example/v1".into();
        assert!(matches!(
            execute_chat(&c, &mut |_| {}).await.unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[tokio::test]
    async fn stop_cancels_a_running_request() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(POST).path("/v1/chat/completions");
            then.status(200)
                .delay(Duration::from_secs(5))
                .body("data: [DONE]\n\n");
        });
        let reqs = ChatRequests::default();
        let chat = local(&server, true);
        let stopper = reqs.clone();
        tokio::spawn(async move {
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if stopper.stop("r1") {
                    return;
                }
            }
        });
        let started = std::time::Instant::now();
        let err = reqs
            .run("r1", async { execute_chat(&chat, &mut |_| {}).await })
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled), "{err:?}");
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(!reqs.stop("r1"), "finished requests are deregistered");
    }

    #[tokio::test]
    async fn duplicate_request_ids_are_rejected() {
        let reqs = ChatRequests::default();
        let inner = reqs.clone();
        let out = reqs
            .run("x", async move { inner.run("x", async { Ok(1) }).await })
            .await;
        assert!(matches!(out, Err(AppError::Validation(_))));
        assert_eq!(reqs.run("x", async { Ok(2) }).await.unwrap(), 2);
    }

    #[tokio::test]
    async fn list_models_end_to_end() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/api/tags");
            then.status(200)
                .json_body(json!({"models":[{"name":"qwen"},{"name":"llama"}]}));
        });
        let ids = list_models(Provider::Ollama, &server.base_url(), None)
            .await
            .unwrap();
        assert_eq!(ids, vec!["ollama@llama", "ollama@qwen"]);
    }
}
