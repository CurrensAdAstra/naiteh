//! Note metadata helpers — front matter parsing, snippet generation,
//! recursive `.md` discovery, vault-relative path normalization and
//! containment, slugs. See vault/wiki/vault-and-data.md and
//! vault/wiki/domain-model.md ("Notes").

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use sha2::{Digest, Sha256};

use crate::domain::{AppError, NoteMeta};
use crate::services::fs as fsx;

const SNIPPET_LEN: usize = 200;

// ── versions (optimistic concurrency) ─────────────────────────────────────

/// The **version** token of a document: lowercase hex SHA-256 of the
/// file's bytes on disk. Content-derived, so two machines (or a Drive
/// mirror) agree on it without any shared state, and a save that writes
/// the same bytes back yields the same token. See
/// vault/wiki/concurrency-safety.md ("Optimistic version check").
pub fn file_version(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Current on-disk version of `abs`; `None` when the file does not exist.
pub fn current_version(abs: &Path) -> Result<Option<String>, AppError> {
    match std::fs::read(abs) {
        Ok(bytes) => Ok(Some(file_version(&bytes))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Io(e.to_string())),
    }
}

/// Read a UTF-8 document and the version of the bytes it came from. The
/// raw `io::Error` is returned so callers can map `NotFound` themselves.
pub fn read_document(abs: &Path) -> std::io::Result<(String, String)> {
    let bytes = std::fs::read(abs)?;
    let version = file_version(&bytes);
    let content = String::from_utf8(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    Ok((content, version))
}

/// Compare-and-write. With `expected = Some(v)` the write only happens
/// when the file exists and its current version is `v`; otherwise
/// nothing is written and `StaleWrite(current)` is returned — `current`
/// being the on-disk version, or `""` when the file is gone. With
/// `expected = None` the write is unconditional (new file / legacy
/// caller). Returns the version of the bytes written. Callers hold the
/// per-vault lock so the check and the write are atomic with respect to
/// other app writes.
pub fn write_versioned(
    abs: &Path,
    content: &str,
    expected: Option<&str>,
) -> Result<String, AppError> {
    if let Some(expected) = expected {
        let current = current_version(abs)?.unwrap_or_default();
        if current != expected {
            return Err(AppError::StaleWrite(current));
        }
    }
    fsx::atomic_write(abs, content.as_bytes())?;
    Ok(file_version(content.as_bytes()))
}

/// Subset of front matter fields naiteh actually consumes today.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub pinned: bool,
    /// `event_id` — the calendar event a meeting note belongs to (see
    /// vault/wiki/domain-model.md, "Calendar subscriptions").
    pub event_id: Option<String>,
    /// Raw `created` value (unparsed; see `services::index::parse_created`).
    pub created: Option<String>,
    /// `source_url` — set by web clippings (and Evernote imports).
    pub source_url: Option<String>,
    /// `clip_type` is present (any value).
    pub clip_type: bool,
    /// `imported_from` (e.g. `web-clipper`, `evernote`).
    pub imported_from: Option<String>,
}

/// A front-matter block split out of a document.
pub(crate) struct FrontMatterParts<'a> {
    /// Lines between the fences, without the fences or the newline that
    /// precedes the closing fence (may be empty).
    pub(crate) header: &'a str,
    /// Everything after the closing fence's line terminator.
    pub(crate) body: &'a str,
}

/// Find a `---` block at the very start of `content`. Accepts LF and
/// CRLF line endings (files edited on Windows) and a closing fence at
/// end of file with no trailing newline. `None` when there is no block
/// or it is never closed.
pub(crate) fn split_front_matter(content: &str) -> Option<FrontMatterParts<'_>> {
    let rest = match content.strip_prefix("---\r\n") {
        Some(r) => r,
        None => content.strip_prefix("---\n")?,
    };
    let mut pos = 0;
    loop {
        let line_end = rest[pos..].find('\n').map(|i| pos + i);
        let line = &rest[pos..line_end.unwrap_or(rest.len())];
        if line.trim_end_matches('\r') == "---" {
            let before = &rest[..pos];
            let before = before.strip_suffix('\n').unwrap_or(before);
            let header = before.strip_suffix('\r').unwrap_or(before);
            let body = line_end.map_or("", |e| &rest[e + 1..]);
            return Some(FrontMatterParts { header, body });
        }
        pos = line_end? + 1;
    }
}

/// Parse a `---` … `---` block at the start of `content` (LF or CRLF).
/// Returns the extracted fields and the body that follows. Falls back to
/// the entire content as body when no front matter is present (or it is
/// malformed).
pub fn parse_front_matter(content: &str) -> (FrontMatter, &str) {
    match split_front_matter(content) {
        Some(parts) => (parse_header(parts.header), parts.body),
        None => (FrontMatter::default(), content),
    }
}

/// A front-matter value as read by [`parse_yaml_map`].
#[derive(Debug, Clone, PartialEq)]
pub enum FmValue {
    Scalar(String),
    List(Vec<String>),
}

/// Parsed front matter: key → value (last occurrence of a key wins).
pub type FrontMatterMap = BTreeMap<String, FmValue>;

/// The one front-matter reader shared by notes, the index, search and
/// chat notes (see vault/wiki/vault-and-data.md, "Front matter"). A
/// small YAML subset:
///
/// - `key: scalar` — quoted scalars are unescaped by [`parse_scalar`]
///   (the exact inverse of [`yaml_quote`]);
/// - `key: [a, "b, c"]` — flow lists, quote-aware;
/// - `key:` followed by `- item` lines (indented or not) — block lists;
/// - `key:` with nothing after it — an empty list.
///
/// CRLF line endings, blank lines and `#` comments are tolerated; other
/// indented lines (nested maps) are ignored.
pub fn parse_yaml_map(header: &str) -> FrontMatterMap {
    let mut map = FrontMatterMap::new();
    let mut list_key: Option<String> = None;
    for line in header.lines() {
        let line = line.trim_end_matches('\r');
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if let Some(item) = t.strip_prefix("- ").or((t == "-").then_some("")) {
            if let Some(FmValue::List(v)) = list_key.as_ref().and_then(|k| map.get_mut(k)) {
                let item = parse_scalar(item);
                if !item.is_empty() {
                    v.push(item);
                }
            }
            continue;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        list_key = None;
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_string();
        let v = v.trim();
        if v.is_empty() {
            map.insert(key.clone(), FmValue::List(Vec::new()));
            list_key = Some(key);
        } else if v.len() >= 2 && v.starts_with('[') && v.ends_with(']') {
            map.insert(key, FmValue::List(parse_array(v)));
        } else {
            map.insert(key, FmValue::Scalar(parse_scalar(v)));
        }
    }
    map
}

fn parse_header(header: &str) -> FrontMatter {
    let map = parse_yaml_map(header);
    let scalar = |k: &str| match map.get(k) {
        Some(FmValue::Scalar(s)) => Some(s.as_str()),
        _ => None,
    };
    let non_empty = |k: &str| scalar(k).filter(|s| !s.is_empty()).map(str::to_string);
    FrontMatter {
        title: scalar("title").map(str::to_string),
        tags: match map.get("tags") {
            Some(FmValue::List(v)) => v.clone(),
            _ => Vec::new(),
        },
        pinned: scalar("pinned").is_some_and(|v| v.eq_ignore_ascii_case("true")),
        event_id: non_empty("event_id"),
        created: non_empty("created"),
        source_url: non_empty("source_url"),
        clip_type: match map.get("clip_type") {
            Some(FmValue::Scalar(s)) => !s.is_empty(),
            Some(FmValue::List(v)) => !v.is_empty(),
            None => false,
        },
        imported_from: non_empty("imported_from"),
    }
}

/// Quote a YAML scalar as a double-quoted string. Escapes `\`, `"`,
/// newlines, tabs and every other control character so a value can
/// never break out of its line (e.g. a title injecting extra front
/// matter keys or a closing `---`). [`parse_scalar`] is the exact
/// inverse, so values round-trip.
pub fn yaml_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() || c == '\u{2028}' || c == '\u{2029}' => {
                let code = c as u32;
                if code <= 0xFF {
                    out.push_str(&format!("\\x{code:02x}"));
                } else {
                    out.push_str(&format!("\\u{code:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Parse one YAML scalar value as written by [`yaml_quote`] (or by a
/// human): double-quoted strings are un-escaped, single-quoted strings
/// have `''` collapsed to `'`, anything else is taken verbatim (trimmed).
pub fn parse_scalar(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        return unescape_double_quoted(&t[1..t.len() - 1]);
    }
    if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        return t[1..t.len() - 1].replace("''", "'");
    }
    t.to_string()
}

/// Inverse of the escaping in [`yaml_quote`]. Unknown escapes are kept
/// literally (backslash included) rather than dropped.
fn unescape_double_quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        let Some(esc) = chars.next() else {
            out.push('\\');
            break;
        };
        let hex_len = match esc {
            'x' => 2,
            'u' => 4,
            'U' => 8,
            _ => 0,
        };
        if hex_len > 0 {
            let digits: String = chars.clone().take(hex_len).collect();
            let decoded = (digits.len() == hex_len)
                .then(|| u32::from_str_radix(&digits, 16).ok())
                .flatten()
                .and_then(char::from_u32);
            match decoded {
                Some(ch) => {
                    out.push(ch);
                    for _ in 0..hex_len {
                        chars.next();
                    }
                }
                None => {
                    out.push('\\');
                    out.push(esc);
                }
            }
            continue;
        }
        match esc {
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            '0' => out.push('\0'),
            '"' => out.push('"'),
            '\\' => out.push('\\'),
            '/' => out.push('/'),
            ' ' => out.push(' '),
            other => {
                out.push('\\');
                out.push(other);
            }
        }
    }
    out
}

/// Parse a flow sequence (`[a, "b, c", 'd']`), honouring quotes so a
/// comma inside a quoted item doesn't split it.
fn parse_array(s: &str) -> Vec<String> {
    let s = s.trim();
    let Some(inner) = s.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Vec::new();
    };
    let mut items: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_double = false;
    let mut in_single = false;
    let mut escaped = false;
    for c in inner.chars() {
        if in_double {
            current.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_double = false;
            }
            continue;
        }
        if in_single {
            current.push(c);
            if c == '\'' {
                in_single = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_double = true;
                current.push(c);
            }
            '\'' => {
                in_single = true;
                current.push(c);
            }
            ',' => items.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    items.push(current);
    items
        .iter()
        .map(|t| parse_scalar(t))
        .filter(|t| !t.is_empty())
        .collect()
}

/// First H1 heading in the body (`# Title`), if any.
pub fn first_h1(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        line.strip_prefix("# ")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

/// Up to [`SNIPPET_LEN`] characters from the start of `body`, with leading
/// whitespace trimmed.
pub fn make_snippet(body: &str) -> String {
    body.trim_start().chars().take(SNIPPET_LEN).collect()
}

/// Read filesystem mtime as unix seconds. Returns 0 on platforms / files
/// where mtime is unavailable rather than failing the whole call.
pub fn mtime_secs(path: &Path) -> i64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Build [`NoteMeta`] for `abs_path`. Title falls back to first H1, then
/// filename stem. Tags / pinned come from front matter.
pub fn read_note_meta(vault_root: &Path, abs_path: &Path) -> Result<NoteMeta, AppError> {
    let content = std::fs::read_to_string(abs_path).unwrap_or_default();
    note_meta_from_content(vault_root, abs_path, &content)
}

/// Build [`NoteMeta`] from already-read `content`, reusing the caller's
/// read instead of re-opening the file. Still issues one cheap
/// `metadata()` syscall for mtime/size. Used by the tag index so it can
/// cache full metadata at build time without a second read per file.
pub fn note_meta_from_content(
    vault_root: &Path,
    abs_path: &Path,
    content: &str,
) -> Result<NoteMeta, AppError> {
    let metadata = std::fs::metadata(abs_path)?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let size = metadata.len();
    let (fm, body) = parse_front_matter(content);
    let title = fm
        .title
        .clone()
        .or_else(|| first_h1(body))
        .unwrap_or_else(|| {
            abs_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        });
    let rel_path = abs_path
        .strip_prefix(vault_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs_path.to_string_lossy().to_string());
    Ok(NoteMeta {
        path: abs_path.to_string_lossy().to_string(),
        rel_path,
        title,
        tags: fm.tags,
        mtime,
        size,
        pinned: fm.pinned,
    })
}

/// Lexically normalize a vault-relative path, component by component.
///
/// The wire format is `/`-separated. Rejected outright (never "fixed
/// up", so a caller can't smuggle a different target past a string
/// comparison):
///   - empty input, empty components (`a//b`), `.` and `..` components
///   - backslashes (an alternate separator on Windows)
///   - absolute paths (`/x`) and drive / UNC prefixes (`C:`, `C:\`)
///   - NUL bytes; on Windows also `:` (alternate data streams) and
///     components with trailing dots/spaces, which Win32 silently strips
///     (`notes/_inbox.` would otherwise *be* `notes/_inbox`)
///
/// Trailing `/` separators are tolerated and dropped. Returns the
/// canonical `/`-joined spelling.
pub fn normalize_rel_path(rel_path: &str) -> Result<String, AppError> {
    let invalid = |why: &str| AppError::InvalidPath(format!("{why}: {rel_path}"));
    if rel_path.is_empty() {
        return Err(AppError::InvalidPath("empty path".into()));
    }
    if rel_path.contains('\\') {
        return Err(invalid("backslash not allowed in path"));
    }
    if rel_path.contains('\0') {
        return Err(invalid("NUL not allowed in path"));
    }
    if rel_path.starts_with('/') {
        return Err(invalid("absolute path not allowed"));
    }
    let trimmed = rel_path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(invalid("empty path"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for (i, comp) in trimmed.split('/').enumerate() {
        match comp {
            "" => return Err(invalid("empty path segment not allowed")),
            "." => return Err(invalid("'.' segment not allowed")),
            ".." => return Err(invalid("'..' segment not allowed")),
            _ => {}
        }
        if i == 0 && comp.contains(':') {
            return Err(invalid("absolute path not allowed"));
        }
        // The repository internals (hooks, config) are never note
        // content: writing there could plant a git hook or rewrite the
        // remote. Case-insensitive because Windows / macOS file systems
        // are; on Windows also the 8.3 alias (`GIT~1`).
        if comp.eq_ignore_ascii_case(".git") || (cfg!(windows) && is_git_short_name(comp)) {
            return Err(invalid("path inside .git not allowed"));
        }
        if cfg!(windows) {
            if comp.contains(':') {
                return Err(invalid("':' not allowed in path"));
            }
            if comp.ends_with('.') || comp.ends_with(' ') {
                return Err(invalid("path segment may not end with '.' or ' '"));
            }
        }
        parts.push(comp);
    }
    // Belt and braces: let the platform parser confirm there's no
    // prefix / root / parent component we failed to spot lexically.
    for c in Path::new(trimmed).components() {
        match c {
            std::path::Component::Normal(_) => {}
            std::path::Component::ParentDir => {
                return Err(invalid("'..' segment not allowed"));
            }
            _ => return Err(invalid("absolute path not allowed")),
        }
    }
    Ok(parts.join("/"))
}

/// `GIT~1`, `git~2`, … — the Windows 8.3 short-name alias `.git` gets.
fn is_git_short_name(comp: &str) -> bool {
    let lower = comp.to_ascii_lowercase();
    lower
        .strip_prefix("git~")
        .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
}

/// Reject vault-relative paths that escape the vault (`..`), are
/// absolute, or are otherwise not in normal form. See
/// [`normalize_rel_path`].
pub fn check_rel_path(rel_path: &str) -> Result<(), AppError> {
    normalize_rel_path(rel_path).map(|_| ())
}

/// Join a normalized `/`-separated rel path onto `root` using native
/// separators.
fn join_rel(root: &Path, normalized: &str) -> PathBuf {
    let mut out = root.to_path_buf();
    for part in normalized.split('/') {
        out.push(part);
    }
    out
}

/// Canonicalize `path` even if its tail doesn't exist yet: the deepest
/// existing ancestor is canonicalized (resolving symlinks / case /
/// 8.3 short names) and the non-existent remainder is appended as-is.
/// Returns `None` if no ancestor can be canonicalized.
pub fn canonicalize_lenient(path: &Path) -> Option<PathBuf> {
    let mut existing = path;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    loop {
        match existing.canonicalize() {
            Ok(mut c) => {
                for part in tail.iter().rev() {
                    c.push(part);
                }
                return Some(c);
            }
            Err(_) => {
                tail.push(existing.file_name()?);
                existing = existing.parent()?;
            }
        }
    }
}

/// Resolve a vault-relative path to an absolute path, refusing anything
/// that would escape the vault — including via a **symlink** anywhere in
/// the existing portion of the path.
///
/// `check_rel_path` only blocks lexical `..` / absolute paths; it can't
/// catch a symlink (e.g. `notes/evil -> /`) that a malicious synced
/// remote committed into the vault. This canonicalizes the deepest
/// existing ancestor of the target (which resolves any symlinks in it)
/// and asserts the result stays under the canonical vault root. The
/// non-existent tail (a not-yet-created note + its dirs) carries no
/// symlinks of its own, so checking the existing prefix is sufficient.
///
/// Returns the (lexically-joined, non-canonical) target path so atomic
/// writes still land at the intended name rather than a resolved one.
pub fn resolve_in_vault(vault_root: &Path, rel_path: &str) -> Result<PathBuf, AppError> {
    let normalized = normalize_rel_path(rel_path)?;
    let canon_root = vault_root
        .canonicalize()
        .map_err(|e| AppError::Io(format!("vault root unavailable: {e}")))?;
    // Build the target on the *original* root so the returned path keeps
    // the spelling callers expect (read_note_meta strips `vault_root`).
    // The containment check below uses the canonical form.
    let target = join_rel(vault_root, &normalized);

    let Some(canon_existing) = canonicalize_lenient(&target) else {
        return Err(AppError::InvalidPath(format!(
            "cannot resolve path: {rel_path}"
        )));
    };

    if !canon_existing.starts_with(&canon_root) {
        return Err(AppError::InvalidPath(format!(
            "path escapes the vault: {rel_path}"
        )));
    }
    Ok(target)
}

/// Maximum slug length in characters (not bytes). 80 chars of even
/// 4-byte UTF-8 stays well under the common 255-byte name limit once a
/// `-N` disambiguator and `.md` are appended.
pub const MAX_SLUG_CHARS: usize = 80;

/// Convert a free-form title into a filesystem-safe slug. Returns
/// `"untitled"` when the title contains no alphanumerics. The result is
/// capped at [`MAX_SLUG_CHARS`] (on a char boundary), never ends in
/// `-`, `.` or a space, and never collides with a Windows reserved
/// device name (`con` → `con-note`).
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                out.push(lower);
            }
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let mut slug: String = out
        .trim_start_matches('-')
        .chars()
        .take(MAX_SLUG_CHARS)
        .collect();
    while slug.ends_with(['-', '.', ' ']) {
        slug.pop();
    }
    if slug.is_empty() {
        return "untitled".to_string();
    }
    avoid_windows_reserved(slug)
}

/// True when `name` (or its part before the first `.`) is a Windows
/// reserved device name — `CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`,
/// `LPT0`–`LPT9` — compared case-insensitively. `con.md` and `nul.txt`
/// are just as unusable as `con` on Windows.
pub fn is_windows_reserved_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    match base.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        _ => {
            let b = base.as_bytes();
            b.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && b[3].is_ascii_digit()
        }
    }
}

/// Suffix a reserved stem so it becomes an ordinary name
/// (`con` → `con-note`). Non-reserved input is returned unchanged.
pub fn avoid_windows_reserved(stem: String) -> String {
    if is_windows_reserved_name(&stem) {
        format!("{stem}-note")
    } else {
        stem
    }
}

/// Recursively collect every `*.md` path under `dir`. Missing directories
/// produce an empty list rather than an error.
pub fn collect_md_files(dir: &Path) -> Result<Vec<PathBuf>, AppError> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return Ok(out);
    }
    walk(dir, &mut out)?;
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            walk(&path, out)?;
        } else if file_type.is_file() && path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_front_matter_returns_default_when_absent() {
        let (fm, body) = parse_front_matter("# hello\nbody text");
        assert_eq!(fm, FrontMatter::default());
        assert_eq!(body, "# hello\nbody text");
    }

    #[test]
    fn parse_front_matter_extracts_title_tags_pinned() {
        let input = concat!(
            "---\n",
            "title: \"Hello world\"\n",
            "tags: [work, idea]\n",
            "pinned: true\n",
            "---\n",
            "actual body\n",
        );
        let (fm, body) = parse_front_matter(input);
        assert_eq!(fm.title.as_deref(), Some("Hello world"));
        assert_eq!(fm.tags, vec!["work".to_string(), "idea".to_string()]);
        assert!(fm.pinned);
        assert_eq!(body, "actual body\n");
    }

    #[test]
    fn parse_front_matter_handles_quoted_tags() {
        let input = "---\ntags: [\"alpha\", 'beta']\n---\nbody";
        let (fm, _) = parse_front_matter(input);
        assert_eq!(fm.tags, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn parse_front_matter_with_unterminated_block_falls_back() {
        let input = "---\ntitle: foo\nno closing fence";
        let (fm, body) = parse_front_matter(input);
        assert_eq!(fm, FrontMatter::default());
        assert_eq!(body, input);
    }

    #[test]
    fn parse_front_matter_accepts_crlf_line_endings() {
        let input = "---\r\ntitle: \"Win\"\r\ntags: [a, b]\r\npinned: true\r\n---\r\nbody\r\n";
        let (fm, body) = parse_front_matter(input);
        assert_eq!(fm.title.as_deref(), Some("Win"));
        assert_eq!(fm.tags, vec!["a".to_string(), "b".to_string()]);
        assert!(fm.pinned);
        assert_eq!(body, "body\r\n");
    }

    #[test]
    fn parse_front_matter_accepts_closing_fence_at_eof() {
        let (fm, body) = parse_front_matter("---\ntitle: T\n---");
        assert_eq!(fm.title.as_deref(), Some("T"));
        assert_eq!(body, "");
    }

    #[test]
    fn first_h1_finds_leading_heading() {
        assert_eq!(first_h1("# Title\nbody"), Some("Title".to_string()));
    }

    #[test]
    fn first_h1_skips_h2_and_paragraphs() {
        assert_eq!(first_h1("text\n## sub\n# real"), Some("real".to_string()));
    }

    #[test]
    fn first_h1_returns_none_when_absent() {
        assert!(first_h1("plain body").is_none());
    }

    #[test]
    fn snippet_trims_leading_whitespace_and_caps_length() {
        let body = format!("\n\n{}", "x".repeat(SNIPPET_LEN + 50));
        let snippet = make_snippet(&body);
        assert_eq!(snippet.chars().count(), SNIPPET_LEN);
        assert!(snippet.starts_with('x'));
    }

    #[test]
    fn read_note_meta_falls_back_to_filename_stem() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("plain.md");
        std::fs::write(&abs, b"no front matter\n").unwrap();
        let meta = read_note_meta(dir.path(), &abs).unwrap();
        assert_eq!(meta.title, "plain");
        assert!(meta.tags.is_empty());
        assert!(!meta.pinned);
        assert_eq!(meta.rel_path, "plain.md");
    }

    #[test]
    fn read_note_meta_uses_first_h1_when_no_title_in_front_matter() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("doc.md");
        std::fs::write(&abs, b"# From Heading\nbody").unwrap();
        let meta = read_note_meta(dir.path(), &abs).unwrap();
        assert_eq!(meta.title, "From Heading");
    }

    #[test]
    fn read_note_meta_prefers_front_matter_title() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("doc.md");
        std::fs::write(
            &abs,
            b"---\ntitle: \"Explicit\"\n---\n# Heading title\nbody",
        )
        .unwrap();
        let meta = read_note_meta(dir.path(), &abs).unwrap();
        assert_eq!(meta.title, "Explicit");
    }

    #[test]
    fn read_note_meta_normalises_rel_path_with_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("notes").join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        let abs = nested.join("doc.md");
        std::fs::write(&abs, b"x").unwrap();
        let meta = read_note_meta(dir.path(), &abs).unwrap();
        assert_eq!(meta.rel_path, "notes/sub/doc.md");
    }

    #[test]
    fn collect_md_files_walks_recursively_and_skips_non_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/one.md"), b"").unwrap();
        std::fs::write(dir.path().join("a/b/two.md"), b"").unwrap();
        std::fs::write(dir.path().join("a/skip.txt"), b"").unwrap();
        let mut files = collect_md_files(dir.path()).unwrap();
        files.sort();
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("a/b/two.md") || files[0].ends_with("a/one.md"));
    }

    #[test]
    fn collect_md_files_returns_empty_for_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let files = collect_md_files(&dir.path().join("missing")).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn check_rel_path_rejects_parent_segment() {
        assert!(matches!(
            check_rel_path("../escape.md"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            check_rel_path("notes/../../etc/passwd"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[test]
    fn check_rel_path_rejects_absolute() {
        assert!(matches!(
            check_rel_path("/etc/passwd"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[test]
    fn check_rel_path_rejects_empty() {
        assert!(matches!(check_rel_path(""), Err(AppError::InvalidPath(_))));
    }

    #[test]
    fn check_rel_path_accepts_normal_paths() {
        assert!(check_rel_path("notes/work/standup.md").is_ok());
        assert!(check_rel_path("notes/_inbox/quick.md").is_ok());
    }

    #[test]
    fn resolve_in_vault_accepts_in_vault_paths_and_keeps_original_root() {
        let v = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(v.path().join("notes")).unwrap();
        let resolved = resolve_in_vault(v.path(), "notes/a.md").unwrap();
        // Returned path is rooted at the (possibly symlinked) input root,
        // so strip_prefix(vault_root) still yields the rel path.
        assert_eq!(
            resolved.strip_prefix(v.path()).unwrap(),
            Path::new("notes/a.md")
        );
    }

    #[test]
    fn resolve_in_vault_allows_creating_a_new_nested_file() {
        let v = tempfile::tempdir().unwrap();
        // notes/ doesn't exist yet; the tail is non-existent but carries
        // no symlink, so it should resolve fine.
        let resolved = resolve_in_vault(v.path(), "notes/new/deep.md").unwrap();
        assert!(resolved.ends_with("notes/new/deep.md"));
    }

    #[test]
    fn resolve_in_vault_rejects_parent_traversal() {
        let v = tempfile::tempdir().unwrap();
        assert!(matches!(
            resolve_in_vault(v.path(), "../escape.md"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn resolve_in_vault_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let v = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), b"top secret").unwrap();
        // notes/evil -> <outside dir>
        std::fs::create_dir_all(v.path().join("notes")).unwrap();
        symlink(outside.path(), v.path().join("notes/evil")).unwrap();

        // Reading through the symlink must be refused even though the
        // lexical path has no `..`.
        let err = resolve_in_vault(v.path(), "notes/evil/secret.md").unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn slugify_lowercases_and_separates_with_hyphens() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("Foo: bar / baz!"), "foo-bar-baz");
        assert_eq!(slugify("  weird  spaces  "), "weird-spaces");
    }

    #[test]
    fn slugify_preserves_unicode_alphanumerics() {
        assert_eq!(slugify("한글 제목"), "한글-제목");
    }

    #[test]
    fn slugify_falls_back_to_untitled() {
        assert_eq!(slugify(""), "untitled");
        assert_eq!(slugify("---"), "untitled");
        assert_eq!(slugify("@@@"), "untitled");
    }

    #[test]
    fn slugify_caps_length_on_a_char_boundary() {
        let long = "가".repeat(200);
        let slug = slugify(&long);
        assert_eq!(slug.chars().count(), MAX_SLUG_CHARS);
        // Truncation landing right after a separator must not leave a
        // trailing dash.
        let tricky = format!("{} tail", "a".repeat(MAX_SLUG_CHARS - 1));
        let slug = slugify(&tricky);
        assert!(!slug.ends_with('-'), "got {slug}");
        assert!(slug.chars().count() <= MAX_SLUG_CHARS);
    }

    #[test]
    fn slugify_avoids_windows_reserved_names() {
        assert_eq!(slugify("CON"), "con-note");
        assert_eq!(slugify("nul"), "nul-note");
        assert_eq!(slugify("Com1"), "com1-note");
        assert_eq!(slugify("LPT9"), "lpt9-note");
        // Not reserved: longer names / no digit.
        assert_eq!(slugify("console"), "console");
        assert_eq!(slugify("com"), "com");
        assert_eq!(slugify("com10"), "com10");
    }

    #[test]
    fn reserved_name_detection_covers_extensions_and_case() {
        assert!(is_windows_reserved_name("con.md"));
        assert!(is_windows_reserved_name("Aux.tar.gz"));
        assert!(is_windows_reserved_name("PRN"));
        assert!(!is_windows_reserved_name("icon.md"));
        assert!(!is_windows_reserved_name("con-note.md"));
    }

    #[test]
    fn yaml_quote_escapes_control_chars_and_round_trips() {
        let samples = [
            "plain",
            "with \"quotes\"",
            "back\\slash\\",
            "multi\nline\r\nvalue",
            "tab\there",
            "bell\u{7}and\u{1b}esc",
            "line\u{2028}sep",
            "한글 제목",
            "",
        ];
        for s in samples {
            let quoted = yaml_quote(s);
            assert!(!quoted.contains('\n') && !quoted.contains('\r'), "{quoted}");
            assert_eq!(parse_scalar(&quoted), s, "round trip of {s:?} via {quoted}");
        }
    }

    #[test]
    fn title_with_newline_cannot_inject_front_matter() {
        let evil = "x\npinned: true\ntags: [pwned]\n---\nbody";
        let doc = format!("---\ntitle: {}\n---\n\nreal body", yaml_quote(evil));
        let (fm, body) = parse_front_matter(&doc);
        assert_eq!(fm.title.as_deref(), Some(evil));
        assert!(!fm.pinned);
        assert!(fm.tags.is_empty());
        assert_eq!(body, "\nreal body");
    }

    #[test]
    fn parse_front_matter_unescapes_quoted_title() {
        let input = "---\ntitle: \"Say \\\"hi\\\" \\\\ bye\"\n---\nbody";
        let (fm, _) = parse_front_matter(input);
        assert_eq!(fm.title.as_deref(), Some("Say \"hi\" \\ bye"));
    }

    #[test]
    fn parse_front_matter_handles_single_quoted_title() {
        let (fm, _) = parse_front_matter("---\ntitle: 'It''s'\n---\n");
        assert_eq!(fm.title.as_deref(), Some("It's"));
    }

    #[test]
    fn parse_front_matter_reads_block_list_tags() {
        let input = "---\r\ntitle: T\r\ntags:\r\n  - work\r\n  - \"a, b\"\r\n  - 'it''s'\r\npinned: true\r\n---\r\nbody";
        let (fm, body) = parse_front_matter(input);
        assert_eq!(fm.tags, vec!["work", "a, b", "it's"]);
        assert_eq!(fm.title.as_deref(), Some("T"));
        assert!(fm.pinned);
        assert_eq!(body, "body");
        // Unindented items are YAML too.
        let (fm, _) = parse_front_matter("---\ntags:\n- x\n- y\nevent_id: e1\n---\n");
        assert_eq!(fm.tags, vec!["x", "y"]);
        assert_eq!(fm.event_id.as_deref(), Some("e1"));
    }

    #[test]
    fn yaml_map_scalars_flow_and_block_lists() {
        let m = parse_yaml_map(
            "a: 1\nb: [x, \"y, z\"]\nc:\n  - p\n  - \"q\\\"r\"\n# note\nd:\nnested:\n  k: v\n",
        );
        assert_eq!(m["a"], FmValue::Scalar("1".into()));
        assert_eq!(m["b"], FmValue::List(vec!["x".into(), "y, z".into()]));
        assert_eq!(m["c"], FmValue::List(vec!["p".into(), "q\"r".into()]));
        assert_eq!(m["d"], FmValue::List(vec![]));
        assert!(!m.contains_key("k"));
        // A scalar `tags:` value is not a list.
        assert!(parse_front_matter("---\ntags: solo\n---\n")
            .0
            .tags
            .is_empty());
    }

    #[test]
    fn parse_array_keeps_commas_inside_quotes_and_unescapes() {
        let input = "---\ntags: [\"a, b\", 'c', d, \"q\\\"x\"]\n---\n";
        let (fm, _) = parse_front_matter(input);
        assert_eq!(fm.tags, vec!["a, b", "c", "d", "q\"x"]);
    }

    #[test]
    fn normalize_rel_path_accepts_clean_paths_and_trailing_slash() {
        assert_eq!(normalize_rel_path("notes/work").unwrap(), "notes/work");
        assert_eq!(normalize_rel_path("notes/work/").unwrap(), "notes/work");
        assert_eq!(
            normalize_rel_path("notes/a b/c.md").unwrap(),
            "notes/a b/c.md"
        );
    }

    #[test]
    fn normalize_rel_path_rejects_dot_empty_backslash_and_prefixes() {
        for bad in [
            "notes/.",
            "notes/./x",
            ".",
            "notes//_inbox",
            "notes/_inbox/.",
            "notes/../x",
            "..",
            "notes\\_inbox",
            "/notes",
            "C:/notes",
            "C:notes",
            "//server/share",
            "/",
            "",
        ] {
            assert!(
                matches!(normalize_rel_path(bad), Err(AppError::InvalidPath(_))),
                "expected rejection of {bad:?}"
            );
        }
    }

    #[test]
    fn normalize_rel_path_rejects_git_components() {
        for bad in [
            ".git",
            ".git/hooks/pre-commit",
            "notes/.git/config",
            ".GIT/config",
            "notes/.Git",
        ] {
            assert!(
                matches!(normalize_rel_path(bad), Err(AppError::InvalidPath(_))),
                "expected rejection of {bad:?}"
            );
        }
        // Lookalikes are ordinary names.
        for ok in [".github/x.md", "notes/.gitignore-notes.md", "notes/git.md"] {
            assert!(normalize_rel_path(ok).is_ok(), "{ok:?} should be allowed");
        }
        let v = tempfile::tempdir().unwrap();
        assert!(resolve_in_vault(v.path(), ".git/hooks/pre-commit").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn normalize_rel_path_rejects_git_short_name_alias() {
        assert!(normalize_rel_path("GIT~1/hooks/pre-commit").is_err());
        assert!(normalize_rel_path("git~12/config").is_err());
        assert!(normalize_rel_path("git~x/config").is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn normalize_rel_path_rejects_win32_stripped_suffixes_and_streams() {
        for bad in ["notes/_inbox.", "notes/_inbox ", "notes/a.md:stream"] {
            assert!(
                matches!(normalize_rel_path(bad), Err(AppError::InvalidPath(_))),
                "expected rejection of {bad:?}"
            );
        }
    }

    #[test]
    fn resolve_in_vault_returns_native_separators() {
        let v = tempfile::tempdir().unwrap();
        let resolved = resolve_in_vault(v.path(), "notes/sub/a.md").unwrap();
        assert_eq!(resolved, v.path().join("notes").join("sub").join("a.md"));
    }

    #[test]
    fn canonicalize_lenient_appends_missing_tail() {
        let v = tempfile::tempdir().unwrap();
        let c = canonicalize_lenient(&v.path().join("missing/deeper")).unwrap();
        assert_eq!(
            c,
            v.path()
                .canonicalize()
                .unwrap()
                .join("missing")
                .join("deeper")
        );
    }

    // ── versions ───────────────────────────────────────────────────────

    #[test]
    fn file_version_is_lowercase_hex_sha256() {
        assert_eq!(
            file_version(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            file_version(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn write_versioned_match_mismatch_missing_and_none() {
        let dir = tempfile::tempdir().unwrap();
        let abs = dir.path().join("n.md");
        // Missing file + expected version → StaleWrite("") and no file.
        let err = write_versioned(&abs, "x", Some("deadbeef")).unwrap_err();
        assert!(
            matches!(&err, AppError::StaleWrite(v) if v.is_empty()),
            "{err:?}"
        );
        assert!(!abs.exists());
        // None writes unconditionally.
        let v1 = write_versioned(&abs, "one", None).unwrap();
        assert_eq!(v1, file_version(b"one"));
        assert_eq!(current_version(&abs).unwrap().as_deref(), Some(v1.as_str()));
        // Matching expected version writes.
        let v2 = write_versioned(&abs, "two", Some(&v1)).unwrap();
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "two");
        // Stale expected version refuses and reports the current one.
        let err = write_versioned(&abs, "three", Some(&v1)).unwrap_err();
        assert!(
            matches!(&err, AppError::StaleWrite(v) if *v == v2),
            "{err:?}"
        );
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "two");
        // read_document agrees with the written version.
        let (content, version) = read_document(&abs).unwrap();
        assert_eq!(content, "two");
        assert_eq!(version, v2);
        assert!(current_version(&dir.path().join("missing.md"))
            .unwrap()
            .is_none());
    }
}
