//! Chat notes — a port of the chatgpt-md Obsidian plugin's document
//! format (https://github.com/bramses/chatgpt-md, MIT). See
//! vault/wiki/domain-model.md ("Chat note") for the format.
//!
//! Pure parsing (front matter, messages, settings layering, model
//! strings) plus link expansion, which reads vault files. Nothing here
//! touches the network or the vault lock.

use std::path::{Path, PathBuf};

use crate::domain::AppError;
use crate::services::config::AiConfig;
use crate::services::llm::{GenParams, PreparedChat, Provider};
use crate::services::notes;

/// Message separator (chatgpt-md's `HORIZONTAL_LINE_MD`).
pub const HR: &str = "<hr class=\"__chatgpt_plugin\">";
const ROLE_MARK: &str = "role::";
const COMMENT_START: &str = "=begin-chatgpt-md-comment";
const COMMENT_END: &str = "=end-chatgpt-md-comment";
/// Most links expanded per user message.
pub const MAX_LINKS: usize = 10;

// ── front matter ────────────────────────────────────────────────────

pub use crate::services::notes::{FmValue, FrontMatterMap};

/// Split `content` into its front-matter map and the body after it.
/// Uses the shared reader, `notes::parse_yaml_map`.
pub fn split_document(content: &str) -> (FrontMatterMap, &str) {
    match notes::split_front_matter(content) {
        Some(parts) => (notes::parse_yaml_map(parts.header), parts.body),
        None => (FrontMatterMap::new(), content),
    }
}

// ── messages ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    Developer,
    User,
    Assistant,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::System => "system",
            Role::Developer => "developer",
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

impl Message {
    pub fn new(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
        }
    }
}

/// Drop every `=begin-chatgpt-md-comment … =end-chatgpt-md-comment`
/// block (an unterminated start marker is kept as text).
pub fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(COMMENT_START) {
        let after = &rest[start + COMMENT_START.len()..];
        let Some(end) = after.find(COMMENT_END) else {
            break;
        };
        out.push_str(&rest[..start]);
        rest = &after[end + COMMENT_END.len()..];
    }
    out.push_str(rest);
    out
}

/// Split a chat body (front matter already removed) into messages.
pub fn parse_messages(body: &str) -> Vec<Message> {
    strip_comments(body)
        .split(HR)
        .filter_map(parse_part)
        .collect()
}

fn role_after_mark(after: &str) -> Role {
    let lower = after.trim_start().to_ascii_lowercase();
    [
        ("assistant", Role::Assistant),
        ("user", Role::User),
        ("developer", Role::Developer),
        ("system", Role::System),
    ]
    .iter()
    .filter_map(|(name, role)| lower.find(name).map(|i| (i, *role)))
    .min_by_key(|(i, _)| *i)
    .map_or(Role::User, |(_, r)| r)
}

fn parse_part(part: &str) -> Option<Message> {
    let lines: Vec<&str> = part.lines().collect();
    let (role, content) = match lines.iter().position(|l| l.contains(ROLE_MARK)) {
        Some(i) => {
            let line = lines[i];
            let after = &line[line.find(ROLE_MARK).unwrap_or(0) + ROLE_MARK.len()..];
            (role_after_mark(after), lines[i + 1..].join("\n"))
        }
        None => (Role::User, part.to_string()),
    };
    let content = content.trim();
    (!content.is_empty()).then(|| Message::new(role, content))
}

// ── settings layering ───────────────────────────────────────────────

/// The front-matter keys a chat note (or agent) can set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SettingsLayer {
    pub model: Option<String>,
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
    pub top_p: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub frequency_penalty: Option<f64>,
    pub system_commands: Vec<String>,
    pub agent: Option<String>,
    pub url: Option<String>,
    pub stream: Option<bool>,
}

fn scalar<'a>(map: &'a FrontMatterMap, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(FmValue::Scalar(s)) if !s.trim().is_empty() => Some(s.trim()),
        _ => None,
    }
}

fn number(map: &FrontMatterMap, key: &str) -> Result<Option<f64>, AppError> {
    scalar(map, key)
        .map(|s| {
            s.parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .ok_or_else(|| AppError::Validation(format!("{key} must be a number, not {s:?}")))
        })
        .transpose()
}

impl SettingsLayer {
    pub fn from_map(map: &FrontMatterMap) -> Result<Self, AppError> {
        let max_tokens = scalar(map, "max_tokens")
            .map(|s| {
                s.parse::<u32>().ok().filter(|v| *v > 0).ok_or_else(|| {
                    AppError::Validation(format!(
                        "max_tokens must be a positive integer, not {s:?}"
                    ))
                })
            })
            .transpose()?;
        let stream = scalar(map, "stream")
            .map(|s| match s.to_ascii_lowercase().as_str() {
                "true" | "yes" => Ok(true),
                "false" | "no" => Ok(false),
                _ => Err(AppError::Validation(format!(
                    "stream must be true or false, not {s:?}"
                ))),
            })
            .transpose()?;
        let system_commands = match map.get("system_commands") {
            Some(FmValue::Scalar(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
            Some(FmValue::List(v)) => v.clone(),
            _ => Vec::new(),
        };
        Ok(Self {
            model: scalar(map, "model").map(str::to_string),
            temperature: number(map, "temperature")?,
            max_tokens,
            top_p: number(map, "top_p")?,
            presence_penalty: number(map, "presence_penalty")?,
            frequency_penalty: number(map, "frequency_penalty")?,
            system_commands,
            agent: scalar(map, "agent").map(str::to_string),
            url: scalar(map, "url").map(str::to_string),
            stream,
        })
    }

    /// `self` wins; `lower` fills the gaps.
    pub fn over(self, lower: &SettingsLayer) -> SettingsLayer {
        SettingsLayer {
            model: self.model.or_else(|| lower.model.clone()),
            temperature: self.temperature.or(lower.temperature),
            max_tokens: self.max_tokens.or(lower.max_tokens),
            top_p: self.top_p.or(lower.top_p),
            presence_penalty: self.presence_penalty.or(lower.presence_penalty),
            frequency_penalty: self.frequency_penalty.or(lower.frequency_penalty),
            system_commands: if self.system_commands.is_empty() {
                lower.system_commands.clone()
            } else {
                self.system_commands
            },
            agent: self.agent.or_else(|| lower.agent.clone()),
            url: self.url.or_else(|| lower.url.clone()),
            stream: self.stream.or(lower.stream),
        }
    }
}

/// Parse `provider@model` (or a bare model → `openai`).
pub fn parse_model(raw: &str) -> Result<(Provider, String), AppError> {
    let raw = raw.trim();
    let bad = || AppError::Validation(format!("invalid model {raw:?} (expected provider@model)"));
    if raw.is_empty() {
        return Err(bad());
    }
    match raw.split_once('@') {
        Some((p, m)) => {
            let provider = Provider::from_id(&p.trim().to_ascii_lowercase()).ok_or_else(bad)?;
            let m = m.trim();
            if m.is_empty() {
                return Err(bad());
            }
            Ok((provider, m.to_string()))
        }
        None => Ok((Provider::OpenAi, raw.to_string())),
    }
}

/// Everything resolved for one request, before the network call.
pub fn prepare_chat(
    vault_root: &Path,
    doc_rel_path: &str,
    content: &str,
    ai: &AiConfig,
) -> Result<PreparedChat, AppError> {
    let (fm, body) = split_document(content);
    let note = SettingsLayer::from_map(&fm)?;

    let mut agent_layer = SettingsLayer::default();
    let mut agent_prompt: Option<String> = None;
    if let Some(name) = note.agent.clone() {
        let (layer, prompt) = load_agent(vault_root, &ai.agents_folder, &name)?;
        agent_layer = layer;
        agent_prompt = prompt;
    }
    let merged = note.over(&agent_layer);

    let mut messages = parse_messages(body);
    if messages.is_empty() {
        return Err(AppError::Validation("No messages to send".into()));
    }
    expand_links(vault_root, doc_rel_path, &mut messages);

    let mut all: Vec<Message> = merged
        .system_commands
        .iter()
        .filter(|c| !c.trim().is_empty())
        .map(|c| Message::new(Role::System, c.trim()))
        .collect();
    if let Some(p) = agent_prompt {
        all.push(Message::new(Role::System, p));
    }
    all.extend(messages);

    resolve_request(ai, &merged, all)
}

/// Normalize a base URL for comparison: scheme and authority lowercase,
/// path kept as-is minus trailing slashes.
fn normalize_base_url(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let (auth, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    format!(
        "{}://{}{}",
        scheme.to_ascii_lowercase(),
        auth.to_ascii_lowercase(),
        path
    )
}

/// Apply global settings under `layer` and look up the provider.
pub fn resolve_request(
    ai: &AiConfig,
    layer: &SettingsLayer,
    messages: Vec<Message>,
) -> Result<PreparedChat, AppError> {
    let model_str = layer
        .model
        .clone()
        .unwrap_or_else(|| ai.default_model.clone());
    let (provider, model) = parse_model(&model_str)?;
    let pcfg = ai
        .provider(provider.id())
        .ok_or_else(|| AppError::Validation(format!("unknown provider {}", provider.id())))?;
    let configured = pcfg.base_url.trim().trim_end_matches('/').to_string();
    // A front-matter `url:` (note or agent layer) may only restate the
    // base URL configured in Settings; anything else could leak the API
    // key or the note contents to an arbitrary host.
    if let Some(over) = &layer.url {
        if normalize_base_url(over) != normalize_base_url(&configured) {
            return Err(AppError::Validation(format!(
                "The url: override in a note or agent must match the base URL configured for {} in Settings → AI.",
                provider.id()
            )));
        }
    }
    let base_url = configured;
    crate::services::config::validate_ai_base_url(&base_url)?;
    let api_key = pcfg.key().map(str::to_string);
    if provider.needs_key() && api_key.is_none() {
        return Err(AppError::Validation(format!(
            "No API key for {}. Add it in Settings → AI.",
            provider.id()
        )));
    }
    Ok(PreparedChat {
        provider,
        model,
        base_url,
        api_key,
        params: GenParams {
            temperature: layer.temperature.unwrap_or(ai.temperature),
            max_tokens: layer.max_tokens.unwrap_or(ai.max_tokens),
            top_p: layer.top_p,
            presence_penalty: layer.presence_penalty,
            frequency_penalty: layer.frequency_penalty,
        },
        stream: layer.stream.unwrap_or(ai.stream),
        messages,
    })
}

fn load_agent(
    vault_root: &Path,
    agents_folder: &str,
    name: &str,
) -> Result<(SettingsLayer, Option<String>), AppError> {
    let not_found = || AppError::Validation(format!("Agent not found: {name}"));
    let file = if name.to_ascii_lowercase().ends_with(".md") {
        name.to_string()
    } else {
        format!("{name}.md")
    };
    let rel = format!("{}/{}", agents_folder.trim_matches('/'), file);
    let abs = notes::resolve_in_vault(vault_root, &rel).map_err(|_| not_found())?;
    let text = std::fs::read_to_string(&abs).map_err(|_| not_found())?;
    let (fm, body) = split_document(&text);
    let mut layer = SettingsLayer::from_map(&fm)?;
    layer.agent = None;
    let body = strip_comments(body).trim().to_string();
    Ok((layer, (!body.is_empty()).then_some(body)))
}

// ── link expansion ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum LinkTarget {
    Wiki(String),
    Md(String),
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() && s.is_char_boundary(i + 3) {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Links in order of appearance (duplicates removed).
fn find_links(text: &str) -> Vec<LinkTarget> {
    let mut found: Vec<(usize, LinkTarget)> = Vec::new();
    let mut pos = 0;
    while let Some(i) = text[pos..].find("[[") {
        let start = pos + i + 2;
        let Some(len) = text[start..].find("]]") else {
            break;
        };
        let inner = &text[start..start + len];
        let name = inner.split(['|', '#']).next().unwrap_or("").trim();
        if !name.is_empty() && !inner.contains('\n') {
            found.push((start, LinkTarget::Wiki(name.to_string())));
        }
        pos = start + len + 2;
    }
    let mut pos = 0;
    while let Some(i) = text[pos..].find("](") {
        let start = pos + i + 2;
        let Some(len) = text[start..].find(')') else {
            break;
        };
        let raw = text[start..start + len].trim();
        let raw = raw.trim_start_matches('<').trim_end_matches('>');
        let raw = raw.split('#').next().unwrap_or("");
        let target = percent_decode(raw.split(' ').next().unwrap_or(""));
        let has_bracket = text[..pos + i].rfind('[').is_some();
        if has_bracket
            && !target.contains("://")
            && !target.starts_with("mailto:")
            && target.to_ascii_lowercase().ends_with(".md")
        {
            found.push((start, LinkTarget::Md(target)));
        }
        pos = start + len + 1;
    }
    found.sort_by_key(|(i, _)| *i);
    let mut out: Vec<LinkTarget> = Vec::new();
    for (_, t) in found {
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

/// Lexically join `rel` onto `base` (both `/`-separated), resolving `.`
/// and `..`. `None` if it climbs above the vault root.
fn join_lexical(base: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if rel.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').filter(|p| !p.is_empty()).collect()
    };
    for comp in rel.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            c => parts.push(c),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn rel_of(vault_root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(vault_root).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

fn is_hidden_rel(rel: &str) -> bool {
    rel.split('/').any(|c| c.starts_with('.'))
}

struct LinkResolver<'a> {
    root: &'a Path,
    doc_dir: String,
    files: Option<Vec<String>>,
}

impl<'a> LinkResolver<'a> {
    fn existing(&self, rel: &str) -> Option<PathBuf> {
        let abs = notes::resolve_in_vault(self.root, rel).ok()?;
        abs.is_file().then_some(abs)
    }

    /// Every `.md` file, `notes/` first, as vault-relative paths.
    fn files(&mut self) -> &[String] {
        if self.files.is_none() {
            let mut list: Vec<String> = Vec::new();
            for dir in [self.root.join("notes"), self.root.to_path_buf()] {
                for f in notes::collect_md_files(&dir).unwrap_or_default() {
                    if let Some(rel) = rel_of(self.root, &f) {
                        if !is_hidden_rel(&rel) && !list.contains(&rel) {
                            list.push(rel);
                        }
                    }
                }
            }
            self.files = Some(list);
        }
        self.files.as_deref().unwrap_or_default()
    }

    fn resolve(&mut self, link: &LinkTarget) -> Option<PathBuf> {
        match link {
            LinkTarget::Md(target) => {
                let candidates = [
                    join_lexical(&self.doc_dir, target),
                    join_lexical("", target),
                ];
                candidates
                    .iter()
                    .flatten()
                    .find_map(|rel| self.existing(rel))
            }
            LinkTarget::Wiki(name) => {
                let stem = name.strip_suffix(".md").unwrap_or(name).to_lowercase();
                if stem.contains('/') {
                    let rel = format!("{stem}.md");
                    let hit = self
                        .files()
                        .iter()
                        .find(|f| {
                            let lf = f.to_lowercase();
                            lf == rel || lf == format!("notes/{rel}")
                        })
                        .cloned();
                    return hit.and_then(|r| self.existing(&r));
                }
                let by_stem = self
                    .files()
                    .iter()
                    .find(|f| {
                        let file = f.rsplit('/').next().unwrap_or(f);
                        file.strip_suffix(".md").unwrap_or(file).to_lowercase() == stem
                    })
                    .cloned();
                if let Some(rel) = by_stem {
                    return self.existing(&rel);
                }
                // Fall back to front-matter titles under notes/.
                let root = self.root;
                let hit = self
                    .files()
                    .iter()
                    .filter(|f| f.starts_with("notes/"))
                    .find(|f| {
                        notes::resolve_in_vault(root, f)
                            .ok()
                            .and_then(|p| std::fs::read_to_string(p).ok())
                            .and_then(|c| notes::parse_front_matter(&c).0.title)
                            .is_some_and(|t| t.trim().to_lowercase() == stem)
                    })
                    .cloned();
                hit.and_then(|r| self.existing(&r))
            }
        }
    }
}

/// Append the content of notes linked from each user message
/// (chatgpt-md style), at most [`MAX_LINKS`] per message. Missing or
/// out-of-vault targets are skipped silently.
pub fn expand_links(vault_root: &Path, doc_rel_path: &str, messages: &mut [Message]) {
    let doc_dir = doc_rel_path
        .rsplit_once('/')
        .map(|(d, _)| d.to_string())
        .unwrap_or_default();
    let mut resolver = LinkResolver {
        root: vault_root,
        doc_dir,
        files: None,
    };
    for msg in messages.iter_mut().filter(|m| m.role == Role::User) {
        let links = find_links(&msg.content);
        let mut added = 0;
        let mut seen: Vec<PathBuf> = Vec::new();
        for link in links {
            if added >= MAX_LINKS {
                break;
            }
            let Some(abs) = resolver.resolve(&link) else {
                continue;
            };
            if seen.contains(&abs) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&abs) else {
                continue;
            };
            let (fm, body) = notes::parse_front_matter(&text);
            let title = fm
                .title
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| {
                    abs.file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default()
                });
            msg.content.push_str(&format!(
                "\n\nLink title: {title}\nLink content: {}",
                body.trim()
            ));
            seen.push(abs);
            added += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn hdr(role: &str) -> String {
        format!("### role::{role}<span style=\"font-size: small;\"> (openai@gpt-4.1-mini)</span>")
    }

    #[test]
    fn splits_messages_on_hr_with_roles() {
        let body = format!(
            "hello there\n\n{HR}\n\n{}\nHi! How can I help?\n\n{HR}\n\n### role::user\nmore\n",
            hdr("assistant")
        );
        let msgs = parse_messages(&body);
        assert_eq!(
            msgs,
            vec![
                Message::new(Role::User, "hello there"),
                Message::new(Role::Assistant, "Hi! How can I help?"),
                Message::new(Role::User, "more"),
            ]
        );
    }

    #[test]
    fn roles_system_developer_and_empty_parts() {
        let body = format!(
            "### role::system\nbe brief\n{HR}\n## role::developer\nrules\n{HR}\n\n   \n{HR}\n### role::assistant\n\n"
        );
        let msgs = parse_messages(&body);
        assert_eq!(
            msgs,
            vec![
                Message::new(Role::System, "be brief"),
                Message::new(Role::Developer, "rules"),
            ]
        );
    }

    #[test]
    fn comments_are_removed() {
        let body = "keep =begin-chatgpt-md-comment\nsecret\n=end-chatgpt-md-comment this\n=begin-chatgpt-md-comment open";
        let msgs = parse_messages(body);
        assert_eq!(msgs.len(), 1);
        assert_eq!(
            msgs[0].content,
            "keep  this\n=begin-chatgpt-md-comment open"
        );
    }

    #[test]
    fn front_matter_scalars_and_lists() {
        let doc = "---\nmodel: anthropic@claude-sonnet-4\ntemperature: 0.2\nmax_tokens: 100\nstream: false\nsystem_commands:\n  - 'be terse'\n  - \"use markdown\"\nurl: https://x.example\n---\nhi";
        let (fm, body) = split_document(doc);
        assert_eq!(body, "hi");
        let l = SettingsLayer::from_map(&fm).unwrap();
        assert_eq!(l.model.as_deref(), Some("anthropic@claude-sonnet-4"));
        assert_eq!(l.temperature, Some(0.2));
        assert_eq!(l.max_tokens, Some(100));
        assert_eq!(l.stream, Some(false));
        assert_eq!(l.system_commands, vec!["be terse", "use markdown"]);
        assert_eq!(l.url.as_deref(), Some("https://x.example"));

        let (fm, _) = split_document("---\nsystem_commands: ['a, b', c]\n---\n");
        assert_eq!(
            SettingsLayer::from_map(&fm).unwrap().system_commands,
            vec!["a, b", "c"]
        );
        let (fm, _) = split_document("---\nsystem_commands: just one\n---\n");
        assert_eq!(
            SettingsLayer::from_map(&fm).unwrap().system_commands,
            vec!["just one"]
        );
        let (fm, _) = split_document("---\ntemperature: hot\n---\n");
        assert!(matches!(
            SettingsLayer::from_map(&fm),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn model_strings() {
        assert_eq!(
            parse_model("ollama@llama3.2:8b").unwrap(),
            (Provider::Ollama, "llama3.2:8b".into())
        );
        assert_eq!(
            parse_model("openrouter@anthropic/claude-3.5").unwrap(),
            (Provider::OpenRouter, "anthropic/claude-3.5".into())
        );
        assert_eq!(
            parse_model("gpt-4o").unwrap(),
            (Provider::OpenAi, "gpt-4o".into())
        );
        for bad in ["", "nope@x", "openai@", "  "] {
            assert!(parse_model(bad).is_err(), "{bad:?}");
        }
    }

    fn ai_with_keys() -> AiConfig {
        let mut ai = AiConfig::default();
        for p in ai.providers.values_mut() {
            p.api_key = Some("k".into());
        }
        ai
    }

    #[test]
    fn priority_note_over_agent_over_global() {
        let dir = tempdir().unwrap();
        let agents = dir.path().join("notes/agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("Writer.md"),
            "---\nmodel: anthropic@claude-x\ntemperature: 0.1\ntop_p: 0.5\nsystem_commands: agent cmd\n---\nYou are a writer.\n",
        )
        .unwrap();
        let ai = ai_with_keys();
        let doc = "---\nagent: Writer\ntemperature: 0.9\n---\nhello";
        let p = prepare_chat(dir.path(), "notes/chats/c.md", doc, &ai).unwrap();
        assert_eq!(p.provider, Provider::Anthropic);
        assert_eq!(p.model, "claude-x");
        assert_eq!(p.params.temperature, 0.9);
        assert_eq!(p.params.top_p, Some(0.5));
        assert_eq!(p.params.max_tokens, 4096);
        assert!(p.stream);
        assert_eq!(
            p.messages,
            vec![
                Message::new(Role::System, "agent cmd"),
                Message::new(Role::System, "You are a writer."),
                Message::new(Role::User, "hello"),
            ]
        );
        // Note-level system_commands replace the agent's.
        let doc = "---\nagent: Writer\nsystem_commands: [mine]\n---\nhello";
        let p = prepare_chat(dir.path(), "c.md", doc, &ai).unwrap();
        assert_eq!(p.messages[0], Message::new(Role::System, "mine"));
        // Missing agent.
        let err = prepare_chat(dir.path(), "c.md", "---\nagent: Nope\n---\nhi", &ai).unwrap_err();
        assert!(matches!(err, AppError::Validation(m) if m.contains("Agent not found")));
        // Global defaults with no front matter.
        let p = prepare_chat(dir.path(), "c.md", "hi", &ai).unwrap();
        assert_eq!(p.provider, Provider::OpenAi);
        assert_eq!(p.model, "gpt-4.1-mini");
        assert_eq!(p.params.temperature, 0.7);
        assert_eq!(p.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn missing_key_empty_doc_and_bad_url() {
        let dir = tempdir().unwrap();
        let ai = AiConfig::default();
        let err = prepare_chat(dir.path(), "c.md", "hi", &ai).unwrap_err();
        assert!(
            matches!(&err, AppError::Validation(m) if m == "No API key for openai. Add it in Settings → AI."),
            "{err:?}"
        );
        // Keyless local providers are fine.
        let p = prepare_chat(
            dir.path(),
            "c.md",
            "---\nmodel: ollama@llama3\n---\nhi",
            &ai,
        )
        .unwrap();
        assert_eq!(p.base_url, "http://localhost:11434");
        assert!(p.api_key.is_none());
        assert!(matches!(
            prepare_chat(
                dir.path(),
                "c.md",
                &format!("---\nmodel: ollama@x\n---\n{HR}\n"),
                &ai
            ),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            prepare_chat(
                dir.path(),
                "c.md",
                "---\nmodel: ollama@x\nurl: http://evil.example\n---\nhi",
                &ai
            ),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn url_override_must_match_configured_base_url() {
        let dir = tempdir().unwrap();
        let ai = ai_with_keys();
        let is_url_err = |r: Result<PreparedChat, AppError>| matches!(r, Err(AppError::Validation(m)) if m.contains("must match the base URL"));
        // Mismatch, keyed provider.
        assert!(is_url_err(prepare_chat(
            dir.path(),
            "c.md",
            "---
model: openai@gpt
url: https://evil.example/v1
---
hi",
            &ai
        )));
        // Mismatch, keyless provider.
        assert!(is_url_err(prepare_chat(
            dir.path(),
            "c.md",
            "---
model: ollama@x
url: https://evil.example
---
hi",
            &ai
        )));
        // Match (with case + trailing slash normalization), keyed and keyless.
        let p = prepare_chat(
            dir.path(),
            "c.md",
            "---
model: openai@gpt
url: HTTPS://API.OpenAI.com/v1/
---
hi",
            &ai,
        )
        .unwrap();
        assert_eq!(p.base_url, "https://api.openai.com/v1");
        assert!(p.api_key.is_some());
        let p = prepare_chat(
            dir.path(),
            "c.md",
            "---
model: ollama@x
url: http://localhost:11434/
---
hi",
            &ai,
        )
        .unwrap();
        assert_eq!(p.base_url, "http://localhost:11434");
        // Path is case-sensitive.
        assert!(is_url_err(prepare_chat(
            dir.path(),
            "c.md",
            "---
model: openai@gpt
url: https://api.openai.com/V1
---
hi",
            &ai
        )));
        // Agent-file url follows the same rule.
        let agents = dir.path().join("notes/agents");
        std::fs::create_dir_all(&agents).unwrap();
        std::fs::write(
            agents.join("Bad.md"),
            "---
model: openai@gpt
url: https://evil.example
---
prompt",
        )
        .unwrap();
        std::fs::write(
            agents.join("Good.md"),
            "---
model: openai@gpt
url: https://api.openai.com/v1/
---
prompt",
        )
        .unwrap();
        assert!(is_url_err(prepare_chat(
            dir.path(),
            "c.md",
            "---
agent: Bad
---
hi",
            &ai
        )));
        assert!(prepare_chat(
            dir.path(),
            "c.md",
            "---
agent: Good
---
hi",
            &ai
        )
        .is_ok());
        // No url: unchanged (settings base URL).
        let p = prepare_chat(
            dir.path(),
            "c.md",
            "---
model: openai@gpt
---
hi",
            &ai,
        )
        .unwrap();
        assert_eq!(p.base_url, "https://api.openai.com/v1");
        // resolve_request (also used by ai_infer_title) enforces the rule directly.
        let layer = SettingsLayer {
            model: Some("ollama@x".into()),
            url: Some("http://evil.example".into()),
            ..Default::default()
        };
        assert!(is_url_err(resolve_request(&ai, &layer, vec![])));
    }

    #[test]
    fn link_expansion_wiki_and_md() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes/sub")).unwrap();
        std::fs::create_dir_all(root.join("journal")).unwrap();
        std::fs::write(
            root.join("notes/Alpha.md"),
            "---\ntitle: The Alpha\n---\nalpha body\n",
        )
        .unwrap();
        std::fs::write(root.join("notes/sub/beta note.md"), "beta body").unwrap();
        std::fs::write(root.join("journal/2026-01-01.md"), "journal body").unwrap();
        std::fs::write(
            root.join("notes/titled.md"),
            "---\ntitle: Gamma Ray\n---\ngamma",
        )
        .unwrap();

        let mut msgs = vec![
            Message::new(
                Role::User,
                "see [[alpha]] and [b](sub/beta%20note.md) and [[2026-01-01|day]] and [[Gamma Ray]] \
                 and [[Missing]] and [x](../../../etc/passwd.md) and [w](https://x.com/a.md) and [[alpha]]",
            ),
            Message::new(Role::Assistant, "[[alpha]]"),
        ];
        expand_links(root, "notes/chat.md", &mut msgs);
        let c = &msgs[0].content;
        assert!(
            c.contains("\n\nLink title: The Alpha\nLink content: alpha body"),
            "{c}"
        );
        assert!(
            c.contains("Link title: beta note\nLink content: beta body"),
            "{c}"
        );
        assert!(c.contains("Link content: journal body"), "{c}");
        assert!(
            c.contains("Link title: Gamma Ray\nLink content: gamma"),
            "{c}"
        );
        assert_eq!(c.matches("Link title:").count(), 4, "{c}");
        assert_eq!(msgs[1].content, "[[alpha]]");
    }

    #[test]
    fn link_expansion_caps_at_ten() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        let mut text = String::new();
        for i in 0..12 {
            std::fs::write(dir.path().join(format!("notes/n{i}.md")), format!("b{i}")).unwrap();
            text.push_str(&format!("[[n{i}]] "));
        }
        let mut msgs = vec![Message::new(Role::User, text)];
        expand_links(dir.path(), "x.md", &mut msgs);
        assert_eq!(msgs[0].content.matches("Link title:").count(), MAX_LINKS);
    }

    #[test]
    fn lexical_join() {
        assert_eq!(
            join_lexical("notes/a", "../b.md").as_deref(),
            Some("notes/b.md")
        );
        assert_eq!(join_lexical("notes", "/x.md").as_deref(), Some("x.md"));
        assert_eq!(join_lexical("", "../x.md"), None);
    }
}
