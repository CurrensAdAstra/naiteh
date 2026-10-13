//! Notes IPC commands — see vault/wiki/ipc-api.md ("Notes").
//!
//! Each public command is a thin wrapper that resolves the active vault and
//! delegates to a `*_impl` taking the vault root explicitly so it can be
//! unit-tested against a tempdir.
//!
//! Every command is `async` and runs its filesystem work through
//! `fsx::run_blocking`: a synchronous Tauri command executes on the main
//! thread, so a vault walk there would freeze the UI.

use std::path::{Path, PathBuf};

use crate::domain::{AppError, NoteDocument, NoteMeta, NoteWriteResult};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::hooks;
use crate::services::index::TagIndex;
use crate::services::notes;
use crate::services::session::{require_session, ActiveSession};
use crate::services::vault_lock::VaultLocks;

/// Fire `on-note-save` for a note that was just written / created /
/// renamed / re-pinned. Fire-and-forget; never fails the command.
pub(crate) fn fire_note_saved(vault_root: &Path, rel_path: &str) {
    if let Ok(config_dir) = config::default_app_config_dir() {
        hooks::fire(
            &config_dir,
            hooks::HookEvent::NoteSave,
            vault_root,
            Some(rel_path),
        );
    }
}

// ── notes_list ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_list(
    active: tauri::State<'_, ActiveSession>,
    rel_dir: Option<String>,
) -> Result<Vec<NoteMeta>, AppError> {
    require_session(&active)?;
    fsx::run_blocking(move || {
        let vault_root = config::current_vault_root()?;
        notes_list_impl(&vault_root, rel_dir.as_deref())
    })
    .await
}

fn notes_list_impl(vault_root: &Path, rel_dir: Option<&str>) -> Result<Vec<NoteMeta>, AppError> {
    let scan_root = match rel_dir {
        Some(rel) => notes::resolve_in_vault(vault_root, rel)?,
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

/// Content plus the **version** (hex SHA-256 of the bytes read) the
/// frontend passes back to `notes_write` as `expected_version`.
#[tauri::command]
pub async fn notes_read(
    active: tauri::State<'_, ActiveSession>,
    rel_path: String,
) -> Result<NoteDocument, AppError> {
    require_session(&active)?;
    fsx::run_blocking(move || {
        let vault_root = config::current_vault_root()?;
        notes_read_impl(&vault_root, &rel_path)
    })
    .await
}

fn notes_read_impl(vault_root: &Path, rel_path: &str) -> Result<NoteDocument, AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    let (content, version) = notes::read_document(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(rel_path.to_string()),
        _ => AppError::Io(e.to_string()),
    })?;
    Ok(NoteDocument { content, version })
}

// ── notes_version ─────────────────────────────────────────────────────────

/// Current on-disk version of a note — a cheap freshness check (e.g. on
/// window focus) without transferring the content. `NotFound` if the
/// file is missing. Read-only: no vault lock.
#[tauri::command]
pub async fn notes_version(
    active: tauri::State<'_, ActiveSession>,
    rel_path: String,
) -> Result<String, AppError> {
    require_session(&active)?;
    fsx::run_blocking(move || {
        let vault_root = config::current_vault_root()?;
        notes_version_impl(&vault_root, &rel_path)
    })
    .await
}

fn notes_version_impl(vault_root: &Path, rel_path: &str) -> Result<String, AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    notes::current_version(&abs)?.ok_or_else(|| AppError::NotFound(rel_path.to_string()))
}

// ── notes_write ───────────────────────────────────────────────────────────

/// Conflict-safe save. With `expected_version` set, the write happens
/// only if the file on disk still has that version; otherwise nothing is
/// written and `StaleWrite(<current version>)` is returned (`""` when the
/// file was deleted underneath). `None` writes unconditionally. The
/// check and the write run under the per-vault lock.
#[tauri::command]
pub async fn notes_write(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_path: String,
    content: String,
    expected_version: Option<String>,
) -> Result<NoteWriteResult, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || {
        notes_write_impl(&root, &rel_path, &content, expected_version.as_deref())
    })
    .await;
    if let Ok(written) = &result {
        index.invalidate(&vault_root);
        fire_note_saved(&vault_root, &written.meta.rel_path);
    }
    result
}

fn notes_write_impl(
    vault_root: &Path,
    rel_path: &str,
    content: &str,
    expected_version: Option<&str>,
) -> Result<NoteWriteResult, AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    let version = notes::write_versioned(&abs, content, expected_version)?;
    let meta = notes::read_note_meta(vault_root, &abs)?;
    Ok(NoteWriteResult { meta, version })
}

// ── notes_create ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_create(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_dir: String,
    title: String,
) -> Result<NoteMeta, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || notes_create_impl(&root, &rel_dir, &title)).await;
    if let Ok(meta) = &result {
        index.invalidate(&vault_root);
        fire_note_saved(&vault_root, &meta.rel_path);
    }
    result
}

fn notes_create_impl(vault_root: &Path, rel_dir: &str, title: &str) -> Result<NoteMeta, AppError> {
    let dir = notes::resolve_in_vault(vault_root, rel_dir)?;
    fsx::ensure_dir(&dir)?;
    let stem = notes::slugify(title);
    let target = unique_path(&dir, &stem);
    let body = format!("---\ntitle: {}\n---\n\n", notes::yaml_quote(title.trim()));
    fsx::atomic_write(&target, body.as_bytes())?;
    notes::read_note_meta(vault_root, &target)
}

pub(crate) fn unique_path(dir: &Path, stem: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.md"));
    let mut suffix: u32 = 1;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{suffix}.md"));
        suffix += 1;
    }
    candidate
}

// ── notes_delete ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_delete(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_path: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || notes_delete_impl(&root, &rel_path)).await;
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_delete_impl(vault_root: &Path, rel_path: &str) -> Result<(), AppError> {
    let abs = notes::resolve_in_vault(vault_root, rel_path)?;
    fsx::remove_file(&abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AppError::NotFound(rel_path.to_string()),
        _ => AppError::Io(e.to_string()),
    })
}

// ── notes_rename ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn notes_rename(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    from: String,
    to: String,
) -> Result<NoteMeta, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || notes_rename_impl(&root, &from, &to)).await;
    if let Ok(meta) = &result {
        index.invalidate(&vault_root);
        fire_note_saved(&vault_root, &meta.rel_path);
    }
    result
}

fn notes_rename_impl(vault_root: &Path, from: &str, to: &str) -> Result<NoteMeta, AppError> {
    let from_abs = notes::resolve_in_vault(vault_root, from)?;
    let to_abs = notes::resolve_in_vault(vault_root, to)?;
    if !from_abs.is_file() {
        return Err(AppError::NotFound(from.to_string()));
    }
    // On a case-insensitive filesystem `Note.md` → `note.md` makes
    // `to_abs.exists()` report the source itself; that's a legitimate
    // case-only rename, not a collision.
    if to_abs.exists() && !fsx::is_case_only_alias(&from_abs, &to_abs) {
        return Err(AppError::Conflict(format!("target already exists: {to}")));
    }
    if let Some(parent) = to_abs.parent() {
        fsx::ensure_dir(parent)?;
    }
    fsx::rename_entry(&from_abs, &to_abs)?;
    notes::read_note_meta(vault_root, &to_abs)
}

// ── folders (directory management under notes/) ───────────────────────────

const NOTES_DIR: &str = "notes";
const INBOX_NAME: &str = "_inbox";

/// List every folder under `notes/` (vault-relative, forward slashes),
/// including empty ones — the note tree alone can't surface a folder
/// with no files in it.
#[tauri::command]
pub async fn notes_list_dirs(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<String>, AppError> {
    require_session(&active)?;
    fsx::run_blocking(|| {
        let vault_root = config::current_vault_root()?;
        notes_list_dirs_impl(&vault_root)
    })
    .await
}

fn notes_list_dirs_impl(vault_root: &Path) -> Result<Vec<String>, AppError> {
    let root = vault_root.join("notes");
    let mut out = Vec::new();
    if root.is_dir() {
        collect_dirs(vault_root, &root, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn collect_dirs(vault_root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), AppError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        // `file_type` doesn't follow symlinks, so a synced
        // `notes/loop -> ..` can't send us into infinite recursion.
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') {
            continue;
        }
        if let Ok(rel) = p.strip_prefix(vault_root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
        collect_dirs(vault_root, &p, out)?;
    }
    Ok(())
}

/// A folder argument for the folder-management commands, resolved and
/// vetted.
struct NotesSubdir {
    /// Lexically joined absolute path (what we operate on).
    abs: PathBuf,
    /// Canonical form (deepest existing ancestor canonicalized), used
    /// for containment / identity comparisons.
    canon: PathBuf,
    /// True if this names the reserved `notes/_inbox`, by spelling
    /// (case-insensitive) or by filesystem identity.
    reserved: bool,
}

/// Resolve a managed folder. It must normalize cleanly (no `.`, `..`,
/// empty segments, backslashes or drive prefixes — see
/// `notes::normalize_rel_path`) and live strictly under `notes/`, both
/// lexically and after canonicalization — never `notes/` itself, never
/// another top-level dir, never reached via a symlink pointing out of
/// `notes/`.
fn resolve_notes_subdir(vault_root: &Path, rel: &str) -> Result<NotesSubdir, AppError> {
    let not_under = || AppError::InvalidPath(format!("folder must be under notes/: {rel}"));
    let normalized = notes::normalize_rel_path(rel)?;
    let parts: Vec<&str> = normalized.split('/').collect();
    if parts.len() < 2 || !parts[0].eq_ignore_ascii_case(NOTES_DIR) {
        return Err(not_under());
    }
    let abs = notes::resolve_in_vault(vault_root, &normalized)?;
    let notes_root = vault_root.join(NOTES_DIR);
    let canon_notes = notes::canonicalize_lenient(&notes_root).ok_or_else(not_under)?;
    let canon = notes::canonicalize_lenient(&abs).ok_or_else(not_under)?;
    if canon == canon_notes || !canon.starts_with(&canon_notes) {
        return Err(not_under());
    }
    let lexically_inbox = parts.len() == 2
        && parts[1]
            .trim_end_matches(['.', ' '])
            .eq_ignore_ascii_case(INBOX_NAME);
    let same_as_inbox = notes::canonicalize_lenient(&notes_root.join(INBOX_NAME))
        .is_some_and(|inbox| inbox == canon);
    Ok(NotesSubdir {
        abs,
        canon,
        reserved: lexically_inbox || same_as_inbox,
    })
}

fn reserved_err() -> AppError {
    AppError::Conflict("the _inbox folder is reserved and can't be moved or deleted".into())
}

#[tauri::command]
pub async fn notes_create_dir(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    rel_dir: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    fsx::run_blocking(move || notes_create_dir_impl(&vault_root, &rel_dir)).await
}

fn notes_create_dir_impl(vault_root: &Path, rel_dir: &str) -> Result<(), AppError> {
    let dir = resolve_notes_subdir(vault_root, rel_dir)?;
    if dir.abs.exists() {
        return Err(AppError::Conflict(format!(
            "folder already exists: {rel_dir}"
        )));
    }
    fsx::ensure_dir(&dir.abs)
}

#[tauri::command]
pub async fn notes_delete_dir(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    rel_dir: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || notes_delete_dir_impl(&root, &rel_dir)).await;
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_delete_dir_impl(vault_root: &Path, rel_dir: &str) -> Result<(), AppError> {
    let dir = resolve_notes_subdir(vault_root, rel_dir)?;
    if dir.reserved {
        return Err(reserved_err());
    }
    if !dir.abs.is_dir() {
        return Err(AppError::NotFound(rel_dir.to_string()));
    }
    // remove_dir_all removes a symlink itself, never its target.
    fsx::remove_dir_all(&dir.abs).map_err(|e| AppError::Io(e.to_string()))
}

#[tauri::command]
pub async fn notes_rename_dir(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    from: String,
    to: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || notes_rename_dir_impl(&root, &from, &to)).await;
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}

fn notes_rename_dir_impl(vault_root: &Path, from: &str, to: &str) -> Result<(), AppError> {
    let src = resolve_notes_subdir(vault_root, from)?;
    let dst = resolve_notes_subdir(vault_root, to)?;
    if src.reserved || dst.reserved {
        return Err(reserved_err());
    }
    if !src.abs.is_dir() {
        return Err(AppError::NotFound(from.to_string()));
    }
    let case_only = fsx::is_case_only_alias(&src.abs, &dst.abs);
    if dst.abs.exists() && !case_only {
        return Err(AppError::Conflict(format!("target already exists: {to}")));
    }
    if !case_only && dst.canon.starts_with(&src.canon) {
        return Err(AppError::InvalidPath(format!(
            "cannot move a folder into itself: {from} -> {to}"
        )));
    }
    if let Some(parent) = dst.abs.parent() {
        fsx::ensure_dir(parent)?;
    }
    fsx::rename_entry(&src.abs, &dst.abs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A write that bypasses `services::fs` on purpose: it stands in for
    /// another program (Google Drive, an editor) changing the file, so it
    /// must be neither atomic nor tagged as naiteh's own change.
    fn write_externally(path: &Path, bytes: &[u8]) {
        use std::io::Write as _;
        std::fs::File::create(path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }

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

    // ── folder management ─────────────────────────────────────────────

    #[test]
    fn list_dirs_includes_empty_folders_recursively() {
        let v = vault();
        std::fs::create_dir_all(v.path().join("notes/work/q1")).unwrap();
        std::fs::create_dir_all(v.path().join("notes/personal")).unwrap();
        let dirs = notes_list_dirs_impl(v.path()).unwrap();
        assert!(dirs.contains(&"notes/_inbox".to_string()));
        assert!(dirs.contains(&"notes/work".to_string()));
        assert!(dirs.contains(&"notes/work/q1".to_string()));
        assert!(dirs.contains(&"notes/personal".to_string()));
    }

    #[test]
    fn create_dir_makes_the_folder() {
        let v = vault();
        notes_create_dir_impl(v.path(), "notes/projects").unwrap();
        assert!(v.path().join("notes/projects").is_dir());
    }

    #[test]
    fn create_dir_rejects_existing_and_out_of_scope() {
        let v = vault();
        notes_create_dir_impl(v.path(), "notes/x").unwrap();
        assert!(matches!(
            notes_create_dir_impl(v.path(), "notes/x"),
            Err(AppError::Conflict(_))
        ));
        // Can't create a folder at the notes root or outside notes/.
        assert!(matches!(
            notes_create_dir_impl(v.path(), "notes"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_create_dir_impl(v.path(), "journal/2026"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[test]
    fn delete_dir_removes_folder_and_contents() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/work/a.md"), b"# A").unwrap();
        notes_delete_dir_impl(v.path(), "notes/work").unwrap();
        assert!(!v.path().join("notes/work").exists());
    }

    #[test]
    fn delete_dir_refuses_reserved_inbox() {
        let v = vault();
        assert!(matches!(
            notes_delete_dir_impl(v.path(), "notes/_inbox"),
            Err(AppError::Conflict(_))
        ));
        assert!(v.path().join("notes/_inbox").is_dir());
    }

    #[test]
    fn rename_dir_moves_folder_with_contents() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/work/a.md"), b"# A").unwrap();
        notes_rename_dir_impl(v.path(), "notes/work", "notes/office").unwrap();
        assert!(!v.path().join("notes/work").exists());
        assert!(v.path().join("notes/office/a.md").is_file());
    }

    #[test]
    fn rename_dir_rejects_existing_target() {
        let v = vault();
        std::fs::create_dir_all(v.path().join("notes/a")).unwrap();
        std::fs::create_dir_all(v.path().join("notes/b")).unwrap();
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes/a", "notes/b"),
            Err(AppError::Conflict(_))
        ));
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
        assert_eq!(got.content, "hello");
        assert_eq!(got.version, notes::file_version(b"hello"));
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
        let written = notes_write_impl(v.path(), "notes/x.md", "first version", None).unwrap();
        assert_eq!(written.meta.size, "first version".len() as u64);
        notes_write_impl(v.path(), "notes/x.md", "second version", None).unwrap();
        let read = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert_eq!(read.content, "second version");
    }

    // ── versions / stale writes ────────────────────────────────────────

    #[test]
    fn notes_read_version_matches_notes_write_and_notes_version() {
        let v = vault();
        let written = notes_write_impl(v.path(), "notes/x.md", "body", None).unwrap();
        let read = notes_read_impl(v.path(), "notes/x.md").unwrap();
        assert_eq!(read.version, written.version);
        assert_eq!(read.version.len(), 64);
        assert!(read
            .version
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(
            notes_version_impl(v.path(), "notes/x.md").unwrap(),
            written.version
        );
        // Stable across reads; changes with the bytes.
        assert_eq!(
            notes_read_impl(v.path(), "notes/x.md").unwrap().version,
            read.version
        );
        write_externally(&v.path().join("notes/x.md"), b"edited elsewhere");
        assert_ne!(
            notes_version_impl(v.path(), "notes/x.md").unwrap(),
            read.version
        );
    }

    #[test]
    fn notes_version_not_found_and_traversal() {
        let v = vault();
        assert!(matches!(
            notes_version_impl(v.path(), "notes/missing.md"),
            Err(AppError::NotFound(_))
        ));
        assert!(matches!(
            notes_version_impl(v.path(), "../x.md"),
            Err(AppError::InvalidPath(_))
        ));
    }

    #[test]
    fn notes_write_with_matching_version_succeeds_and_returns_new_version() {
        let v = vault();
        let first = notes_write_impl(v.path(), "notes/x.md", "v1", None).unwrap();
        let second = notes_write_impl(v.path(), "notes/x.md", "v2", Some(&first.version)).unwrap();
        assert_ne!(second.version, first.version);
        assert_eq!(
            notes_read_impl(v.path(), "notes/x.md").unwrap().content,
            "v2"
        );
        assert_eq!(second.version, notes::file_version(b"v2"));
    }

    #[test]
    fn notes_write_with_stale_version_refuses_and_reports_current() {
        let v = vault();
        let first = notes_write_impl(v.path(), "notes/x.md", "v1", None).unwrap();
        // Simulate Google Drive dropping a newer copy on disk.
        write_externally(&v.path().join("notes/x.md"), b"from the other pc");
        let current = notes_version_impl(v.path(), "notes/x.md").unwrap();
        let err = notes_write_impl(v.path(), "notes/x.md", "my autosave", Some(&first.version))
            .unwrap_err();
        match err {
            AppError::StaleWrite(reported) => assert_eq!(reported, current),
            other => panic!("expected StaleWrite, got {other:?}"),
        }
        // Nothing was written.
        assert_eq!(
            notes_read_impl(v.path(), "notes/x.md").unwrap().content,
            "from the other pc"
        );
    }

    #[test]
    fn notes_write_with_version_on_deleted_file_is_stale_with_empty_message() {
        let v = vault();
        let first = notes_write_impl(v.path(), "notes/x.md", "v1", None).unwrap();
        std::fs::remove_file(v.path().join("notes/x.md")).unwrap();
        let err = notes_write_impl(v.path(), "notes/x.md", "v2", Some(&first.version)).unwrap_err();
        assert!(
            matches!(&err, AppError::StaleWrite(m) if m.is_empty()),
            "{err:?}"
        );
        assert!(!v.path().join("notes/x.md").exists());
        // Without an expected version the file is simply (re)created.
        notes_write_impl(v.path(), "notes/x.md", "v2", None).unwrap();
        assert!(v.path().join("notes/x.md").exists());
    }

    #[test]
    fn notes_create_generates_slugified_filename_with_front_matter() {
        let v = vault();
        let meta = notes_create_impl(v.path(), "notes/work", "Hello World!").unwrap();
        assert_eq!(meta.rel_path, "notes/work/hello-world.md");
        let content = notes_read_impl(v.path(), &meta.rel_path).unwrap().content;
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

    // ── regression: folder deletion can't escape to notes/ or _inbox ──

    fn seeded_vault() -> tempfile::TempDir {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/_inbox/q.md"), b"quick").unwrap();
        fsx::atomic_write(&v.path().join("notes/work/a.md"), b"# A").unwrap();
        v
    }

    #[test]
    fn delete_dir_rejects_notes_root_spellings() {
        let v = seeded_vault();
        for bad in [
            "notes/.",
            "notes/./",
            "notes//",
            "notes/",
            "notes",
            "./notes",
            "notes/work/..",
            "NOTES/.",
        ] {
            let err = notes_delete_dir_impl(v.path(), bad).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidPath(_)),
                "{bad:?} gave {err:?}"
            );
        }
        assert!(v.path().join("notes/_inbox/q.md").is_file());
        assert!(v.path().join("notes/work/a.md").is_file());
    }

    #[test]
    fn delete_dir_rejects_inbox_bypass_spellings() {
        let v = seeded_vault();
        for bad in [
            "notes/_inbox",
            "notes/_inbox/",
            "notes/_inbox/.",
            "notes//_inbox",
            "notes/./_inbox",
            "notes/_INBOX",
            "notes/_Inbox/",
            "notes\\_inbox",
        ] {
            let err = notes_delete_dir_impl(v.path(), bad).unwrap_err();
            assert!(
                matches!(err, AppError::Conflict(_) | AppError::InvalidPath(_)),
                "{bad:?} gave {err:?}"
            );
        }
        assert!(v.path().join("notes/_inbox/q.md").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn delete_dir_rejects_win32_aliases_of_inbox() {
        let v = seeded_vault();
        for bad in [
            "notes/_inbox.",
            "notes/_inbox ",
            "notes/_inbox::$INDEX_ALLOCATION",
        ] {
            assert!(notes_delete_dir_impl(v.path(), bad).is_err(), "{bad:?}");
        }
        assert!(v.path().join("notes/_inbox/q.md").is_file());
    }

    #[test]
    fn rename_and_create_dir_use_the_same_normalization() {
        let v = seeded_vault();
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes/.", "notes/moved"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes/_INBOX", "notes/moved"),
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes//work", "notes/moved"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes/work", "notes/./moved"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_create_dir_impl(v.path(), "notes/./x"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_create_dir_impl(v.path(), "notes/x/../y"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_rename_impl(v.path(), "notes/work/./a.md", "notes/b.md"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(v.path().join("notes/work/a.md").is_file());
    }

    #[test]
    fn rename_dir_refuses_moving_into_itself_or_onto_inbox() {
        let v = seeded_vault();
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes/work", "notes/work/sub"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            notes_rename_dir_impl(v.path(), "notes/work", "notes/_inbox"),
            Err(AppError::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn delete_dir_refuses_symlink_to_notes_root() {
        use std::os::unix::fs::symlink;
        let v = seeded_vault();
        symlink(v.path().join("notes"), v.path().join("notes/alias")).unwrap();
        assert!(matches!(
            notes_delete_dir_impl(v.path(), "notes/alias"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(v.path().join("notes/_inbox/q.md").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn delete_dir_refuses_junction_to_notes_root() {
        let v = seeded_vault();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(v.path().join("notes").join("alias"))
            .arg(v.path().join("notes"))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(matches!(
            notes_delete_dir_impl(v.path(), "notes/alias"),
            Err(AppError::InvalidPath(_))
        ));
        assert!(v.path().join("notes/_inbox/q.md").is_file());
        // Clean up the junction itself so tempdir teardown is trivial.
        std::fs::remove_dir(v.path().join("notes").join("alias")).unwrap();
    }

    // ── case-only renames ──────────────────────────────────────────────

    #[test]
    fn notes_rename_case_only_succeeds() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/Note.md"), b"# T").unwrap();
        let meta = notes_rename_impl(v.path(), "notes/Note.md", "notes/note.md").unwrap();
        assert_eq!(meta.rel_path, "notes/note.md");
        let names: Vec<String> = std::fs::read_dir(v.path().join("notes"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".md"))
            .collect();
        assert_eq!(names, vec!["note.md".to_string()]);
    }

    #[test]
    fn rename_dir_case_only_succeeds() {
        let v = vault();
        fsx::atomic_write(&v.path().join("notes/Work/a.md"), b"# A").unwrap();
        notes_rename_dir_impl(v.path(), "notes/Work", "notes/work").unwrap();
        let dirs = notes_list_dirs_impl(v.path()).unwrap();
        assert!(dirs.contains(&"notes/work".to_string()), "{dirs:?}");
        assert!(!dirs.contains(&"notes/Work".to_string()), "{dirs:?}");
        assert!(v.path().join("notes/work/a.md").is_file());
    }

    #[test]
    fn notes_create_avoids_reserved_and_overlong_names() {
        let v = vault();
        let meta = notes_create_impl(v.path(), "notes", "CON").unwrap();
        assert_eq!(meta.rel_path, "notes/con-note.md");
        let long = "word ".repeat(100);
        let meta = notes_create_impl(v.path(), "notes", &long).unwrap();
        let stem = meta
            .rel_path
            .trim_start_matches("notes/")
            .trim_end_matches(".md");
        assert!(stem.chars().count() <= notes::MAX_SLUG_CHARS);
        assert!(!stem.ends_with('-'));
    }

    // ── front-matter quoting round trip ────────────────────────────────

    #[test]
    fn notes_create_title_round_trips_through_front_matter() {
        let v = vault();
        for title in [
            r#"Say "hi" \ bye"#,
            "two\nlines\npinned: true",
            "tab\tand \\n literal",
        ] {
            let meta = notes_create_impl(v.path(), "notes", title).unwrap();
            assert_eq!(meta.title, title.trim(), "title {title:?}");
            assert!(!meta.pinned, "title {title:?} injected front matter");
            let content = notes_read_impl(v.path(), &meta.rel_path).unwrap().content;
            // Front matter is exactly one title line.
            assert_eq!(content.matches('\n').count(), 4, "{content:?}");
        }
    }
}
