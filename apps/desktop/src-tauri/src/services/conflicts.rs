//! Sync-conflict discovery and resolution.
//!
//! When `services::git::pull_ff_only` hits a merge conflict, it saves
//! the remote version next to the original as
//! `<stem>.conflict-<timestamp>.<ext>` and leaves HEAD untouched. This
//! module finds those pairs and provides the two trivial resolutions:
//!
//!   - **Keep ours** — delete the `.conflict-*` sidecar; the live file
//!     already reflects our edit.
//!   - **Keep theirs** — copy the sidecar's bytes over the live file,
//!     then delete the sidecar.
//!
//! Anything more nuanced (true 3-way merging, picking lines from both)
//! is left to the user — they open both files in the editor, edit by
//! hand, then call "keep ours" to drop the sidecar.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::AppError;
use crate::services::fs as fsx;
use crate::services::notes;

const CONFLICT_MARKER: &str = ".conflict-";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictPair {
    /// Vault-relative path of the live ("ours") file.
    pub rel_path: String,
    /// Vault-relative path of the sidecar holding the remote version.
    pub conflict_rel_path: String,
    /// Timestamp string lifted from the sidecar filename
    /// (e.g. `2026-05-09T10-00-00`). Opaque to the backend; the UI may
    /// re-parse it.
    pub timestamp: String,
}

/// Walk the vault and collect every conflict sidecar. Stable order
/// (sorted by conflict path) so the UI doesn't re-shuffle on refresh.
pub fn list(vault_root: &Path) -> Result<Vec<ConflictPair>, AppError> {
    let mut out = Vec::new();
    if !vault_root.is_dir() {
        return Ok(out);
    }
    walk(vault_root, vault_root, &mut out)?;
    out.sort_by(|a, b| a.conflict_rel_path.cmp(&b.conflict_rel_path));
    Ok(out)
}

fn walk(
    vault_root: &Path,
    dir: &Path,
    out: &mut Vec<ConflictPair>,
) -> Result<(), AppError> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        let name = match p.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with(".git") || name == ".naiteh" {
            continue;
        }
        if p.is_dir() {
            walk(vault_root, &p, out)?;
        } else if let Some(pair) = parse_conflict_pair(vault_root, &p) {
            out.push(pair);
        }
    }
    Ok(())
}

fn parse_conflict_pair(vault_root: &Path, abs: &Path) -> Option<ConflictPair> {
    let name = abs.file_name()?.to_str()?;
    let marker_pos = name.find(CONFLICT_MARKER)?;
    let stem = &name[..marker_pos];
    let rest = &name[marker_pos + CONFLICT_MARKER.len()..];

    // `rest` is either "<timestamp>.<ext>" or just "<timestamp>" when the
    // original file had no extension.
    let (timestamp, ext): (String, Option<String>) = match rest.rfind('.') {
        Some(dot) => (rest[..dot].to_string(), Some(rest[dot + 1..].to_string())),
        None => (rest.to_string(), None),
    };

    let parent = abs.parent()?;
    let original_name = match ext {
        Some(e) => format!("{stem}.{e}"),
        None => stem.to_string(),
    };
    let original_abs = parent.join(original_name);

    let conflict_rel = rel_from(vault_root, abs)?;
    let original_rel = rel_from(vault_root, &original_abs)?;
    Some(ConflictPair {
        rel_path: original_rel,
        conflict_rel_path: conflict_rel,
        timestamp,
    })
}

fn rel_from(vault_root: &Path, abs: &Path) -> Option<String> {
    abs.strip_prefix(vault_root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

/// Drop the conflict sidecar; the live file already holds the user's
/// preferred version.
pub fn resolve_keep_ours(
    vault_root: &Path,
    conflict_rel_path: &str,
) -> Result<(), AppError> {
    let path = guard_conflict(vault_root, conflict_rel_path)?;
    std::fs::remove_file(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::NotFound(conflict_rel_path.to_string())
        }
        _ => AppError::Io(e.to_string()),
    })
}

/// Replace the live file with the conflict sidecar's bytes, then drop
/// the sidecar.
pub fn resolve_keep_theirs(
    vault_root: &Path,
    conflict_rel_path: &str,
    rel_path: &str,
) -> Result<(), AppError> {
    let conflict_abs = guard_conflict(vault_root, conflict_rel_path)?;
    notes::check_rel_path(rel_path)?;
    let live_abs = vault_root.join(rel_path);

    let bytes = std::fs::read(&conflict_abs).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            AppError::NotFound(conflict_rel_path.to_string())
        }
        _ => AppError::Io(e.to_string()),
    })?;
    fsx::atomic_write(&live_abs, &bytes)?;
    // Best-effort cleanup; if the remove fails the live file is already
    // correct so we still return Ok.
    let _ = std::fs::remove_file(&conflict_abs);
    Ok(())
}

fn guard_conflict(vault_root: &Path, rel: &str) -> Result<PathBuf, AppError> {
    notes::check_rel_path(rel)?;
    if !rel.contains(CONFLICT_MARKER) {
        return Err(AppError::InvalidPath(format!(
            "not a conflict sidecar: {rel}"
        )));
    }
    Ok(vault_root.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn touch(dir: &Path, rel: &str, body: &[u8]) {
        let abs = dir.join(rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, body).unwrap();
    }

    #[test]
    fn list_finds_conflict_pairs_and_sorts_them() {
        let v = tempdir().unwrap();
        touch(v.path(), "notes/a.md", b"ours-a");
        touch(v.path(), "notes/a.conflict-2026-05-09T10-00-00.md", b"theirs-a");
        touch(
            v.path(),
            "notes/work/b.md",
            b"ours-b",
        );
        touch(
            v.path(),
            "notes/work/b.conflict-2026-05-10T11-22-33.md",
            b"theirs-b",
        );
        touch(v.path(), "notes/no-conflict.md", b"clean");

        let pairs = list(v.path()).unwrap();
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].rel_path, "notes/a.md");
        assert_eq!(
            pairs[0].conflict_rel_path,
            "notes/a.conflict-2026-05-09T10-00-00.md"
        );
        assert_eq!(pairs[0].timestamp, "2026-05-09T10-00-00");
        assert_eq!(pairs[1].rel_path, "notes/work/b.md");
    }

    #[test]
    fn list_skips_git_internal_directories() {
        let v = tempdir().unwrap();
        touch(v.path(), ".git/refs/heads/main", b"sha");
        touch(v.path(), ".git/notes/x.conflict-ts.md", b"junk");
        touch(v.path(), ".naiteh/sync-state.json", b"{}");
        let pairs = list(v.path()).unwrap();
        assert!(pairs.is_empty());
    }

    #[test]
    fn list_handles_extensionless_originals() {
        let v = tempdir().unwrap();
        touch(v.path(), "README", b"ours");
        touch(v.path(), "README.conflict-ts", b"theirs");
        let pairs = list(v.path()).unwrap();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].rel_path, "README");
        assert_eq!(pairs[0].conflict_rel_path, "README.conflict-ts");
    }

    #[test]
    fn keep_ours_deletes_only_the_sidecar() {
        let v = tempdir().unwrap();
        touch(v.path(), "notes/a.md", b"ours");
        touch(v.path(), "notes/a.conflict-ts.md", b"theirs");

        resolve_keep_ours(v.path(), "notes/a.conflict-ts.md").unwrap();
        assert!(v.path().join("notes/a.md").exists());
        assert!(!v.path().join("notes/a.conflict-ts.md").exists());
        assert_eq!(
            std::fs::read_to_string(v.path().join("notes/a.md")).unwrap(),
            "ours"
        );
    }

    #[test]
    fn keep_theirs_overwrites_live_and_drops_sidecar() {
        let v = tempdir().unwrap();
        touch(v.path(), "notes/a.md", b"ours");
        touch(v.path(), "notes/a.conflict-ts.md", b"theirs");

        resolve_keep_theirs(
            v.path(),
            "notes/a.conflict-ts.md",
            "notes/a.md",
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(v.path().join("notes/a.md")).unwrap(),
            "theirs"
        );
        assert!(!v.path().join("notes/a.conflict-ts.md").exists());
    }

    #[test]
    fn keep_ours_rejects_non_conflict_path() {
        let v = tempdir().unwrap();
        touch(v.path(), "notes/a.md", b"ours");
        let err = resolve_keep_ours(v.path(), "notes/a.md").unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[test]
    fn keep_ours_rejects_path_traversal() {
        let v = tempdir().unwrap();
        let err = resolve_keep_ours(v.path(), "../escape.conflict-ts.md").unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)));
    }

    #[test]
    fn keep_ours_returns_not_found_when_sidecar_missing() {
        let v = tempdir().unwrap();
        let err = resolve_keep_ours(v.path(), "notes/ghost.conflict-ts.md")
            .unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }
}
