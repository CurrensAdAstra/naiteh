//! Shared filename / MIME helpers for attachment-style imports.
//!
//! `services::attachments` (file picker + clipboard paste) and
//! `services::evernote::import` (ENEX resources) both need to sanitize
//! a filename, map a MIME type to an extension, recognise images, and
//! derive a human label. These used to be duplicated (and had already
//! drifted — the Evernote copy knew audio/video MIME types the
//! attachment copy didn't). This module is the single source.

use std::path::Path;

use crate::services::notes;

/// Slugify the stem and lowercase-alnum the extension, producing a
/// filesystem-safe name. Empty / all-punctuation input becomes
/// `"attachment"` (optionally with the extension).
pub fn sanitize_file_name(input: &str) -> String {
    let p = Path::new(input);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .map(notes::slugify)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "attachment".to_string());
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

/// Map a MIME type to a file extension. Superset of what either caller
/// needs so naming stays consistent across import paths.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
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

/// True if the filename has a known image extension.
pub fn is_image_filename(file_name: &str) -> bool {
    matches!(
        Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("avif" | "bmp" | "gif" | "jpeg" | "jpg" | "png" | "svg" | "webp")
    )
}

/// True if the MIME type is any `image/*`.
pub fn is_image_mime(mime: &str) -> bool {
    mime.to_ascii_lowercase().starts_with("image/")
}

/// Human-friendly label for a markdown link: filename stem with
/// hyphens turned back into spaces.
pub fn label_for(file_name: &str) -> String {
    Path::new(file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name)
        .replace('-', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_slugifies_stem_and_cleans_extension() {
        assert_eq!(sanitize_file_name("Screen Shot.PNG"), "screen-shot.png");
        assert_eq!(
            sanitize_file_name("Quarterly Plan.pdf"),
            "quarterly-plan.pdf"
        );
    }

    #[test]
    fn sanitize_handles_punctuation_and_empty_input() {
        // slugify maps an all-punctuation stem to "untitled".
        assert_eq!(sanitize_file_name("???.png"), "untitled.png");
        // No stem at all → the "attachment" fallback.
        assert_eq!(sanitize_file_name(""), "attachment");
    }

    #[test]
    fn extension_for_mime_covers_images_and_common_docs() {
        assert_eq!(extension_for_mime("image/png"), Some("png"));
        assert_eq!(extension_for_mime("audio/mpeg"), Some("mp3"));
        assert_eq!(extension_for_mime("application/x-weird"), None);
    }

    #[test]
    fn image_detection_by_filename_and_mime() {
        assert!(is_image_filename("a.PNG"));
        assert!(!is_image_filename("a.pdf"));
        assert!(is_image_mime("image/webp"));
        assert!(!is_image_mime("application/pdf"));
    }

    #[test]
    fn label_replaces_hyphens_with_spaces() {
        assert_eq!(label_for("quarterly-plan.pdf"), "quarterly plan");
    }
}
