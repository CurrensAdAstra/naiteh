//! Note metadata helpers — front matter parsing, snippet generation,
//! recursive `.md` discovery. See architecture.md §4.4 / §6.2.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::domain::{AppError, NoteMeta};

const SNIPPET_LEN: usize = 200;

/// Subset of front matter fields naiteh actually consumes today.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct FrontMatter {
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub pinned: bool,
}

/// Parse a `---\n…\n---\n` block at the start of `content`. Returns the
/// extracted fields and the body that follows. Falls back to the entire
/// content as body when no front matter is present (or it is malformed).
pub fn parse_front_matter(content: &str) -> (FrontMatter, &str) {
    let Some(rest) = content.strip_prefix("---\n") else {
        return (FrontMatter::default(), content);
    };
    let Some(end) = rest.find("\n---\n") else {
        return (FrontMatter::default(), content);
    };
    let header = &rest[..end];
    let body = &rest[end + "\n---\n".len()..];
    (parse_header(header), body)
}

fn parse_header(header: &str) -> FrontMatter {
    let mut out = FrontMatter::default();
    for line in header.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "title" => out.title = Some(strip_quotes(value).to_string()),
            "tags" => out.tags = parse_array(value),
            "pinned" => out.pinned = value.eq_ignore_ascii_case("true"),
            _ => {}
        }
    }
    out
}

fn strip_quotes(s: &str) -> &str {
    let trimmed = s.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"') && trimmed.len() >= 2)
        || (trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2)
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

fn parse_array(s: &str) -> Vec<String> {
    let s = s.trim();
    let Some(inner) = s.strip_prefix('[').and_then(|s| s.strip_suffix(']')) else {
        return Vec::new();
    };
    inner
        .split(',')
        .map(|t| strip_quotes(t).to_string())
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
    let metadata = std::fs::metadata(abs_path)?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let size = metadata.len();
    let content = std::fs::read_to_string(abs_path).unwrap_or_default();
    let (fm, body) = parse_front_matter(&content);
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

/// Reject vault-relative paths that escape the vault (`..`) or are absolute.
pub fn check_rel_path(rel_path: &str) -> Result<(), AppError> {
    if rel_path.is_empty() {
        return Err(AppError::InvalidPath("empty path".into()));
    }
    let p = Path::new(rel_path);
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                return Err(AppError::InvalidPath(format!(
                    "'..' segment not allowed: {rel_path}"
                )));
            }
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                return Err(AppError::InvalidPath(format!(
                    "absolute path not allowed: {rel_path}"
                )));
            }
            _ => {}
        }
    }
    Ok(())
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
    check_rel_path(rel_path)?;
    let canon_root = vault_root
        .canonicalize()
        .map_err(|e| AppError::Io(format!("vault root unavailable: {e}")))?;
    // Build the target on the *original* root so the returned path keeps
    // the spelling callers expect (read_note_meta strips `vault_root`).
    // The containment check below uses the canonical form.
    let target = vault_root.join(rel_path);

    let mut existing = target.as_path();
    let canon_existing = loop {
        match existing.canonicalize() {
            Ok(c) => break c,
            Err(_) => match existing.parent() {
                Some(parent) => existing = parent,
                None => {
                    return Err(AppError::InvalidPath(format!(
                        "cannot resolve path: {rel_path}"
                    )))
                }
            },
        }
    };

    if !canon_existing.starts_with(&canon_root) {
        return Err(AppError::InvalidPath(format!(
            "path escapes the vault: {rel_path}"
        )));
    }
    Ok(target)
}

/// Convert a free-form title into a filesystem-safe slug. Returns
/// `"untitled"` when the title contains no alphanumerics.
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
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

/// Update or insert `pinned: true|false` inside a Markdown file's front
/// matter. If no front matter exists and `pinned` is true, prepend a
/// fresh block; if it is false, leave the content unchanged.
pub fn set_pinned_in_content(content: &str, pinned: bool) -> String {
    let value = if pinned { "true" } else { "false" };
    if let Some(rest) = content.strip_prefix("---\n") {
        if let Some(end) = rest.find("\n---\n") {
            let header = &rest[..end];
            let body_start = "---\n".len() + end + "\n---\n".len();
            let body = &content[body_start..];
            let new_header = upsert_pinned_line(header, value);
            return format!("---\n{new_header}\n---\n{body}");
        }
    }
    if pinned {
        format!("---\npinned: true\n---\n{content}")
    } else {
        content.to_string()
    }
}

fn upsert_pinned_line(header: &str, value: &str) -> String {
    let mut found = false;
    let mut lines: Vec<String> = header
        .lines()
        .map(|line| {
            if let Some((key, _)) = line.split_once(':') {
                if key.trim() == "pinned" {
                    found = true;
                    return format!("pinned: {value}");
                }
            }
            line.to_string()
        })
        .collect();
    if !found {
        lines.push(format!("pinned: {value}"));
    }
    lines.join("\n")
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
    fn set_pinned_inserts_block_when_no_front_matter() {
        let result = set_pinned_in_content("body text\n", true);
        assert_eq!(result, "---\npinned: true\n---\nbody text\n");
    }

    #[test]
    fn set_pinned_no_change_when_unsetting_without_front_matter() {
        let result = set_pinned_in_content("body text\n", false);
        assert_eq!(result, "body text\n");
    }

    #[test]
    fn set_pinned_replaces_existing_pinned_line() {
        let input = "---\ntitle: Foo\npinned: false\n---\nbody";
        let result = set_pinned_in_content(input, true);
        assert!(result.contains("pinned: true"));
        assert!(result.contains("title: Foo"));
        assert!(!result.contains("pinned: false"));
        assert!(result.ends_with("body"));
    }

    #[test]
    fn set_pinned_appends_when_front_matter_lacks_pinned() {
        let input = "---\ntitle: Foo\n---\nbody";
        let result = set_pinned_in_content(input, true);
        assert!(result.contains("title: Foo"));
        assert!(result.contains("pinned: true"));
        assert!(result.ends_with("body"));
    }
}
