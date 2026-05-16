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
                .naiteh/workspace.json\n\
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
    // Refuse to pull when the working tree is dirty — the force-checkout
    // below would otherwise silently clobber the user's in-progress
    // edits. `sync_now` handles dirty state by committing first; for
    // raw `sync_pull` the user must save (autosave handles this) and
    // retry, or use `sync_now` instead.
    if is_dirty(&repo)? {
        return Err(AppError::Conflict(
            "vault has uncommitted changes; save your work or use \"Sync now\" instead of \"Pull\"".into(),
        ));
    }
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
    // architecture.md §9: a real three-way merge. Try it; if any path
    // conflicts, write the *theirs* version of each conflicted file to
    // `<file>.conflict-<timestamp>.md` next to the original and leave HEAD
    // alone so the user can resolve manually. naiteh does not auto-merge
    // in v1.
    perform_three_way_merge(&repo, vault_root, &fetch_commit, &branch)
}

fn perform_three_way_merge(
    repo: &Repository,
    vault_root: &Path,
    fetch_commit: &AnnotatedCommit<'_>,
    branch: &str,
) -> Result<(), AppError> {
    let head_commit = repo
        .head()
        .and_then(|r| r.peel_to_commit())
        .map_err(map_git_err)?;
    let theirs_commit = repo.find_commit(fetch_commit.id()).map_err(map_git_err)?;
    let base_oid = repo
        .merge_base(head_commit.id(), theirs_commit.id())
        .map_err(map_git_err)?;
    let base_commit = repo.find_commit(base_oid).map_err(map_git_err)?;

    let head_tree = head_commit.tree().map_err(map_git_err)?;
    let theirs_tree = theirs_commit.tree().map_err(map_git_err)?;
    let base_tree = base_commit.tree().map_err(map_git_err)?;

    let mut merged_index = repo
        .merge_trees(&base_tree, &head_tree, &theirs_tree, None)
        .map_err(map_git_err)?;

    if merged_index.has_conflicts() {
        let written = capture_their_versions(repo, vault_root, &theirs_tree, &mut merged_index)?;
        return Err(AppError::Conflict(format!(
            "remote diverged on {} file{}; their versions saved as *.conflict-<timestamp>.md — \
             resolve manually and try sync again",
            written,
            if written == 1 { "" } else { "s" }
        )));
    }

    // Clean three-way merge: write the merged tree, create the merge commit,
    // fast-forward the local branch, check out the result.
    let merged_tree_oid = merged_index.write_tree_to(repo).map_err(map_git_err)?;
    let merged_tree = repo.find_tree(merged_tree_oid).map_err(map_git_err)?;
    let sig = signature_for(repo)?;
    let new_commit_oid = repo
        .commit(
            None,
            &sig,
            &sig,
            "naiteh: sync merge",
            &merged_tree,
            &[&head_commit, &theirs_commit],
        )
        .map_err(map_git_err)?;

    let refname = format!("refs/heads/{branch}");
    let mut head_ref = repo.find_reference(&refname).map_err(map_git_err)?;
    head_ref
        .set_target(new_commit_oid, "naiteh: merge commit")
        .map_err(map_git_err)?;
    repo.set_head(&refname).map_err(map_git_err)?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(map_git_err)?;
    Ok(())
}

/// For every entry in `merged_index` that has the conflict bit set,
/// extract the corresponding "theirs" blob from `theirs_tree` and write
/// it next to the original as `<stem>.conflict-<timestamp>[-N].<ext>`.
/// Returns the number of conflict files written.
fn capture_their_versions(
    repo: &Repository,
    vault_root: &Path,
    theirs_tree: &git2::Tree<'_>,
    merged_index: &mut git2::Index,
) -> Result<usize, AppError> {
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let mut written = 0usize;
    let conflicts = merged_index
        .conflicts()
        .map_err(map_git_err)?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    for entry in conflicts {
        // Pull the path + content from the *theirs* index entry — that's
        // the remote version we want to surface.
        let Some(theirs) = entry.their else { continue };
        let path = match std::str::from_utf8(&theirs.path) {
            Ok(s) => s.to_string(),
            Err(_) => continue,
        };
        let blob_oid = match theirs_tree
            .get_path(Path::new(&path))
            .and_then(|e| e.to_object(repo))
        {
            Ok(obj) => obj.id(),
            Err(_) => theirs.id,
        };
        let blob = match repo.find_blob(blob_oid) {
            Ok(b) => b,
            Err(_) => continue,
        };

        let target = conflict_path(vault_root, &path, &timestamp);
        if let Some(parent) = target.parent() {
            crate::services::fs::ensure_dir(parent)?;
        }
        crate::services::fs::atomic_write(&target, blob.content())?;
        written += 1;
    }
    Ok(written)
}

/// Build `<stem>.conflict-<ts>.<ext>` next to the original path, falling
/// back to appending the suffix when there is no extension.
fn conflict_path(vault_root: &Path, rel_path: &str, timestamp: &str) -> std::path::PathBuf {
    let original = vault_root.join(rel_path);
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = original
        .extension()
        .map(|s| s.to_string_lossy().into_owned());
    let parent = original.parent().unwrap_or(vault_root);
    let new_name = match ext {
        Some(e) => format!("{stem}.conflict-{timestamp}.{e}"),
        None => format!("{stem}.conflict-{timestamp}"),
    };
    parent.join(new_name)
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

    // ── pull / conflict capture ───────────────────────────────────────────

    /// Set up two vaults sharing a `file://` remote so we can exercise
    /// pull paths without touching the network. Returns (`local`, `remote_other`).
    /// Both have an initial commit on `main` containing `notes/x.md = "v0"`,
    /// and `local`'s `origin` points at `remote`.
    fn diverged_pair() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
        let remote_bare = tempdir().unwrap();
        let mut bare_opts = git2::RepositoryInitOptions::new();
        bare_opts.bare(true).initial_head(DEFAULT_BRANCH);
        Repository::init_opts(remote_bare.path(), &bare_opts).unwrap();

        // Seed via a working clone, then push.
        let seed = tempdir().unwrap();
        fsx::atomic_write(&seed.path().join("notes/x.md"), b"v0\n").unwrap();
        init(seed.path()).unwrap();
        set_remote(
            seed.path(),
            &format!("file://{}", remote_bare.path().display()),
        )
        .unwrap();
        push(seed.path()).unwrap();

        // Local clone of the remote.
        let local = tempdir().unwrap();
        Repository::clone(
            &format!("file://{}", remote_bare.path().display()),
            local.path(),
        )
        .unwrap();
        // Make sure ensure_gitignore-style state is fine.
        let _ = init(local.path());

        (local, remote_bare, seed)
    }

    fn commit_change(repo_root: &Path, rel: &str, content: &[u8], msg: &str) {
        fsx::atomic_write(&repo_root.join(rel), content).unwrap();
        let repo = Repository::open(repo_root).unwrap();
        commit_all(&repo, msg).unwrap();
    }

    #[test]
    fn pull_fast_forwards_when_local_is_strictly_behind() {
        let (local, _remote, seed) = diverged_pair();
        // Remote-side commit ahead of the local clone.
        commit_change(seed.path(), "notes/x.md", b"v1\n", "remote v1");
        push(seed.path()).unwrap();

        pull_ff_only(local.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(local.path().join("notes/x.md")).unwrap(),
            "v1\n",
        );
    }

    #[test]
    fn pull_completes_three_way_merge_when_changes_dont_collide() {
        let (local, _remote, seed) = diverged_pair();
        // Local edits a file; remote edits a *different* file. Both get
        // committed, then we sync.
        commit_change(
            local.path(),
            "notes/local-only.md",
            b"local\n",
            "local edit",
        );
        commit_change(
            seed.path(),
            "notes/remote-only.md",
            b"remote\n",
            "remote edit",
        );
        push(seed.path()).unwrap();

        pull_ff_only(local.path()).unwrap();
        assert!(local.path().join("notes/local-only.md").exists());
        assert!(local.path().join("notes/remote-only.md").exists());
        let local_repo = Repository::open(local.path()).unwrap();
        let head_ref = local_repo.head().unwrap();
        let head = head_ref.peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2, "expected a merge commit");
    }

    #[test]
    fn pull_captures_their_version_on_conflicting_edit() {
        let (local, _remote, seed) = diverged_pair();
        // Both sides change the SAME file in incompatible ways.
        commit_change(local.path(), "notes/x.md", b"local v1\n", "local edit");
        commit_change(seed.path(), "notes/x.md", b"remote v1\n", "remote edit");
        push(seed.path()).unwrap();

        let err = pull_ff_only(local.path()).unwrap_err();
        match &err {
            AppError::Conflict(msg) => {
                assert!(
                    msg.contains("conflict-"),
                    "conflict message should mention the dual-file capture: {msg}"
                );
            }
            other => panic!("expected Conflict, got {other:?}"),
        }

        // Local copy untouched (HEAD didn't move).
        assert_eq!(
            std::fs::read_to_string(local.path().join("notes/x.md")).unwrap(),
            "local v1\n",
        );
        // Their version landed on disk next to it.
        let conflicts: Vec<_> = std::fs::read_dir(local.path().join("notes"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains("x.conflict-"))
            .collect();
        assert_eq!(conflicts.len(), 1, "exactly one conflict capture file");
        let captured = std::fs::read_to_string(conflicts[0].path()).unwrap();
        assert_eq!(captured, "remote v1\n");
    }

    #[test]
    fn conflict_path_keeps_extension_and_directory() {
        let v = tempdir().unwrap();
        let p = conflict_path(v.path(), "notes/work/standup.md", "2026-05-09T10-00-00");
        assert_eq!(
            p.strip_prefix(v.path()).unwrap().to_string_lossy(),
            "notes/work/standup.conflict-2026-05-09T10-00-00.md"
        );
    }

    #[test]
    fn conflict_path_handles_extension_less_files() {
        let v = tempdir().unwrap();
        let p = conflict_path(v.path(), "notes/README", "ts");
        assert_eq!(
            p.strip_prefix(v.path()).unwrap().to_string_lossy(),
            "notes/README.conflict-ts"
        );
    }
}
