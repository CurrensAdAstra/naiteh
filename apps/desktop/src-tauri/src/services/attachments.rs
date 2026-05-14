//! Attachment import helpers. Files are copied into `<vault>/attachments/`
//! and referenced by vault-relative Markdown links.

use std::path::{Path, PathBuf};

use crate::domain::{AppError, AttachmentImport};
use crate::services::fs as fsx;
use crate::services::notes;

const DIR: &str = "attachments";

pub fn import(vault_root: &Path, source: &Path) -> Result<AttachmentImport, AppError> {
    if !source.is_file() {
        return Err(AppError::InvalidPath(format!(
            "not a file: {}",
            source.display()
        )));
    }

    let file_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .map(sanitize_file_name)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| AppError::InvalidPath("attachment has no file name".into()))?;
    let target = available_target(vault_root, &file_name)?;
    let bytes = std::fs::read(source)?;
    fsx::atomic_write(&target, &bytes)?;

    let rel_path = target
        .strip_prefix(vault_root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| target.to_string_lossy().replace('\\', "/"));
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(file_name.as_str())
        .to_string();
    let label = label_for(&file_name);
    let markdown = if is_image(&file_name) {
        format!("![{label}]({rel_path})")
    } else {
        format!("[{label}]({rel_path})")
    };

    Ok(AttachmentImport {
        rel_path,
        file_name,
        markdown,
    })
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
}
