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
//!
//! ## Streaming, atomicity, locking
//!
//! - The `.enex` is streamed (`parser::EnexReader`): one note is parsed,
//!   converted, written, and dropped before the next is read.
//! - Each note is converted to Markdown **before** anything is written;
//!   a note that fails conversion leaves nothing on disk. If a write
//!   fails part-way, the note's (freshly created) folder is removed.
//! - Callers pass an `acquire` closure that is invoked once per note and
//!   whose returned guard is held only while that note is written — the
//!   IPC command uses it to take the vault lock per note, so autosave
//!   isn't blocked for the length of a multi-thousand-note import.
//! - An attachment whose name would be `index.md` (any case) is renamed
//!   so it can't overwrite the note body.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::SecondsFormat;

use crate::domain::{AppError, EvernoteImportReport, EvernoteImportedNote};
use crate::services::evernote::enml::enml_to_markdown;
use crate::services::evernote::parser::{count_notes, open_enex, EvernoteNote, Resource};
use crate::services::fs as fsx;
use crate::services::fs_naming;
use crate::services::notes;

/// Name of the note body inside each imported note folder.
const NOTE_FILE: &str = "index.md";

/// Import every note in `enex_path` into `vault_root`, ignoring
/// progress and without any locking. The notebook name is taken from
/// the file stem. The IPC command uses the `_with_progress` variant;
/// this wrapper is the convenience entry point for tests and any future
/// caller that doesn't need updates.
#[allow(dead_code)]
pub fn import_enex(vault_root: &Path, enex_path: &Path) -> Result<EvernoteImportReport, AppError> {
    import_enex_with_progress(vault_root, enex_path, || (), |_, _| {})
}

/// Like `import_enex`, but invokes `on_progress(done, total)` after each
/// note is processed so callers can surface progress for a large
/// `.enex` (which can hold thousands of notes). `total` comes from a
/// cheap counting pass; `on_progress(0, total)` fires before the first
/// write. `acquire()` is called before each note is written and the
/// guard it returns is dropped right after (see module docs).
///
/// A file that is malformed from the start fails with `Err` and writes
/// nothing. If the stream breaks *after* some notes were imported, the
/// error is recorded in the report (`failed_count` / `errors`) and the
/// partial report is returned as `Ok`, so the caller still sees — and
/// re-indexes — what landed.
pub fn import_enex_with_progress<G>(
    vault_root: &Path,
    enex_path: &Path,
    mut acquire: impl FnMut() -> G,
    mut on_progress: impl FnMut(usize, usize),
) -> Result<EvernoteImportReport, AppError> {
    let notebook = notebook_from_filename(enex_path);
    let total = count_notes(enex_path)?;
    let mut reader = open_enex(enex_path)?;

    let mut report = EvernoteImportReport::default();
    let mut used_slugs: Vec<String> = Vec::new();
    on_progress(0, total);

    let mut idx = 0usize;
    loop {
        let note = match reader.next_note() {
            Ok(Some(note)) => note,
            Ok(None) => break,
            Err(e) => {
                report.failed_count += 1;
                report.errors.push(format!("{}: {e}", enex_path.display()));
                break;
            }
        };
        let result = {
            let _guard = acquire();
            import_one_note(vault_root, &notebook, idx, &note, &mut used_slugs)
        };
        match result {
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
        idx += 1;
        on_progress(idx, total.max(idx));
    }

    Ok(report)
}

/// A resource ready to be written: final file name + bytes.
struct PlannedFile<'a> {
    file_name: String,
    data: &'a [u8],
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

    // ── plan: names + Markdown, no disk writes yet ────────────────────
    let mut warnings: Vec<String> = Vec::new();
    let mut resources_md: HashMap<String, String> = HashMap::new();
    // Reserve the note body's name so no attachment can claim it.
    let mut used_resource_names: Vec<String> = vec![NOTE_FILE.to_string()];
    let mut planned: Vec<PlannedFile<'_>> = Vec::new();

    for (r_idx, resource) in note.resources.iter().enumerate() {
        if is_dropped_mime(&resource.mime) {
            warnings.push(format!(
                "dropped resource ({}): naiteh cannot render this format",
                resource.mime
            ));
            continue;
        }
        let file_name = pick_resource_name(resource, r_idx, &mut used_resource_names);
        let label = fs_naming::label_for(&file_name);
        let markdown = if fs_naming::is_image_mime(&resource.mime)
            || fs_naming::is_image_filename(&file_name)
        {
            format!("![{label}]({file_name})")
        } else {
            format!("[{label}]({file_name})")
        };
        resources_md.insert(resource.md5_hash_hex.clone(), markdown);
        planned.push(PlannedFile {
            file_name,
            data: &resource.data,
        });
    }

    // Convert first: a conversion failure must leave nothing on disk.
    let body = enml_to_markdown(&note.content_xml, &resources_md)?;
    let front_matter = build_front_matter(&title, note, &warnings);
    let full = format!("{front_matter}\n{body}\n");

    // ── write: containment-checked, rolled back on failure ────────────
    let note_rel = format!("notes/{notebook_slug}/{slug}");
    let note_dir = notes::resolve_in_vault(vault_root, &note_rel)?;
    if let Err(e) = write_note_files(vault_root, &note_rel, &planned, &full) {
        // unique_slug guaranteed the folder didn't exist before this
        // note, so removing it only discards our own partial output.
        let _ = std::fs::remove_dir_all(&note_dir);
        return Err(e);
    }

    let rel_path = format!("{note_rel}/{NOTE_FILE}");
    Ok(EvernoteImportedNote {
        source_title: title,
        rel_path,
        warnings,
    })
}

fn write_note_files(
    vault_root: &Path,
    note_rel: &str,
    planned: &[PlannedFile<'_>],
    body: &str,
) -> Result<(), AppError> {
    let resolve = |name: &str| -> Result<PathBuf, AppError> {
        notes::resolve_in_vault(vault_root, &format!("{note_rel}/{name}"))
    };
    fsx::ensure_dir(&notes::resolve_in_vault(vault_root, note_rel)?)?;
    for file in planned {
        fsx::atomic_write(&resolve(&file.file_name)?, file.data)?;
    }
    fsx::atomic_write(&resolve(NOTE_FILE)?, body.as_bytes())
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

/// Choose a unique file name for a resource within its note folder.
/// Names are compared case-insensitively (two attachments differing
/// only in case would collide on Windows/macOS), and `used` is
/// pre-seeded with `index.md` so an attachment can never overwrite the
/// note body.
fn pick_resource_name(r: &Resource, index: usize, used: &mut Vec<String>) -> String {
    let candidate = if let Some(name) = &r.file_name {
        fs_naming::sanitize_file_name(name)
    } else {
        let ext = fs_naming::extension_for_mime(&r.mime).unwrap_or("bin");
        format!("attachment-{}.{}", index + 1, ext)
    };
    let taken = |used: &[String], name: &str| {
        let lower = name.to_lowercase();
        used.iter().any(|u| u.to_lowercase() == lower)
    };
    if !taken(used, &candidate) {
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
        if !taken(used, &next) {
            used.push(next.clone());
            return next;
        }
    }
    let fallback = format!("{stem}-{}", chrono::Utc::now().timestamp());
    used.push(fallback.clone());
    fallback
}

fn is_dropped_mime(mime: &str) -> bool {
    // Evernote's handwritten "ink" notes have no portable rendering;
    // we drop and warn rather than emit unreadable binaries.
    let m = mime.to_ascii_lowercase();
    m.contains("vnd.evernote.ink")
}

fn build_front_matter(title: &str, note: &EvernoteNote, warnings: &[String]) -> String {
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

/// Shared with `notes_create` so the note parser's `parse_scalar` reads
/// back exactly what we wrote (control characters included).
fn yaml_quote(s: &str) -> String {
    notes::yaml_quote(s)
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
        assert_eq!(
            imported.rel_path,
            "notes/personal-notes/hello-note/index.md"
        );

        let body = std::fs::read_to_string(
            vault
                .path()
                .join("notes/personal-notes/hello-note/index.md"),
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
    fn progress_callback_reports_zero_then_each_note() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notebook.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note><title>A</title><content><![CDATA[<en-note/>]]></content></note>
  <note><title>B</title><content><![CDATA[<en-note/>]]></content></note>
  <note><title>C</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#,
        );

        let mut seen: Vec<(usize, usize)> = Vec::new();
        let report = import_enex_with_progress(
            vault.path(),
            &enex,
            || (),
            |done, total| {
                seen.push((done, total));
            },
        )
        .unwrap();

        assert_eq!(report.imported_count, 3);
        // First callback is (0, total); then one per written note.
        assert_eq!(seen, vec![(0, 3), (1, 3), (2, 3), (3, 3)]);
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

        let body = std::fs::read_to_string(note_dir.join("index.md")).unwrap();
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
    fn failed_conversion_leaves_no_orphan_folder_or_attachments() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>Broken</title>
    <content><![CDATA[<en-note><p>unclosed</en-note>]]></content>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>image/png</mime>
      <resource-attributes><file-name>cat.png</file-name></resource-attributes>
    </resource>
  </note>
  <note><title>Fine</title><content><![CDATA[<en-note>ok</en-note>]]></content></note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1);
        assert_eq!(report.failed_count, 1);
        assert!(!vault.path().join("notes/notes/broken").exists());
        assert!(vault.path().join("notes/notes/fine/index.md").is_file());
    }

    #[test]
    fn attachment_named_index_md_does_not_clobber_note_body() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note>
    <title>Clash</title>
    <content><![CDATA[<en-note><p>real body</p><en-media hash="5d41402abc4b2a76b9719d911017c592" type="text/markdown"/></en-note>]]></content>
    <resource>
      <data encoding="base64">aGVsbG8=</data>
      <mime>text/markdown</mime>
      <resource-attributes><file-name>INDEX.MD</file-name></resource-attributes>
    </resource>
  </note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1);
        let dir = vault.path().join("notes/notes/clash");
        let body = std::fs::read_to_string(dir.join("index.md")).unwrap();
        assert!(body.contains("real body"), "got {body}");
        assert!(body.contains("(index-2.md)"), "got {body}");
        assert_eq!(std::fs::read(dir.join("index-2.md")).unwrap(), b"hello");
    }

    #[test]
    fn resource_names_differing_only_by_case_get_distinct_files() {
        let mut used = vec![NOTE_FILE.to_string()];
        let r = |name: &str| Resource {
            mime: "image/png".into(),
            file_name: Some(name.into()),
            data: vec![],
            md5_hash_hex: String::new(),
        };
        let a = pick_resource_name(&r("Cat.png"), 0, &mut used);
        let b = pick_resource_name(&r("cat.PNG"), 1, &mut used);
        assert_ne!(a.to_lowercase(), b.to_lowercase());
    }

    #[test]
    fn reserved_notebook_and_note_names_are_suffixed() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "CON.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note><title>aux</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.notes[0].rel_path, "notes/con-note/aux-note/index.md");
        assert!(vault
            .path()
            .join("notes/con-note/aux-note/index.md")
            .is_file());
    }

    #[test]
    fn html_entities_in_content_import_successfully() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note><title>Ent</title><content><![CDATA[<en-note><p>a&nbsp;b &mdash; c</p></en-note>]]></content></note>
</en-export>"#,
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        assert_eq!(report.imported_count, 1, "errors: {:?}", report.errors);
        let body = std::fs::read_to_string(vault.path().join(&report.notes[0].rel_path)).unwrap();
        assert!(body.contains("a\u{a0}b — c"), "got {body}");
    }

    #[test]
    fn acquire_is_called_once_per_note_and_released_between_notes() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notebook.enex",
            r#"<?xml version="1.0"?>
<en-export>
  <note><title>A</title><content><![CDATA[<en-note/>]]></content></note>
  <note><title>B</title><content><![CDATA[<en-note/>]]></content></note>
</en-export>"#,
        );
        let lock = std::sync::Mutex::new(());
        let mut acquired = 0;
        let report = import_enex_with_progress(
            vault.path(),
            &enex,
            || {
                acquired += 1;
                // Would deadlock if the previous note's guard were still held.
                lock.try_lock()
                    .expect("guard from previous note still held")
            },
            |_, _| {},
        )
        .unwrap();
        assert_eq!(report.imported_count, 2);
        assert_eq!(acquired, 2);
    }

    #[test]
    fn malformed_file_fails_without_writing_anything() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            r#"<en-export><note><title>A</title><content><![CDATA[<en-note/>]]></content></note><note><title>B"#,
        );
        assert!(import_enex(vault.path(), &enex).is_err());
        assert!(!vault.path().join("notes").exists());
    }

    #[test]
    fn title_with_newline_round_trips_through_front_matter() {
        let vault = tempdir().unwrap();
        let src = tempdir().unwrap();
        let enex = write_enex(
            src.path(),
            "Notes.enex",
            "<?xml version=\"1.0\"?>\n<en-export><note><title>Line&#10;pinned: true</title><content><![CDATA[<en-note/>]]></content></note></en-export>",
        );
        let report = import_enex(vault.path(), &enex).unwrap();
        let abs = vault.path().join(&report.notes[0].rel_path);
        let meta = notes::read_note_meta(vault.path(), &abs).unwrap();
        assert_eq!(meta.title, "Line\npinned: true");
        assert!(!meta.pinned);
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
        let body = std::fs::read_to_string(vault.path().join(&report.notes[0].rel_path)).unwrap();
        // Both the " and the \ should be escaped inside the quoted value.
        assert!(
            body.contains(r#"title: "Quote: \"hello\" & backslash \\""#),
            "got: {body}"
        );
    }
}
