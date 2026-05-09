//! Git plumbing for the Sync feature — see architecture.md §7.7 / §9.
//!
//! The user-facing UI never says "git", "commit", or "remote" — that's a
//! product concern handled in the frontend. This module just wraps libgit2
//! into intent-shaped helpers.

use std::path::Path;

use git2::{
    AnnotatedCommit, Cred, CredentialType, FetchOptions, MergeAnalysis, PushOptions,
    RemoteCallbacks, Repository, Signature, Status, StatusOptions,
};

use crate::domain::{AppError, SyncStatus};
use crate::services::fs as fsx;

const REMOTE_NAME: &str = "origin";
const NAITEH_AUTHOR_NAME: &str = "naiteh";
const NAITEH_AUTHOR_EMAIL: &str = "naiteh@local";
const DEFAULT_BRANCH: &str = "main";

fn map_git_err(e: git2::Error) -> AppError {
    AppError::Io(format!("git: {e}"))
}

fn open_repo(vault_root: &Path) -> Result<Repository, AppError> {
    Repository::open(vault_root).map_err(|e| match e.code() {
        git2::ErrorCode::NotFound => {
            AppError::NotFound(format!("no repository at {}", vault_root.display()))
        }
        _ => map_git_err(e),
    })
}

fn signature_for(repo: &Repository) -> Result<Signature<'static>, AppError> {
    // Prefer the user's git config if set, else fall back to a stable
    // naiteh identity so commits don't fail on a fresh machine.
    repo.signature()
        .map(|s| {
            // Detach lifetime by reconstructing — git2's Signature stores
            // pointers into the config; we want owned strings here.
            let name = s.name().unwrap_or(NAITEH_AUTHOR_NAME).to_string();
            let email = s.email().unwrap_or(NAITEH_AUTHOR_EMAIL).to_string();
            Signature::now(&name, &email).map_err(map_git_err)
        })
        .unwrap_or_else(|_| {
            Signature::now(NAITEH_AUTHOR_NAME, NAITEH_AUTHOR_EMAIL).map_err(map_git_err)
        })
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

// ── init ─────────────────────────────────────────────────────────────────

/// Initialise a git repository at `vault_root`. Idempotent: if a repo is
/// already present, this just creates the initial commit when the working
/// tree has files but no commit history.
pub fn init(vault_root: &Path) -> Result<(), AppError> {
    let repo = match Repository::open(vault_root) {
        Ok(r) => r,
        Err(_) => {
            let mut opts = git2::RepositoryInitOptions::new();
            opts.initial_head(DEFAULT_BRANCH);
            Repository::init_opts(vault_root, &opts).map_err(map_git_err)?
        }
    };

    ensure_gitignore(vault_root)?;

    if repo.head().is_err() {
        commit_all(&repo, "naiteh: initial sync")?;
    }
    Ok(())
}

/// Make sure machine-local state files inside `.naiteh/` aren't tracked by
/// git so they don't show up as "dirty" or get pushed to other machines.
fn ensure_gitignore(vault_root: &Path) -> Result<(), AppError> {
    let path = vault_root.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    let body = "# naiteh - machine-local state, not synced\n\
                .naiteh/sync-state.json\n\
                .naiteh/tags.json\n";
    fsx::atomic_write(&path, body.as_bytes())
}

// ── set remote ───────────────────────────────────────────────────────────

pub fn set_remote(vault_root: &Path, url: &str) -> Result<(), AppError> {
    let repo = open_repo(vault_root)?;
    if repo.find_remote(REMOTE_NAME).is_ok() {
        repo.remote_set_url(REMOTE_NAME, url).map_err(map_git_err)?;
    } else {
        repo.remote(REMOTE_NAME, url).map_err(map_git_err)?;
    }
    Ok(())
}

// ── status ───────────────────────────────────────────────────────────────

pub fn status(vault_root: &Path, last_sync: Option<i64>) -> Result<SyncStatus, AppError> {
    let repo = open_repo(vault_root)?;

    let branch = current_branch_name(&repo).unwrap_or_else(|_| DEFAULT_BRANCH.to_string());
    let remote_url = repo
        .find_remote(REMOTE_NAME)
        .ok()
        .and_then(|r| r.url().map(str::to_string));

    let dirty = is_dirty(&repo)?;

    let (ahead, behind) = ahead_behind(&repo, &branch).unwrap_or((0, 0));

    Ok(SyncStatus {
        remote_url,
        branch,
        ahead,
        behind,
        dirty,
        last_sync,
    })
}

fn current_branch_name(repo: &Repository) -> Result<String, AppError> {
    let head = repo.head().map_err(map_git_err)?;
    if !head.is_branch() {
        return Ok("HEAD".to_string());
    }
    Ok(head.shorthand().unwrap_or("").to_string())
}

fn is_dirty(repo: &Repository) -> Result<bool, AppError> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .include_ignored(false)
        .include_unmodified(false)
        .recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts)).map_err(map_git_err)?;
    let dirty_mask = Status::WT_NEW
        | Status::WT_MODIFIED
        | Status::WT_DELETED
        | Status::WT_RENAMED
        | Status::WT_TYPECHANGE
        | Status::INDEX_NEW
        | Status::INDEX_MODIFIED
        | Status::INDEX_DELETED
        | Status::INDEX_RENAMED
        | Status::INDEX_TYPECHANGE
        | Status::CONFLICTED;
    Ok(statuses.iter().any(|e| e.status().intersects(dirty_mask)))
}

fn ahead_behind(repo: &Repository, branch: &str) -> Result<(u32, u32), AppError> {
    let local_ref = format!("refs/heads/{branch}");
    let remote_ref = format!("refs/remotes/{REMOTE_NAME}/{branch}");
    let local = match repo.refname_to_id(&local_ref) {
        Ok(id) => id,
        Err(_) => return Ok((0, 0)),
    };
    let upstream = match repo.refname_to_id(&remote_ref) {
        Ok(id) => id,
        Err(_) => return Ok((0, 0)),
    };
    let (ahead, behind) = repo
        .graph_ahead_behind(local, upstream)
        .map_err(map_git_err)?;
    Ok((ahead as u32, behind as u32))
}

// ── commit all ───────────────────────────────────────────────────────────

/// Stage every change in the working tree, then create a commit. Returns
/// `Ok(false)` when the working tree was already clean (nothing committed).
pub fn commit_all(repo: &Repository, message: &str) -> Result<bool, AppError> {
    let mut index = repo.index().map_err(map_git_err)?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(map_git_err)?;
    index.write().map_err(map_git_err)?;

    let tree_oid = index.write_tree().map_err(map_git_err)?;
    let tree = repo.find_tree(tree_oid).map_err(map_git_err)?;
    let sig = signature_for(repo)?;

    match repo.head() {
        Ok(head) => {
            let parent = head.peel_to_commit().map_err(map_git_err)?;
            if parent.tree_id() == tree_oid {
                // Nothing to commit.
                return Ok(false);
            }
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
                .map_err(map_git_err)?;
        }
        Err(_) => {
            // First commit on the default branch.
            let branch_ref = format!("refs/heads/{DEFAULT_BRANCH}");
            repo.commit(Some(&branch_ref), &sig, &sig, message, &tree, &[])
                .map_err(map_git_err)?;
            repo.set_head(&branch_ref).map_err(map_git_err)?;
        }
    }
    Ok(true)
}

// ── push ─────────────────────────────────────────────────────────────────

pub fn push(vault_root: &Path) -> Result<(), AppError> {
    let repo = open_repo(vault_root)?;
    let branch = current_branch_name(&repo)?;
    let mut remote = repo
        .find_remote(REMOTE_NAME)
        .map_err(|_| AppError::NotFound("no backup destination configured".into()))?;
    let mut opts = PushOptions::new();
    opts.remote_callbacks(auth_callbacks());
    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    remote
        .push(&[&refspec], Some(&mut opts))
        .map_err(map_git_err)?;
    // Update the remote-tracking ref so ahead/behind counts reflect reality.
    let _ = remote.fetch(&[branch.as_str()], Some(&mut fetch_options()), None);
    Ok(())
}

// ── pull (fast-forward only) ─────────────────────────────────────────────

pub fn pull_ff_only(vault_root: &Path) -> Result<(), AppError> {
    let repo = open_repo(vault_root)?;
    let branch = current_branch_name(&repo)?;
    let mut remote = repo
        .find_remote(REMOTE_NAME)
        .map_err(|_| AppError::NotFound("no backup destination configured".into()))?;

    remote
        .fetch(&[branch.as_str()], Some(&mut fetch_options()), None)
        .map_err(map_git_err)?;
    drop(remote);

    let fetch_head = repo.find_reference("FETCH_HEAD").map_err(map_git_err)?;
    let fetch_commit: AnnotatedCommit = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(map_git_err)?;

    let analysis = repo
        .merge_analysis(&[&fetch_commit])
        .map_err(map_git_err)?
        .0;

    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) {
        let refname = format!("refs/heads/{branch}");
        let mut head_ref = repo.find_reference(&refname).map_err(map_git_err)?;
        head_ref
            .set_target(fetch_commit.id(), "naiteh: fast-forward")
            .map_err(map_git_err)?;
        repo.set_head(&refname).map_err(map_git_err)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(map_git_err)?;
        return Ok(());
    }
    // Anything else (normal three-way merge) is rejected as a v1 conflict.
    Err(AppError::Conflict(
        "remote diverged from local; fast-forward only is supported in v1".into(),
    ))
}

fn fetch_options() -> FetchOptions<'static> {
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(auth_callbacks());
    opts
}

// ── sync_now (commit local → push) ──────────────────────────────────────

/// One-shot sync: stage + commit any local changes, then push.
/// `pull_first` is the v1 conservative default: if the user has set a
/// remote, attempt a fast-forward pull first so a stale local doesn't
/// reject the push.
pub fn sync_now(vault_root: &Path) -> Result<(), AppError> {
    let repo = open_repo(vault_root)?;

    // Commit local changes if any.
    if is_dirty(&repo)? {
        commit_all(&repo, "naiteh: sync")?;
    }

    // If a remote is configured, try to keep up-to-date and push.
    let has_remote = repo.find_remote(REMOTE_NAME).is_ok();
    drop(repo);

    if has_remote {
        pull_ff_only(vault_root)?;
        push(vault_root)?;
    }
    Ok(())
}

// ── helpers exposed for tests ────────────────────────────────────────────

#[cfg(test)]
pub(crate) fn local_branches(repo: &Repository) -> Vec<String> {
    repo.branches(Some(git2::BranchType::Local))
        .map(|iter| {
            iter.filter_map(|b| {
                b.ok()
                    .and_then(|(branch, _)| branch.name().ok().flatten().map(str::to_string))
            })
            .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::fs as fsx;
    use tempfile::tempdir;

    #[test]
    fn init_creates_repo_and_initial_commit_when_files_exist() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"# x").unwrap();
        init(v.path()).unwrap();
        let repo = Repository::open(v.path()).unwrap();
        // Has a HEAD commit on main.
        let head = repo.head().unwrap();
        assert!(head.is_branch());
        assert_eq!(head.shorthand(), Some(DEFAULT_BRANCH));
        // The committed tree contains notes/x.md.
        let tree = head.peel_to_commit().unwrap().tree().unwrap();
        assert!(tree.get_path(std::path::Path::new("notes/x.md")).is_ok());
    }

    #[test]
    fn init_is_idempotent() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"# x").unwrap();
        init(v.path()).unwrap();
        // Calling again must not fail and must not add a duplicate commit.
        init(v.path()).unwrap();
        let repo = Repository::open(v.path()).unwrap();
        let head = repo.head().unwrap();
        assert_eq!(local_branches(&repo), vec![DEFAULT_BRANCH.to_string()]);
        assert!(head.peel_to_commit().unwrap().parent_count() == 0);
    }

    #[test]
    fn set_remote_creates_then_updates_origin() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();

        set_remote(v.path(), "https://example.com/repo.git").unwrap();
        let repo = Repository::open(v.path()).unwrap();
        assert_eq!(
            repo.find_remote(REMOTE_NAME).unwrap().url(),
            Some("https://example.com/repo.git"),
        );

        // Replace.
        set_remote(v.path(), "https://example.com/other.git").unwrap();
        let repo = Repository::open(v.path()).unwrap();
        assert_eq!(
            repo.find_remote(REMOTE_NAME).unwrap().url(),
            Some("https://example.com/other.git"),
        );
    }

    #[test]
    fn status_reports_remote_branch_and_clean_state() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();
        set_remote(v.path(), "https://example.com/repo.git").unwrap();

        let s = status(v.path(), Some(123)).unwrap();
        assert_eq!(
            s.remote_url.as_deref(),
            Some("https://example.com/repo.git")
        );
        assert_eq!(s.branch, DEFAULT_BRANCH);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert!(!s.dirty);
        assert_eq!(s.last_sync, Some(123));
    }

    #[test]
    fn status_marks_dirty_when_files_change() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();

        // Untracked new file.
        fsx::atomic_write(&v.path().join("notes/new.md"), b"new").unwrap();
        assert!(status(v.path(), None).unwrap().dirty);

        // Modify tracked file.
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x v2").unwrap();
        assert!(status(v.path(), None).unwrap().dirty);
    }

    #[test]
    fn status_returns_not_found_when_no_repo() {
        let v = tempdir().unwrap();
        let err = status(v.path(), None).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn sync_now_commits_local_changes_and_clears_dirty() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();

        fsx::atomic_write(&v.path().join("notes/x.md"), b"x updated").unwrap();
        assert!(status(v.path(), None).unwrap().dirty);

        // No remote configured → sync_now is purely a local commit.
        sync_now(v.path()).unwrap();
        assert!(!status(v.path(), None).unwrap().dirty);

        let repo = Repository::open(v.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        assert_eq!(head.message(), Some("naiteh: sync"));
    }

    #[test]
    fn camel_case_serialization() {
        let s = SyncStatus {
            remote_url: Some("https://example.com/repo.git".into()),
            branch: "main".into(),
            ahead: 1,
            behind: 2,
            dirty: true,
            last_sync: Some(42),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"remoteUrl\":\"https://example.com/repo.git\""));
        assert!(json.contains("\"lastSync\":42"));
        assert!(json.contains("\"dirty\":true"));
    }
}
