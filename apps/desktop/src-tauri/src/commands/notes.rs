//! Notes IPC commands — see architecture.md §7.5.
//!
//! Each public command is a thin wrapper that resolves the active vault and
//! delegates to a `*_impl` taking the vault root explicitly so it can be
//! unit-tested against a tempdir.

use std::path::{Path, PathBuf};

use crate::domain::{AppError, NoteMeta};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::index::TagIndex;
use crate::services::notes;
use crate::services::vault_lock::VaultLocks;

// ── notes_list ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn notes_list(rel_dir: Option<String>) -> Result<Vec<NoteMeta>, AppError> {
    let vault_root = config::current_vault_root()?;
    notes_list_impl(&vault_root, rel_dir.as_deref())
}

fn notes_list_impl(vault_root: &Path, rel_dir: Option<&str>) -> Result<Vec<NoteMeta>, AppError> {
    let scan_root = match rel_dir {
        Some(rel) => {
            notes::check_rel_path(rel)?;
            vault_root.join(rel)
        }
        None => vault_root.join("notes"),
    };
    let files = notes::collect_md_files(&scan_root)?;
    let mut metas: Vec<NoteMeta> = files
        .iter()
        .filter_map(|p| notes::read_note_meta(vault_root, p).ok())
        .collect();
    metas.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(metas)
}

// ── notes_read ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn notes_read(rel_path: String) -> Result<String, AppError> {
    let vault_root = config::current_vault_root()?;
    notes_read_impl(&vault_root, &rel_path)
}

fn notes_read_impl(vault_root: &Path, rel_path: &str) -> Result<String, AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    std::fs::read_to_string(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(rel_path.to_string()),
        _ => AppError::Io(e.to_string()),
    })
}

// ── notes_write ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_write(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_path: String,
    content: String,
) -> Result<NoteMeta, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = notes_write_impl(&vault_root, &rel_path, &content);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_write_impl(
    vault_root: &Path,
    rel_path: &str,
    content: &str,
) -> Result<NoteMeta, AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    fsx::atomic_write(&abs, content.as_bytes())?;
    notes::read_note_meta(vault_root, &abs)
}

// ── notes_create ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_create(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_dir: String,
    title: String,
) -> Result<NoteMeta, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = notes_create_impl(&vault_root, &rel_dir, &title);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_create_impl(vault_root: &Path, rel_dir: &str, title: &str) -> Result<NoteMeta, AppError> {
    let dir = notes::resolve_in_vault(vault_root, rel_dir)?;
    fsx::ensure_dir(&dir)?;
    let stem = notes::slugify(title);
    let target = unique_path(&dir, &stem);
    let body = format!("---\ntitle: {}\n---\n\n", yaml_quote(title.trim()));
    fsx::atomic_write(&target, body.as_bytes())?;
    notes::read_note_meta(vault_root, &target)
}

fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.md"));
    let mut suffix: u32 = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{suffix}.md"));
        suffix += 1;
    }
    candidate
}

/// Quote a YAML scalar value safely. Wraps in double quotes and escapes
/// embedded backslashes / quotes.
fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', r"\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

// ── notes_delete ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_delete(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_path: String,
) -> Result<(), AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = notes_delete_impl(&vault_root, &rel_path);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_delete_impl(vault_root: &Path, rel_path: &str) -> Result<(), AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    std::fs::remove_file(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(rel_path.to_string()),
        _ => AppError::Io(e.to_string()),
    })
}

// ── notes_rename ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_rename(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    from: String,
    to: String,
) -> Result<NoteMeta, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = notes_rename_impl(&vault_root, &from, &to);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_rename_impl(vault_root: &Path, from: &str, to: &str) -> Result<NoteMeta, AppError> {
    let from_abs = notes::resolve_in_vault(vault_root, from)?;
    let to_abs = notes::resolve_in_vault(vault_root, to)?;
    if !from_abs.is_file() {
        return Err(AppError::NotFound(from.to_string()));
    }
    if to_abs.exists() {
        return Err(AppError::Conflict(format!("target already exists: {to}")));
    }
    if let Some(parent) = to_abs.parent() {
        fsx::ensure_dir(parent)?;
    }
    std::fs::rename(&from_abs, &to_abs)?;
    notes::read_note_meta(vault_root, &to_abs)
}

// ── notes_set_pinned ──────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_set_pinned(
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_path: String,
    pinned: bool,
) -> Result<NoteMeta, AppError> {
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let result = notes_set_pinned_impl(&vault_root, &rel_path, pinned);
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_set_pinned_impl(
    vault_root: &Path,
    rel_path: &str,
    pinned: bool,
) -> Result<NoteMeta, AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(rel_path.to_string()),
        _ => AppError::Io(e.to_string()),
    })?;
    let new_content = notes::set_pinned_in_content(&content, pinned);
    fsx::atomic_write(&abs, new_content.as_bytes())?;
    notes::read_note_meta(vault_root, &abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn vault() -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("notes/_inbox")).unwrap();
        dir
    }

    #[test]
    fn notes_list_returns_empty_for_empty_vault() {
        let v = vault();
        let list = notes_list_impl(v.path(), None).unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn notes_list_returns_recursive_files_sorted_by_rel_path() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/b.md"), b"# B").unwrap();
        fsx::atomic_write(&v.path().join("notes/a/inner.md"), b"# Inner").unwrap();
        fsx::atomic_write(&v.path().join("notes/a/sub/deep.md"), b"# Deep").unwrap();
        fsx::atomic_write(&v.path().join("notes/skip.txt"), b"x").unwrap();

        let list = notes_list_impl(v.path(), None).unwrap();
        let paths: Vec<_> = list.iter().map(|m| m.rel_path.clone()).collect();
        assert_eq!(
            paths,
            vec!["notes/a/inner.md", "notes/a/sub/deep.md", "notes/b.md"]
        );
    }

    #[test]
    fn notes_list_scopes_to_rel_dir() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/work/a.md"), b"").unwrap();
        fsx::atomic_write(&v.path().join("notes/personal/b.md"), b"").unwrap();
        let list = notes_list_impl(v.path(), Some("notes/work")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].rel_path, "notes/work/a.md");
    }

    #[test]
    fn notes_list_rejects_path_traversal() {
        let v = vault();
        let err = notes_list_impl(v.path(), Some("../escape")).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[test]
    fn notes_read_returns_contents() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"hello").unwrap();
        let got = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert_eq!(got, "hello");
    }

    #[test]
    fn notes_read_returns_not_found() {
        let v = vault();
        let err = notes_read_impl(v.path(), "notes/missing.md").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn notes_read_blocks_path_traversal() {
        let v = vault();
        let err = notes_read_impl(v.path(), "../etc/passwd").unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[test]
    fn notes_write_atomic_round_trip() {
        let v = vault();
        let meta = notes_write_impl(v.path(), "notes/x.md", "first version").unwrap();
        assert_eq!(meta.size, "first version".len() as u64);
        notes_write_impl(v.path(), "notes/x.md", "second version").unwrap();
        let read = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert_eq!(read, "second version");
    }

    #[test]
    fn notes_create_generates_slugified_filename_with_front_matter() {
        let v = vault();
        let meta = notes_create_impl(v.path(), "notes/work", "Hello World!").unwrap();
        assert_eq!(meta.rel_path, "notes/work/hello-world.md");
        let content = notes_read_impl(v.path(), &meta.rel_path).unwrap();
        assert!(content.starts_with("---\ntitle: \"Hello World!\"\n---\n"));
        assert_eq!(meta.title, "Hello World!");
    }

    #[test]
    fn notes_create_disambiguates_collisions() {
        let v = vault();
        let a = notes_create_impl(v.path(), "notes", "Same").unwrap();
        let b = notes_create_impl(v.path(), "notes", "Same").unwrap();
        assert_ne!(a.rel_path, b.rel_path);
        assert!(b.rel_path.ends_with("same-1.md"));
    }

    #[test]
    fn notes_create_handles_empty_title() {
        let v = vault();
        let meta = notes_create_impl(v.path(), "notes", "").unwrap();
        assert!(meta.rel_path.ends_with("untitled.md"));
    }

    #[test]
    fn notes_delete_removes_file() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"").unwrap();
        notes_delete_impl(v.path(), "notes/x.md").unwrap();
        assert!(!v.path().join("notes/x.md").exists());
    }

    #[test]
    fn notes_delete_returns_not_found() {
        let v = vault();
        let err = notes_delete_impl(v.path(), "notes/missing.md").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn notes_rename_moves_file_and_returns_meta() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/old.md"), b"# T").unwrap();
        let meta = notes_rename_impl(v.path(), "notes/old.md", "notes/sub/new.md").unwrap();
        assert_eq!(meta.rel_path, "notes/sub/new.md");
        assert!(!v.path().join("notes/old.md").exists());
        assert!(v.path().join("notes/sub/new.md").exists());
    }

    #[test]
    fn notes_rename_rejects_existing_target() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/a.md"), b"").unwrap();
        fsx::atomic_write(&v.path().join("notes/b.md"), b"").unwrap();
        let err = notes_rename_impl(v.path(), "notes/a.md", "notes/b.md").unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));
    }

    #[test]
    fn notes_rename_returns_not_found_for_missing_source() {
        let v = vault();
        let err = notes_rename_impl(v.path(), "notes/missing.md", "notes/new.md").unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn notes_set_pinned_toggles_front_matter() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"---\ntitle: T\n---\nbody").unwrap();
        let meta = notes_set_pinned_impl(v.path(), "notes/x.md", true).unwrap();
        assert!(meta.pinned);
        let content = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert!(content.contains("pinned: true"));

        let meta2 = notes_set_pinned_impl(v.path(), "notes/x.md", false).unwrap();
        assert!(!meta2.pinned);
        let content2 = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert!(content2.contains("pinned: false"));
    }

    #[test]
    fn notes_set_pinned_creates_front_matter_when_absent() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"plain body\n").unwrap();
        notes_set_pinned_impl(v.path(), "notes/x.md", true).unwrap();
        let content = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert!(content.starts_with("---\npinned: true\n---\n"));
    }
}
