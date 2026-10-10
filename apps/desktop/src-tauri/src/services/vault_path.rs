//! Vault-root validation for `vault_init` / `vault_set_active` /
//! `vault_create_default` — see vault/wiki/vault-and-data.md ("Where a
//! vault may live").
//!
//! Every per-file check (`notes::resolve_in_vault`) only proves a path
//! stays *inside the vault root*; that protects nothing if the root
//! itself is the user's home, `C:\`, or `%APPDATA%` (a note write could
//! then land in a Startup folder or `~/.ssh`). So the root is validated
//! once, when it is chosen:
//!
//!   - absolute, canonicalized (symlinks / `..` / 8.3 names resolved),
//!     and a directory;
//!   - not a filesystem root and not the home directory itself;
//!   - not inside — and not an ancestor of — a protected location:
//!     OS / program dirs, `%APPDATA%` / `%LOCALAPPDATA%` / ProgramData,
//!     the OS config + data dirs (which contain naiteh's own app-config
//!     dir), `~/.ssh`, `~/.config`, `~/.gnupg`, `/etc`, `/usr`, `/bin`,
//!     `/System`, `/Library`, … ("ancestor of" catches `C:\Users`,
//!     `~/Library`, `C:\Users\me\AppData`).

use std::path::{Component, Path, PathBuf};

use crate::domain::AppError;

const NAITEH_DIR: &str = ".naiteh";

/// The set of locations a vault root may not be, be inside of, or
/// contain. Built from the running OS by [`VaultPathPolicy::system`];
/// tests construct their own.
#[derive(Debug, Clone, Default)]
pub struct VaultPathPolicy {
    /// Refused exactly (the home directory).
    exact: Vec<PathBuf>,
    /// Refused together with their whole subtree and all ancestors.
    trees: Vec<PathBuf>,
}

impl VaultPathPolicy {
    /// A policy with explicit lists (paths are canonicalized when they
    /// exist so comparisons match canonicalized candidates).
    pub fn new(exact: Vec<PathBuf>, trees: Vec<PathBuf>) -> Self {
        Self {
            exact: exact.iter().map(|p| canonical_or_self(p)).collect(),
            trees: trees.iter().map(|p| canonical_or_self(p)).collect(),
        }
    }

    /// The policy for this machine.
    pub fn system() -> Self {
        let mut exact = Vec::new();
        let mut trees: Vec<PathBuf> = Vec::new();
        let home = dirs::home_dir();
        if let Some(h) = &home {
            exact.push(h.clone());
            for sub in [".ssh", ".config", ".gnupg"] {
                trees.push(h.join(sub));
            }
        }
        // OS config / data dirs: %APPDATA% + %LOCALAPPDATA% on Windows,
        // ~/Library/Application Support on macOS, ~/.config +
        // ~/.local/share on Linux. naiteh's own app-config dir lives in
        // the first of these.
        for d in [dirs::config_dir(), dirs::data_dir(), dirs::data_local_dir()]
            .into_iter()
            .flatten()
        {
            trees.push(d);
        }
        if cfg!(windows) {
            for var in [
                "SystemRoot",
                "windir",
                "ProgramFiles",
                "ProgramFiles(x86)",
                "ProgramW6432",
                "ProgramData",
                "APPDATA",
                "LOCALAPPDATA",
            ] {
                if let Some(v) = std::env::var_os(var).filter(|v| !v.is_empty()) {
                    trees.push(PathBuf::from(v));
                }
            }
        } else {
            for p in [
                "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/dev", "/proc",
                "/sys", "/System", "/Library",
            ] {
                trees.push(PathBuf::from(p));
            }
            if let Some(h) = &home {
                trees.push(h.join("Library"));
            }
        }
        Self::new(exact, trees)
    }

    /// Refuse `candidate` (already canonical) if it is a filesystem
    /// root, an exact-denied path, or overlaps a denied tree.
    fn check(&self, candidate: &Path) -> Result<(), AppError> {
        let refuse = |why: &str| {
            Err(AppError::InvalidPath(format!(
                "{} cannot be used as a vault: {why}",
                candidate.display()
            )))
        };
        if candidate.parent().is_none() {
            return refuse("it is a filesystem root");
        }
        let key = path_key(candidate);
        if self.exact.iter().any(|p| path_key(p) == key) {
            return refuse("it is your home folder — pick or create a subfolder");
        }
        for tree in &self.trees {
            let tree_key = path_key(tree);
            if key.starts_with(&tree_key) {
                return refuse("it is inside a system or application-data folder");
            }
            if tree_key.starts_with(&key) {
                return refuse("it contains a system or application-data folder");
            }
        }
        Ok(())
    }
}

/// Comparison key: the path's components, case-folded on Windows (whose
/// file system is case-insensitive).
fn path_key(p: &Path) -> Vec<String> {
    p.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| {
            let s = c.as_os_str().to_string_lossy().to_string();
            if cfg!(windows) {
                s.to_lowercase()
            } else {
                s
            }
        })
        .collect()
}

fn canonical_or_self(p: &Path) -> PathBuf {
    p.canonicalize()
        .map(|c| simplify(&c))
        .unwrap_or_else(|_| p.to_path_buf())
}

/// Strip Windows' verbatim prefix from a canonicalized path
/// (`\\?\C:\x` → `C:\x`, `\\?\UNC\srv\share` → `\\srv\share`) so the
/// stored vault path stays human-readable. A no-op elsewhere.
pub fn simplify(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

fn require_absolute(raw: &str) -> Result<&Path, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidPath("vault path is empty".into()));
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(format!(
            "vault path must be absolute: {trimmed}"
        )));
    }
    Ok(path)
}

/// Validate an existing directory as a vault root. Returns its
/// canonical (simplified) path.
pub fn validate_existing_root(raw: &str, policy: &VaultPathPolicy) -> Result<PathBuf, AppError> {
    let path = require_absolute(raw)?;
    let canonical = path
        .canonicalize()
        .map(|c| simplify(&c))
        .map_err(|_| AppError::InvalidPath(format!("not a directory: {}", path.display())))?;
    if !canonical.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "not a directory: {}",
            canonical.display()
        )));
    }
    policy.check(&canonical)?;
    Ok(canonical)
}

/// Validate a vault root for `vault_init`: an existing directory, or a
/// not-yet-existing folder whose parent directory exists (the caller
/// creates it). Returns the canonical (simplified) target path.
pub fn validate_new_root(raw: &str, policy: &VaultPathPolicy) -> Result<PathBuf, AppError> {
    let path = require_absolute(raw)?;
    if path.exists() {
        return validate_existing_root(raw, policy);
    }
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(AppError::InvalidPath(format!(
            "not a directory: {}",
            path.display()
        )));
    };
    let parent = parent
        .canonicalize()
        .map(|c| simplify(&c))
        .ok()
        .filter(|p| p.is_dir())
        .ok_or_else(|| {
            AppError::InvalidPath(format!(
                "parent folder does not exist: {}",
                parent.display()
            ))
        })?;
    let target = parent.join(name);
    policy.check(&target)?;
    Ok(target)
}

/// Whether `root` already looks like a naiteh vault: it has `.naiteh/`,
/// or the standard `notes/` + `journal/` layout.
pub fn is_naiteh_vault(root: &Path) -> bool {
    root.join(NAITEH_DIR).is_dir() || (root.join("notes").is_dir() && root.join("journal").is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// A sandbox policy: `home` exact-denied, `home/AppData` and
    /// `home/.ssh` tree-denied.
    fn sandbox() -> (tempfile::TempDir, VaultPathPolicy) {
        let base = tempdir().unwrap();
        let home = base.path().join("home");
        std::fs::create_dir_all(home.join("AppData").join("Roaming")).unwrap();
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::create_dir_all(home.join("Documents")).unwrap();
        let policy = VaultPathPolicy::new(
            vec![home.clone()],
            vec![home.join("AppData"), home.join(".ssh")],
        );
        (base, policy)
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    #[test]
    fn accepts_a_plain_subfolder() {
        let (base, policy) = sandbox();
        let docs = base.path().join("home").join("Documents");
        let out = validate_existing_root(&s(&docs), &policy).unwrap();
        assert_eq!(out, simplify(&docs.canonicalize().unwrap()));
    }

    #[test]
    fn refuses_relative_empty_and_missing() {
        let (base, policy) = sandbox();
        for bad in ["", "   ", "relative/dir", "./x"] {
            assert!(matches!(
                validate_existing_root(bad, &policy),
                Err(AppError::InvalidPath(_))
            ));
        }
        let missing = base.path().join("nope");
        assert!(validate_existing_root(&s(&missing), &policy).is_err());
    }

    #[test]
    fn refuses_home_denied_trees_and_their_ancestors() {
        let (base, policy) = sandbox();
        let home = base.path().join("home");
        for bad in [
            home.clone(),
            home.join("AppData"),
            home.join("AppData").join("Roaming"),
            home.join(".ssh"),
            // `..` resolves into a denied tree.
            home.join("Documents").join("..").join(".ssh"),
            // an ancestor of the denied trees
            base.path().to_path_buf(),
        ] {
            let err = validate_existing_root(&s(&bad), &policy).unwrap_err();
            assert!(matches!(err, AppError::InvalidPath(_)), "{bad:?}: {err:?}");
        }
    }

    #[test]
    fn refuses_filesystem_root() {
        let policy = VaultPathPolicy::default();
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        let err = validate_existing_root(root, &policy).unwrap_err();
        assert!(matches!(err, AppError::InvalidPath(_)), "{err:?}");
    }

    #[test]
    fn new_root_may_not_exist_yet_but_its_parent_must() {
        let (base, policy) = sandbox();
        let docs = base.path().join("home").join("Documents");
        let fresh = docs.join("my-vault");
        let out = validate_new_root(&s(&fresh), &policy).unwrap();
        assert_eq!(
            out,
            simplify(&docs.canonicalize().unwrap()).join("my-vault")
        );
        assert!(!fresh.exists(), "validation must not create anything");

        let orphan = docs.join("missing-parent").join("v");
        assert!(matches!(
            validate_new_root(&s(&orphan), &policy),
            Err(AppError::InvalidPath(_))
        ));
        let in_denied = base.path().join("home").join(".ssh").join("v");
        assert!(validate_new_root(&s(&in_denied), &policy).is_err());
    }

    #[test]
    fn system_policy_refuses_home_and_os_dirs() {
        let policy = VaultPathPolicy::system();
        let mut bad: Vec<PathBuf> = Vec::new();
        if let Some(h) = dirs::home_dir() {
            bad.push(h.clone());
        }
        if let Some(c) = dirs::config_dir() {
            bad.push(c);
        }
        if cfg!(windows) {
            for var in ["SystemRoot", "ProgramFiles", "LOCALAPPDATA", "APPDATA"] {
                if let Some(v) = std::env::var_os(var) {
                    bad.push(PathBuf::from(v));
                }
            }
        } else {
            bad.push(PathBuf::from("/etc"));
            bad.push(PathBuf::from("/usr"));
        }
        for p in bad.into_iter().filter(|p| p.is_dir()) {
            let err = validate_existing_root(&s(&p), &policy).unwrap_err();
            assert!(matches!(err, AppError::InvalidPath(_)), "{p:?}: {err:?}");
        }
    }

    #[test]
    fn simplify_strips_verbatim_prefixes() {
        assert_eq!(simplify(Path::new(r"\\?\C:\x\y")), PathBuf::from(r"C:\x\y"));
        assert_eq!(
            simplify(Path::new(r"\\?\UNC\srv\share\v")),
            PathBuf::from(r"\\srv\share\v")
        );
        assert_eq!(simplify(Path::new("/tmp/v")), PathBuf::from("/tmp/v"));
    }

    #[test]
    fn naiteh_vault_detection() {
        let d = tempdir().unwrap();
        assert!(!is_naiteh_vault(d.path()));
        std::fs::create_dir_all(d.path().join("notes")).unwrap();
        assert!(!is_naiteh_vault(d.path()));
        std::fs::create_dir_all(d.path().join("journal")).unwrap();
        assert!(is_naiteh_vault(d.path()));
        let e = tempdir().unwrap();
        std::fs::create_dir_all(e.path().join(".naiteh")).unwrap();
        assert!(is_naiteh_vault(e.path()));
    }
}
