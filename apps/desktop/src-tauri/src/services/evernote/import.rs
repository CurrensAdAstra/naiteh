//! High-level Evernote import orchestrator.
//!
//! Reads a `.enex` file, parses it into notes + resources, converts
//! each note to Markdown, and lays the result out under the vault as:
//!
//! ```text
//! notes/<notebook-slug>/<note-slug>/
//!     index.md
//!     img-1.png        (resources keyed by name or hash)
//!     plan.pdf
//! ```
//!
//! The notebook slug is derived from the `.enex` filename (stripping
//! the extension and slugifying). Slug collisions are resolved with
//! `-2`, `-3`, … suffixes so re-importing the same export doesn't
//! clobber prior runs.
//!
//! Per-note "warnings" (ink resources, unknown MIME types, etc.) are
//! captured in the front matter (`import_warnings: [...]`) so the user
//! can see what was dropped without diff-ing against the original.

// The public surface is exercised by integration tests in this module
// but is not yet called by lib code — the IPC command wires it in C4.
#![allow(dead_code)]

use std::collections::HashMap;
use std::path::Path;

use chrono::SecondsFormat;

use crate::domain::{AppError, EvernoteImportReport, EvernoteImportedNote};
use crate::services::evernote::enml::enml_to_markdown;
use crate::services::evernote::parser::{parse_enex, EvernoteNote, Resource};
use crate::services::fs as fsx;
use crate::services::notes;

/// Import every note in `enex_path` into `vault_root`. The notebook
/// name is taken from the file stem.
pub fn import_enex(
    vault_root: &Path,
    enex_path: &Path,
) -> Result<EvernoteImportReport, AppError> {
    let notebook = notebook_from_filename(enex_path);
    let notes = parse_enex(enex_path)?;
    import_notes(vault_root, &notebook, notes)
}

/// Like `import_enex` but takes already-parsed notes. Used by tests
/// and (in a later commit) by an "import multiple files" loop that
/// reports progress between files.
pub fn import_notes(
    vault_root: &Path,
    notebook_slug: &str,
    notes_in: Vec<EvernoteNote>,
) -> Result<EvernoteImportReport, AppError> {
    let mut report = EvernoteImportReport::default();
    let mut used_slugs: Vec<String> = Vec::new();

    for (idx, note) in notes_in.into_iter().enumerate() {
        match import_one_note(vault_root, notebook_slug, idx, &note, &mut used_slugs) {
            Ok(record) => {
                report.imported_count += 1;
                report.notes.push(record);
            }
            Err(e) => {
                report.failed_count += 1;
                report.errors.push(format!(
                    "note \"{}\": {e}",
                    if note.title.is_empty() {
                        "(untitled)".into()
                    } else {
                        note.title.clone()
                    }
                ));
            }
        }
    }

    Ok(report)
}

fn import_one_note(
    vault_root: &Path,
    notebook_slug: &str,
    index: usize,
    note: &EvernoteNote,
    used_slugs: &mut Vec<String>,
) -> Result<EvernoteImportedNote, AppError> {
    let title = if note.title.is_empty() {
        format!("untitled-{}", index + 1)
    } else {
        note.title.clone()
    };
    let base_slug = notes::slugify(&title);
    let slug = unique_slug(vault_root, notebook_slug, &base_slug, used_slugs);
    used_slugs.push(slug.clone());

    let note_dir = vault_root
        .join("notes")
        .join(notebook_slug)
        .join(&slug);
    fsx::ensure_dir(&note_dir)?;

    let mut warnings: Vec<String> = Vec::new();
    let mut resources_md: HashMap<String, String> = HashMap::new();
    let mut used_resource_names: Vec<String> = Vec::new();

    for (r_idx, resource) in note.resources.iter().enumerate() {
        if is_dropped_mime(&resource.mime) {
            warnings.push(format!(
                "dropped resource ({}): naiteh cannot render this format",
                resource.mime
            ));
            continue;
        }
        let file_name =
            pick_resource_name(resource, r_idx, &mut used_resource_names);
        let resource_path = note_dir.join(&file_name);
        fsx::atomic_write(&resource_path, &resource.data)?;

        let label = label_for(&file_name);
        let markdown = if is_image_mime(&resource.mime) || is_image_filename(&file_name) {
            format!("![{label}]({file_name})")
        } else {
            format!("[{label}]({file_name})")
        };
        resources_md.insert(resource.md5_hash_hex.clone(), markdown);
    }

    let body = enml_to_markdown(&note.content_xml, &resources_md)?;
    let front_matter = build_front_matter(&title, note, &warnings);
    let full = format!("{front_matter}\n{body}\n");
    let index_path = note_dir.join("index.md");
    fsx::atomic_write(&index_path, full.as_bytes())?;

    let rel_path = index_path
        .strip_prefix(vault_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| index_path.to_string_lossy().into_owned());

    Ok(EvernoteImportedNote {
        source_title: title,
        rel_path,
        warnings,
    })
}

// ── helpers ─────────────────────────────────────────────────────────

fn notebook_from_filename(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("evernote-import");
    let slug = notes::slugify(stem);
    if slug.is_empty() || slug == "untitled" {
        "evernote-import".to_string()
    } else {
        slug
    }
}

fn unique_slug(
    vault_root: &Path,
    notebook_slug: &str,
    base: &str,
    used_in_session: &[String],
) -> String {
    let exists = |s: &str| -> bool {
        used_in_session.iter().any(|u| u == s)
            || vault_root
                .join("notes")
                .join(notebook_slug)
                .join(s)
                .exists()
    };
    if !exists(base) {
        return base.to_string();
    }
    for i in 2..10_000 {
        let candidate = format!("{base}-{i}");
        if !exists(&candidate) {
            return candidate;
        }
    }
    // Astronomical fallback — collision after 9999 retries.
    format!("{base}-{}", chrono::Utc::now().timestamp())
}

fn pick_resource_name(
    r: &Resource,
    index: usize,
    used: &mut Vec<String>,
) -> String {
    let candidate = if let Some(name) = &r.file_name {
        sanitize_attachment_name(name)
    } else {
        let ext = extension_for_mime(&r.mime).unwrap_or("bin");
        format!("attachment-{}.{}", index + 1, ext)
    };
    if !used.iter().any(|u| u == &candidate) {
        used.push(candidate.clone());
        return candidate;
    }
    let p = Path::new(&candidate);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
    for i in 2..10_000 {
        let next = if ext.is_empty() {
            format!("{stem}-{i}")
        } else {
            format!("{stem}-{i}.{ext}")
        };
        if !used.iter().any(|u| u == &next) {
            used.push(next.clone());
            return next;
        }
    }
    let fallback = format!("{stem}-{}", chrono::Utc::now().timestamp());
    used.push(fallback.clone());
    fallback
}

fn sanitize_attachment_name(name: &str) -> String {
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .map(notes::slugify)
        .unwrap_or_else(|| "attachment".to_string());
    let stem = if stem.is_empty() {
        "attachment".to_string()
    } else {
        stem
    };
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if !ext.trim().is_empty() => {
            let ext = ext
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect::<String>()
                .to_ascii_lowercase();
            if ext.is_empty() {
                stem
            } else {
                format!("{stem}.{ext}")
            }
        }
        _ => stem,
    }
}

fn label_for(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .replace('-', " ")
}

fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/avif" => Some("avif"),
        "application/pdf" => Some("pdf"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" | "audio/m4a" => Some("m4a"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "video/mp4" => Some("mp4"),
        "text/plain" => Some("txt"),
        "text/html" => Some("html"),
        "application/zip" => Some("zip"),
        _ => None,
    }
}

fn is_image_mime(mime: &str) -> bool {
    mime.to_ascii_lowercase().starts_with("image/")
}

fn is_image_filename(file_name: &str) -> bool {
    matches!(
        Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("avif" | "bmp" | "gif" | "jpeg" | "jpg" | "png" | "svg" | "webp")
    )
}

fn is_dropped_mime(mime: &str) -> bool {
    // Evernote's handwritten "ink" notes have no portable rendering;
    // we drop and warn rather than emit unreadable binaries.
    let m = mime.to_ascii_lowercase();
    m.contains("vnd.evernote.ink")
}

fn build_front_matter(
    title: &str,
    note: &EvernoteNote,
    warnings: &[String],
) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("title: {}\n", yaml_quote(title)));
    if let Some(created) = note.created {
        out.push_str(&format!(
            "created: {}\n",
            created.to_rfc3339_opts(SecondsFormat::Secs, true)
        ));
    }
    if let Some(updated) = note.updated {
        out.push_str(&format!(
            "updated: {}\n",
            updated.to_rfc3339_opts(SecondsFormat::Secs, true)
        ));
    }
    if !note.tags.is_empty() {
        out.push_str("tags: [");
        let escaped: Vec<String> = note.tags.iter().map(|t| yaml_quote(t)).collect();
        out.push_str(&escaped.join(", "));
        out.push_str("]\n");
    }
    if let Some(url) = &note.source_url {
        out.push_str(&format!("source_url: {}\n", yaml_quote(url)));
    }
    if let Some(author) = &note.author {
        out.push_str(&format!("author: {}\n", yaml_quote(author)));
    }
    out.push_str("imported_from: evernote\n");
    if !warnings.is_empty() {
        out.push_str("import_warnings:\n");
        for w in warnings {
            out.push_str(&format!("  - {}\n", yaml_quote(w)));
        }
    }
    out.push_str("---\n");
    out
}

/// Conservative YAML scalar quoter — always double-quotes and escapes
/// `"` + `\`. Good enough for our title/tag/url payloads.
fn yaml_quote(s: &str) -> String {
    let escaped: String = s
        .chars()
        .map(|c| match c {
            '\\' => "\\\\".to_string(),
            '"' => "\\\"".to_string(),
            '\n' => "\\n".to_string(),
            '\r' => "\\r".to_string(),
            _ => c.to_string(),
        })
        .collect();
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn write_enex(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn end_to_end_single_note() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Personal Notes.enex",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<en-export>
  <note>
    <title>Hello Note</title>
    <content><![CDATA[<en-note><p>Body</p></en-note>]]></content>
    <created>20260101T123000Z</created>
    <tag>work</tag>
  </note>
</en-export>"#,
        );

        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1);
        assert_eq!(report.failed_count, 0);
        let imported = &report.notes[0];
        assert_eq!(imported.source_title, "Hello Note");
        assert_eq!(imported.rel_path, "notes/personal-notes/hello-note/index.md");

        let body = std::fs::read_to_string(
            vault.path().join("notes/personal-notes/hello-note/index.md"),
        )
        .unwrap();
        assert!(body.starts_with("---\n"));
        assert!(body.contains("title: \"Hello Note\""));
        assert!(body.contains("created: 2026-01-01T12:30:00Z"));
        assert!(body.contains("tags: [\"work\"]"));
        assert!(body.contains("imported_from: evernote"));
        assert!(body.contains("Body"));
    }

    #[test]
    fn slug_collision_falls_back_to_dash_two() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let make_enex = |title: &str| {
            format!(
                r#"<?xml version="1.0"?>
<en-export>
  <note><title>{title}</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#
            )
        };
        let p1 = write_enex(src.path(), "Books.enex", &make_enex("Same Title"));
        let r1 = import_enex(vault.path(), &p1).unwrap();
        assert_eq!(r1.notes[0].rel_path, "notes/books/same-title/index.md");

        let p2 = write_enex(src.path(), "Books.enex", &make_enex("Same Title"));
        let r2 = import_enex(vault.path(), &p2).unwrap();
        assert_eq!(r2.notes[0].rel_path, "notes/books/same-title-2/index.md");
    }

    #[test]
    fn resources_are_written_alongside_index_and_linked_in_body() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        // base64("hello") = aGVsbG8=, md5 = 5d41402abc4b2a76b9719d911017c592
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>WithImage</title>
    <content><![CDATA[<en-note><p><en-media hash="5d41402abc4b2a76b9719d911017c592" type="image/png"/></p></en-note>]]></content>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>cat.png</file-name></resource-attributes>
    </resource>
  </note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1);

        let note_dir = vault.path().join("notes/notes/withimage");
        let body = std::fs::read_to_string(note_dir.join("index.md")).unwrap();
        assert!(body.contains("![cat](cat.png)"), "got body: {body}");

        let cat_bytes = std::fs::read(note_dir.join("cat.png")).unwrap();
        assert_eq!(cat_bytes, b"hello");
    }

    #[test]
    fn resource_without_filename_gets_synthetic_name() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>NoName</title>
    <content><![CDATA[<en-note/>]]></content>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>image/png</mime>
    </resource>
  </note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1);
        let note_dir = vault.path().join("notes/notes/noname");
        assert!(note_dir.join("attachment-1.png").exists());
    }

    #[test]
    fn ink_notes_emit_warning_and_are_dropped() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>Ink</title>
    <content><![CDATA[<en-note/>]]></content>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>application/vnd.evernote.ink</mime>
    </resource>
  </note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1);
        let warnings = &report.notes[0].warnings;
        assert!(warnings.iter().any(|w| w.contains("ink")));

        let note_dir = vault.path().join("notes/notes/ink");
        // No resource file should have been written.
        let resource_files: Vec<_> = std::fs::read_dir(&note_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().into_string().unwrap_or_default())
            .filter(|n| n != "index.md")
            .collect();
        assert!(
            resource_files.is_empty(),
            "expected no resources, got {resource_files:?}"
        );

        let body =
            std::fs::read_to_string(note_dir.join("index.md")).unwrap();
        assert!(body.contains("import_warnings:"));
    }

    #[test]
    fn untitled_note_gets_indexed_slug() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note><title></title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.notes[0].rel_path, "notes/notes/untitled-1/index.md");
    }

    #[test]
    fn title_with_only_punctuation_falls_back_to_indexed_slug() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        // slugify("???") = "untitled" → unique_slug should still
        // disambiguate by appending a numeric suffix when collision occurs.
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note><title>???</title><content><![CDATA[<en-note/>]]></content></note>
  <note><title>???</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 2);
        assert_eq!(report.notes[0].rel_path, "notes/notes/untitled/index.md");
        assert_eq!(report.notes[1].rel_path, "notes/notes/untitled-2/index.md");
    }

    #[test]
    fn yaml_special_chars_in_title_are_escaped() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>Quote: "hello" &amp; backslash \</title>
    <content><![CDATA[<en-note/>]]></content>
  </note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        let body = std::fs::read_to_string(
            vault.path().join(&report.notes[0].rel_path),
        )
        .unwrap();
        // Both the " and the \ should be escaped inside the quoted value.
        assert!(
            body.contains(r#"title: "Quote: \"hello\" & backslash \\""#),
            "got: {body}"
        );
    }
}
