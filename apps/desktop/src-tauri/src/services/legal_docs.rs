//! Managed RAG source repository for Korean statutes.
//!
//! The source is intentionally outside user vaults because
//! `legalize-kr/legalize-kr` is large, generated, and may be force-pushed.

use std::path::{Path, PathBuf};

use git2::{Cred, CredentialType, FetchOptions, RemoteCallbacks, Repository};

use crate::domain::{AppError, LegalDocsStatus};
use crate::services::{fs as fsx, notes};

pub const LEGALIZE_KR_REPO_URL: &str = "https://github.com/legalize-kr/legalize-kr.git";
pub const DEFAULT_BRANCH: &str = "main";

fn map_git_err(e: git2::Error) -> AppError {
    AppError::Io(format!("legal docs git: {e}"))
}

fn auth_callbacks() -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(|url, username_from_url, allowed| {
        if allowed.contains(CredentialType::SSH_KEY) {
            return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
        }
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            let cfg = git2::Config::open_default()?;
            return Cred::credential_helper(&cfg, url, username_from_url);
        }
        if allowed.contains(CredentialType::DEFAULT) {
            return Cred::default();
        }
        Err(git2::Error::from_str("no auth method available"))
    });
    cb
}

fn fetch_options() -> FetchOptions<'static> {
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(auth_callbacks());
    opts
}

pub fn repo_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("rag").join("legalize-kr").join("repo")
}

#[cfg(test)]
fn docs_path(app_data_dir: &Path) -> PathBuf {
    repo_path(app_data_dir).join("kr")
}

pub fn status(app_data_dir: &Path) -> Result<LegalDocsStatus, AppError> {
    let repo_path = repo_path(app_data_dir);
    status_for_repo_path(&repo_path)
}

fn status_for_repo_path(repo_path: &Path) -> Result<LegalDocsStatus, AppError> {
    let docs_path = repo_path.join("kr");
    let repo = Repository::open(repo_path).ok();
    let installed = repo.is_some();
    let (branch, head) = match repo.as_ref() {
        Some(repo) => (current_branch(repo), head_oid(repo)),
        None => (None, None),
    };
    let document_count = if docs_path.is_dir() {
        notes::collect_md_files(&docs_path)?.len() as u32
    } else {
        0
    };

    Ok(LegalDocsStatus {
        repo_url: LEGALIZE_KR_REPO_URL.to_string(),
        local_path: repo_path.to_string_lossy().to_string(),
        docs_path: docs_path.to_string_lossy().to_string(),
        installed,
        branch,
        head,
        document_count,
    })
}

pub fn sync(app_data_dir: &Path) -> Result<LegalDocsStatus, AppError> {
    let repo_path = repo_path(app_data_dir);
    let parent = repo_path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("path has no parent: {}", repo_path.display()))
    })?;
    fsx::ensure_dir(parent)?;

    if !repo_path.exists() {
        clone_repo(&repo_path)?;
    } else {
        update_repo(&repo_path)?;
    }
    status_for_repo_path(&repo_path)
}

fn clone_repo(repo_path: &Path) -> Result<(), AppError> {
    Repository::clone(LEGALIZE_KR_REPO_URL, repo_path).map_err(map_git_err)?;
    Ok(())
}

fn update_repo(repo_path: &Path) -> Result<(), AppError> {
    let repo = Repository::open(repo_path).map_err(|e| match e.code() {
        git2::ErrorCode::NotFound => AppError::Conflict(format!(
            "legal docs path exists but is not a git repository: {}",
            repo_path.display()
        )),
        _ => map_git_err(e),
    })?;

    if repo.find_remote("origin").is_ok() {
        repo.remote_set_url("origin", LEGALIZE_KR_REPO_URL)
            .map_err(map_git_err)?;
    } else {
        repo.remote("origin", LEGALIZE_KR_REPO_URL)
            .map_err(map_git_err)?;
    }

    let mut remote = repo.find_remote("origin").map_err(map_git_err)?;
    remote
        .fetch(&[DEFAULT_BRANCH], Some(&mut fetch_options()), None)
        .map_err(map_git_err)?;
    drop(remote);

    let remote_ref = format!("refs/remotes/origin/{DEFAULT_BRANCH}");
    let target = repo.refname_to_id(&remote_ref).map_err(map_git_err)?;
    let local_ref = format!("refs/heads/{DEFAULT_BRANCH}");
    repo.reference(&local_ref, target, true, "naiteh: update legal docs")
        .map_err(map_git_err)?;
    repo.set_head(&local_ref).map_err(map_git_err)?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(map_git_err)?;
    Ok(())
}

fn current_branch(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| head.shorthand().map(str::to_string))
}

fn head_oid(repo: &Repository) -> Option<String> {
    repo.head()
        .ok()
        .and_then(|head| head.target())
        .map(|oid| oid.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::fs as fsx;
    use tempfile::tempdir;

    #[test]
    fn repo_and_docs_paths_are_under_rag_legalize_kr() {
        let root = tempdir().unwrap();
        assert_eq!(
            repo_path(root.path()),
            root.path().join("rag/legalize-kr/repo")
        );
        assert_eq!(
            docs_path(root.path()),
            root.path().join("rag/legalize-kr/repo/kr")
        );
    }

    #[test]
    fn status_reports_not_installed_when_repo_missing() {
        let root = tempdir().unwrap();
        let status = status(root.path()).unwrap();
        assert!(!status.installed);
        assert_eq!(status.document_count, 0);
        assert!(status.local_path.ends_with("rag/legalize-kr/repo"));
        assert!(status.docs_path.ends_with("rag/legalize-kr/repo/kr"));
    }

    #[test]
    fn status_counts_markdown_documents_under_kr() {
        let root = tempdir().unwrap();
        let repo = repo_path(root.path());
        Repository::init(&repo).unwrap();
        fsx::atomic_write(&repo.join("kr/민법/법률.md"), b"# minbeop").unwrap();
        fsx::atomic_write(&repo.join("kr/민법/readme.txt"), b"skip").unwrap();

        let status = status(root.path()).unwrap();
        assert!(status.installed);
        assert_eq!(status.document_count, 1);
    }
}
