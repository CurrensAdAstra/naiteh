//! Attachment import helpers. Files are copied into `<vault>/attachments/`
//! and referenced by vault-relative Markdown links.

use std::path::{Path, PathBuf};

use crate::domain::{AppError, AttachmentImport};
use crate::services::fs as fsx;
use crate::services::notes;

const DIR: &str = "attachments";

/// Hard ceiling on a single imported attachment. Guards against both an
/// accidental multi-GB file picked from disk and an unbounded clipboard
/// paste that would otherwise be copied wholesale into the vault (and,
/// for pastes, marshalled as a JSON int-array across the IPC boundary).
/// 50 MiB comfortably covers screenshots, photos, and PDFs.
const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

fn too_large_err(len: u64) -> AppError {
    AppError::InvalidPath(format!(
        "attachment is {len} bytes; the limit is {MAX_ATTACHMENT_BYTES} bytes (50 MiB)"
    ))
}

pub fn import(vault_root: &Path, source: &Path) -> Result<AttachmentImport, AppError> {
    if !source.is_file() {
        return Err(AppError::InvalidPath(format!(
            "not a file: {}",
            source.display()
        )));
    }

    // Check the size from metadata before reading the whole file in.
    let len = std::fs::metadata(source)?.len();
    if len > MAX_ATTACHMENT_BYTES {
        return Err(too_large_err(len));
    }

    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_file_name)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| AppError::InvalidPath("attachment has no file name".into()))?;
    let bytes = std::fs::read(source)?;
    write_and_describe(vault_root, &file_name, &bytes)
}

/// Import an attachment from raw bytes (clipboard paste, drag-and-drop
/// from a browser, etc.) where there is no source path on disk.
///
/// `suggested_name` is hint-only — we sanitize it before using. When
/// empty or all-punctuation we synthesize one from the current
/// timestamp + a MIME-derived extension so pasted screenshots get
/// stable, sortable names like `paste-2026-05-12-153022.png`.
pub fn import_bytes(
    vault_root: &Path,
    bytes: &[u8],
    suggested_name: &str,
    mime: Option<&str>,
) -> Result<AttachmentImport, AppError> {
    if bytes.is_empty() {
        return Err(AppError::InvalidPath("empty attachment payload".into()));
    }
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(too_large_err(bytes.len() as u64));
    }
    let file_name = pick_paste_name(suggested_name, mime);
    write_and_describe(vault_root, &file_name, bytes)
}

/// Common tail: place `bytes` at a unique path under `attachments/`,
/// then build the `AttachmentImport` (rel_path, file_name, markdown
/// snippet) the caller renders into the editor.
fn write_and_describe(
    vault_root: &Path,
    file_name: &str,
    bytes: &[u8],
) -> Result<AttachmentImport, AppError> {
    let target = available_target(vault_root, file_name)?;
    fsx::atomic_write(&target, bytes)?;

    let rel_path = target
        .strip_prefix(vault_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| target.to_string_lossy().replace('\\', "/"));
    let final_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_name)
        .to_string();
    let label = label_for(&final_name);
    let markdown = if is_image(&final_name) {
        format!("![{label}]({rel_path})")
    } else {
        format!("[{label}]({rel_path})")
    };

    Ok(AttachmentImport {
        rel_path,
        file_name: final_name,
        markdown,
    })
}

/// Decide on a filename for a byte-payload paste/drop. Order of
/// preference:
///   1. caller's suggestion, sanitized (preserves browser drag-drop names)
///   2. `paste-YYYY-MM-DD-HHMMSS.<ext>` with extension from MIME
///   3. `paste-YYYY-MM-DD-HHMMSS.bin` as last resort
fn pick_paste_name(suggested: &str, mime: Option<&str>) -> String {
    let cleaned = sanitize_file_name(suggested);
    if !cleaned.is_empty() && cleaned != "attachment" {
        return cleaned;
    }
    let stamp = chrono::Utc::now().format("%Y-%m-%d-%H%M%S").to_string();
    let ext = mime.and_then(extension_for_mime).unwrap_or("bin");
    format!("paste-{stamp}.{ext}")
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
        "text/plain" => Some("txt"),
        _ => None,
    }
}

fn available_target(vault_root: &Path, file_name: &str) -> Result<PathBuf, AppError> {
    let dir = vault_root.join(DIR);
    fsx::ensure_dir(&dir)?;
    let path = dir.join(file_name);
    if !path.exists() {
        return Ok(path);
    }

    let p = Path::new(file_name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext = p.extension().and_then(|e| e.to_str());
    for idx in 2..10_000 {
        let candidate_name = match ext {
            Some(ext) if !ext.is_empty() => format!("{stem}-{idx}.{ext}"),
            _ => format!("{stem}-{idx}"),
        };
        let candidate = dir.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(format!(
        "could not create a unique attachment name for {file_name}"
    )))
}

fn sanitize_file_name(input: &str) -> String {
    let p = Path::new(input);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .map(notes::slugify)
        .unwrap_or_else(|| "attachment".to_string());
    match p.extension().and_then(|e| e.to_str()) {
        Some(ext) if !ext.trim().is_empty() => {
            let ext = ext
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
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

fn is_image(file_name: &str) -> bool {
    matches!(
        Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("avif" | "bmp" | "gif" | "jpeg" | "jpg" | "png" | "svg" | "webp")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn import_copies_file_and_returns_markdown_link() {
        let vault = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        let source = source_dir.path().join("Quarterly Plan.pdf");
        std::fs::write(&source, b"pdf-ish").unwrap();

        let imported = import(vault.path(), &source).unwrap();

        assert_eq!(imported.rel_path, "attachments/quarterly-plan.pdf");
        assert_eq!(
            imported.markdown,
            "[quarterly plan](attachments/quarterly-plan.pdf)"
        );
        assert_eq!(
            std::fs::read(vault.path().join(&imported.rel_path)).unwrap(),
            b"pdf-ish"
        );
    }

    #[test]
    fn image_import_uses_markdown_image_syntax() {
        let vault = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        let source = source_dir.path().join("Screen Shot.PNG");
        std::fs::write(&source, b"png").unwrap();

        let imported = import(vault.path(), &source).unwrap();

        assert_eq!(imported.rel_path, "attachments/screen-shot.png");
        assert_eq!(
            imported.markdown,
            "![screen shot](attachments/screen-shot.png)"
        );
    }

    #[test]
    fn duplicate_names_are_disambiguated() {
        let vault = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        let source = source_dir.path().join("idea.txt");
        std::fs::write(&source, b"one").unwrap();

        let first = import(vault.path(), &source).unwrap();
        let second = import(vault.path(), &source).unwrap();

        assert_eq!(first.rel_path, "attachments/idea.txt");
        assert_eq!(second.rel_path, "attachments/idea-2.txt");
    }

    #[test]
    fn import_rejects_directories() {
        let vault = tempdir().unwrap();
        let source_dir = tempdir().unwrap();

        let err = import(vault.path(), source_dir.path()).unwrap_err();

        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn import_bytes_rejects_payload_over_the_cap() {
        let vault = tempdir().unwrap();
        let oversize = vec![0u8; (MAX_ATTACHMENT_BYTES + 1) as usize];
        let err = import_bytes(vault.path(), &oversize, "big.bin", None).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        // Nothing should have been written.
        assert!(!vault.path().join("attachments").exists());
    }

    #[test]
    fn import_rejects_file_over_the_cap_without_reading_it() {
        let vault = tempdir().unwrap();
        let source_dir = tempdir().unwrap();
        let big = source_dir.path().join("huge.bin");
        // Create a sparse file larger than the cap without allocating it.
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();

        let err = import(vault.path(), &big).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn import_bytes_accepts_payload_at_the_cap() {
        let vault = tempdir().unwrap();
        let at_limit = vec![7u8; MAX_ATTACHMENT_BYTES as usize];
        let result =
            import_bytes(vault.path(), &at_limit, "ok.bin", None).unwrap();
        assert_eq!(
            std::fs::metadata(vault.path().join(&result.rel_path)).unwrap().len(),
            MAX_ATTACHMENT_BYTES
        );
    }

    #[test]
    fn import_bytes_uses_suggested_name_when_safe() {
        let vault = tempdir().unwrap();
        let result =
            import_bytes(vault.path(), b"png-data", "Screen Shot.PNG", Some("image/png"))
                .unwrap();
        assert_eq!(result.rel_path, "attachments/screen-shot.png");
        assert_eq!(result.markdown, "![screen shot](attachments/screen-shot.png)");
        assert_eq!(
            std::fs::read(vault.path().join(&result.rel_path)).unwrap(),
            b"png-data"
        );
    }

    #[test]
    fn import_bytes_synthesizes_paste_name_when_suggestion_empty() {
        let vault = tempdir().unwrap();
        let result =
            import_bytes(vault.path(), b"png-data", "", Some("image/png")).unwrap();
        // Filename should look like paste-YYYY-MM-DD-HHMMSS.png
        assert!(result.file_name.starts_with("paste-"));
        assert!(result.file_name.ends_with(".png"));
        assert!(result.markdown.starts_with("!["));
    }

    #[test]
    fn import_bytes_falls_back_to_bin_when_mime_unknown() {
        let vault = tempdir().unwrap();
        let result =
            import_bytes(vault.path(), b"raw", "", Some("application/x-weird"))
                .unwrap();
        assert!(result.file_name.ends_with(".bin"));
        // Unknown mime + .bin extension → non-image markdown form.
        assert!(result.markdown.starts_with("["));
        assert!(!result.markdown.starts_with("!["));
    }

    #[test]
    fn import_bytes_rejects_empty_payload() {
        let vault = tempdir().unwrap();
        let err = import_bytes(vault.path(), &[], "x.png", Some("image/png"))
            .unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn import_bytes_disambiguates_repeated_pastes() {
        let vault = tempdir().unwrap();
        let first =
            import_bytes(vault.path(), b"a", "note.txt", Some("text/plain")).unwrap();
        let second =
            import_bytes(vault.path(), b"b", "note.txt", Some("text/plain")).unwrap();
        assert_eq!(first.rel_path, "attachments/note.txt");
        assert_eq!(second.rel_path, "attachments/note-2.txt");
    }
}
