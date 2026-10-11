//! Attachment import helpers. Files are copied into `<vault>/attachments/`
//! and referenced by vault-relative Markdown links.

use std::path::{Path, PathBuf};

use crate::domain::{AppError, AttachmentImport};
use crate::services::fs as fsx;
use crate::services::fs_naming;
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
        .map(fs_naming::sanitize_file_name)
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
    let label = fs_naming::label_for(&final_name);
    let markdown = if fs_naming::is_image_filename(&final_name) {
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
    let cleaned = fs_naming::sanitize_file_name(suggested);
    if !cleaned.is_empty() && cleaned != "attachment" {
        return cleaned;
    }
    let stamp = chrono::Utc::now().format("%Y-%m-%d-%H%M%S").to_string();
    let ext = mime
        .and_then(fs_naming::extension_for_mime)
        .unwrap_or("bin");
    format!("paste-{stamp}.{ext}")
}

/// Pick a free path under `attachments/`. Every candidate goes through
/// `notes::resolve_in_vault`, so a synced `attachments -> /elsewhere`
/// symlink (or a hostile name) can't redirect the write outside the
/// vault.
fn available_target(vault_root: &Path, file_name: &str) -> Result<PathBuf, AppError> {
    let dir = notes::resolve_in_vault(vault_root, DIR)?;
    fsx::ensure_dir(&dir)?;
    let resolve = |name: &str| notes::resolve_in_vault(vault_root, &format!("{DIR}/{name}"));
    let path = resolve(file_name)?;
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
        let candidate = resolve(&candidate_name)?;
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(AppError::Conflict(format!(
        "could not create a unique attachment name for {file_name}"
    )))
}

/// Largest image the Markdown viewer will inline. Images travel to the
/// webview as base64 `data:` URLs (the CSP allows `img-src data:`), so
/// keep this well under the attachment limit.
const MAX_VIEWER_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

/// How many candidate paths one viewer image request may probe.
pub const MAX_IMAGE_CANDIDATES: usize = 4;

fn image_mime_for(file_name: &str) -> Option<&'static str> {
    let ext = Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

/// Read an image for the Markdown viewer and return it as a `data:` URL.
///
/// `candidates` are vault-relative paths tried in order (the viewer sends
/// the note-relative reading of a link first, then the vault-relative
/// one, because naiteh's own attachments are vault-relative while
/// Evernote imports sit next to their note). Each candidate goes through
/// [`notes::resolve_in_vault`], so `..`, absolute paths, `.git` and
/// symlinks out of the vault are refused. Only image extensions are
/// served. `NotFound` when no candidate is an existing image file.
pub fn read_image_data_url(vault_root: &Path, candidates: &[String]) -> Result<String, AppError> {
    use base64::Engine as _;

    if candidates.is_empty() || candidates.len() > MAX_IMAGE_CANDIDATES {
        return Err(AppError::Validation(format!(
            "expected 1-{MAX_IMAGE_CANDIDATES} image paths"
        )));
    }
    for rel in candidates {
        let Some(mime) = image_mime_for(rel) else {
            continue;
        };
        let Ok(abs) = notes::resolve_in_vault(vault_root, rel) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&abs) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_VIEWER_IMAGE_BYTES {
            return Err(AppError::Validation(format!(
                "image is {} bytes; the viewer shows images up to {MAX_VIEWER_IMAGE_BYTES} bytes (20 MiB)",
                meta.len()
            )));
        }
        let bytes = std::fs::read(&abs)?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(format!("data:{mime};base64,{encoded}"));
    }
    Err(AppError::NotFound(candidates.join(", ")))
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
        let result = import_bytes(vault.path(), &at_limit, "ok.bin", None).unwrap();
        assert_eq!(
            std::fs::metadata(vault.path().join(&result.rel_path))
                .unwrap()
                .len(),
            MAX_ATTACHMENT_BYTES
        );
    }

    #[test]
    fn import_bytes_uses_suggested_name_when_safe() {
        let vault = tempdir().unwrap();
        let result = import_bytes(
            vault.path(),
            b"png-data",
            "Screen Shot.PNG",
            Some("image/png"),
        )
        .unwrap();
        assert_eq!(result.rel_path, "attachments/screen-shot.png");
        assert_eq!(
            result.markdown,
            "![screen shot](attachments/screen-shot.png)"
        );
        assert_eq!(
            std::fs::read(vault.path().join(&result.rel_path)).unwrap(),
            b"png-data"
        );
    }

    #[test]
    fn import_bytes_synthesizes_paste_name_when_suggestion_empty() {
        let vault = tempdir().unwrap();
        let result = import_bytes(vault.path(), b"png-data", "", Some("image/png")).unwrap();
        // Filename should look like paste-YYYY-MM-DD-HHMMSS.png
        assert!(result.file_name.starts_with("paste-"));
        assert!(result.file_name.ends_with(".png"));
        assert!(result.markdown.starts_with("!["));
    }

    #[test]
    fn import_bytes_falls_back_to_bin_when_mime_unknown() {
        let vault = tempdir().unwrap();
        let result = import_bytes(vault.path(), b"raw", "", Some("application/x-weird")).unwrap();
        assert!(result.file_name.ends_with(".bin"));
        // Unknown mime + .bin extension → non-image markdown form.
        assert!(result.markdown.starts_with("["));
        assert!(!result.markdown.starts_with("!["));
    }

    #[test]
    fn import_bytes_rejects_empty_payload() {
        let vault = tempdir().unwrap();
        let err = import_bytes(vault.path(), &[], "x.png", Some("image/png")).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
    }

    #[test]
    fn import_bytes_strips_directories_from_suggested_name() {
        let vault = tempdir().unwrap();
        let result = import_bytes(vault.path(), b"x", "../../evil.png", None).unwrap();
        assert_eq!(result.rel_path, "attachments/evil.png");
    }

    #[cfg(unix)]
    #[test]
    fn import_refuses_symlinked_attachments_dir_escaping_vault() {
        use std::os::unix::fs::symlink;
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), vault.path().join("attachments")).unwrap();
        let err = import_bytes(vault.path(), b"x", "a.png", None).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn import_refuses_junctioned_attachments_dir_escaping_vault() {
        let vault = tempdir().unwrap();
        let outside = tempdir().unwrap();
        // Directory junctions need no special privilege on Windows.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(vault.path().join("attachments"))
            .arg(outside.path())
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let err = import_bytes(vault.path(), b"x", "a.png", None).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "got {err:?}");
        assert!(std::fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[test]
    fn import_bytes_disambiguates_repeated_pastes() {
        let vault = tempdir().unwrap();
        let first = import_bytes(vault.path(), b"a", "note.txt", Some("text/plain")).unwrap();
        let second = import_bytes(vault.path(), b"b", "note.txt", Some("text/plain")).unwrap();
        assert_eq!(first.rel_path, "attachments/note.txt");
        assert_eq!(second.rel_path, "attachments/note-2.txt");
    }

    // ── read_image_data_url (Markdown viewer) ───────────────────────────

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        fsx::atomic_write(&p, bytes).unwrap();
    }

    #[test]
    fn read_image_returns_first_existing_candidate_as_data_url() {
        let vault = tempdir().unwrap();
        put(vault.path(), "attachments/a.png", b"PNG");
        let url = read_image_data_url(
            vault.path(),
            &["notes/attachments/a.png".into(), "attachments/a.png".into()],
        )
        .unwrap();
        assert_eq!(url, "data:image/png;base64,UE5H");
    }

    #[test]
    fn read_image_prefers_the_earlier_candidate() {
        let vault = tempdir().unwrap();
        put(vault.path(), "notes/trip/photo.jpg", b"near");
        put(vault.path(), "photo.jpg", b"far");
        let url = read_image_data_url(
            vault.path(),
            &["notes/trip/photo.jpg".into(), "photo.jpg".into()],
        )
        .unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"), "{url}");
        assert!(url.ends_with("bmVhcg=="), "{url}");
    }

    #[test]
    fn read_image_refuses_escapes_and_non_images() {
        let vault = tempdir().unwrap();
        put(vault.path(), "notes/secret.md", b"text");
        put(vault.path(), ".git/x.png", b"git");
        for bad in [
            "../outside.png",
            "notes/secret.md",
            ".git/x.png",
            "C:/x.png",
            "/etc/x.png",
        ] {
            let err = read_image_data_url(vault.path(), &[bad.into()]).unwrap_err();
            assert!(matches!(err, AppError::NotFound(_)), "{bad}: {err:?}");
        }
    }

    #[test]
    fn read_image_validates_candidate_count() {
        let vault = tempdir().unwrap();
        assert!(matches!(
            read_image_data_url(vault.path(), &[]),
            Err(AppError::Validation(_))
        ));
        let many: Vec<String> = (0..=MAX_IMAGE_CANDIDATES)
            .map(|i| format!("{i}.png"))
            .collect();
        assert!(matches!(
            read_image_data_url(vault.path(), &many),
            Err(AppError::Validation(_))
        ));
    }
}
