//! Git plumbing for the Sync feature — see vault/wiki/ipc-api.md ("Sync")
//! and vault/wiki/concurrency-safety.md.
//!
//! The user-facing UI never says "git", "commit", or "remote" — that's a
//! product concern handled in the frontend. This module just wraps libgit2
//! into intent-shaped helpers.
//!
//! A sync is split into phases so the IPC layer can hold the vault lock
//! only around *local* work and run the network parts unlocked:
//!
//! ```text
//! prepare   (locked)   finish a resolved pending merge, commit local edits
//! fetch     (unlocked) download the remote branch into refs/remotes/origin/*
//! integrate (locked)   fast-forward / three-way merge / join an existing
//!                      remote; on conflicts write sidecars + pending state
//! push      (unlocked) upload the local branch
//! ```
//!
//! Network phases carry a deadline (enforced from libgit2 callbacks) plus
//! global connect / read timeouts, and the credential callback tries each
//! method at most once so a rejected credential can't loop forever.

use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use git2::{
    AutotagOption, Commit, Cred, CredentialType, ErrorClass, ErrorCode, FetchOptions, Index, Oid,
    PushOptions, RemoteCallbacks, Repository, Signature, Status, StatusOptions, Tree,
};

use crate::domain::{AppError, SyncStatus};
use crate::services::conflicts;
use crate::services::fs as fsx;
use crate::services::sync_state::{self, PendingMerge};

const REMOTE_NAME: &str = "origin";
const NAITEH_AUTHOR_NAME: &str = "naiteh";
const NAITEH_AUTHOR_EMAIL: &str = "naiteh@local";
const DEFAULT_BRANCH: &str = "main";

const MSG_INITIAL: &str = "naiteh: initial sync";
const MSG_SYNC: &str = "naiteh: sync";
const MSG_MERGE: &str = "naiteh: sync merge";
const MSG_MERGE_RESOLVED: &str = "naiteh: sync merge (resolved conflicts)";
const MSG_JOIN: &str = "naiteh: join existing vault";

/// Lines `.gitignore` must contain: machine-local state that must never be
/// committed or pushed to other machines.
const MACHINE_LOCAL_FILES: &[&str] = &[
    ".naiteh/sync-state.json",
    ".naiteh/workspace.json",
    ".naiteh/tags.json",
];

/// Overall budget for one fetch or push.
const NETWORK_DEADLINE: Duration = Duration::from_secs(300);
/// libgit2 global socket timeouts (milliseconds).
const CONNECT_TIMEOUT_MS: i32 = 15_000;
const IO_TIMEOUT_MS: i32 = 60_000;

/// Index-entry flag bits holding the conflict stage (`GIT_INDEX_ENTRY_STAGEMASK`).
const INDEX_STAGE_MASK: u16 = 0x3000;

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

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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

// ── network plumbing: credentials, deadlines, error mapping ─────────────

/// One credential method to offer libgit2.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CredStep {
    Username(String),
    SshAgent(String),
    SshKey(String, PathBuf),
    CredentialHelper,
    Default,
}

/// Decides which credential to offer next. libgit2 calls the credential
/// callback again every time the previous credential is rejected, so each
/// method is offered **at most once** per network operation; when nothing
/// is left the callback errors out instead of looping forever.
#[derive(Debug)]
struct CredentialPlanner {
    ssh_dir: Option<PathBuf>,
    sent_username: bool,
    tried_agent: bool,
    tried_keys: Vec<PathBuf>,
    tried_helper: bool,
    tried_default: bool,
    calls: u32,
}

/// Hard ceiling on credential callbacks per operation, in case libgit2
/// keeps asking for a method we don't track.
const MAX_CREDENTIAL_CALLS: u32 = 10;
const DEFAULT_SSH_KEYS: &[&str] = &["id_ed25519", "id_rsa"];

impl CredentialPlanner {
    fn new(ssh_dir: Option<PathBuf>) -> Self {
        Self {
            ssh_dir,
            sent_username: false,
            tried_agent: false,
            tried_keys: Vec::new(),
            tried_helper: false,
            tried_default: false,
            calls: 0,
        }
    }

    fn for_current_user() -> Self {
        Self::new(dirs::home_dir().map(|h| h.join(".ssh")))
    }

    fn next(
        &mut self,
        username_from_url: Option<&str>,
        allowed: CredentialType,
    ) -> Option<CredStep> {
        self.calls += 1;
        if self.calls > MAX_CREDENTIAL_CALLS {
            return None;
        }
        let user = username_from_url.unwrap_or("git").to_string();
        if allowed.contains(CredentialType::USERNAME) && !self.sent_username {
            self.sent_username = true;
            return Some(CredStep::Username(user));
        }
        if allowed.contains(CredentialType::SSH_KEY) {
            if !self.tried_agent {
                self.tried_agent = true;
                return Some(CredStep::SshAgent(user));
            }
            if let Some(dir) = &self.ssh_dir {
                for name in DEFAULT_SSH_KEYS {
                    let key = dir.join(name);
                    if key.is_file() && !self.tried_keys.contains(&key) {
                        self.tried_keys.push(key.clone());
                        return Some(CredStep::SshKey(user, key));
                    }
                }
            }
        }
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) && !self.tried_helper {
            self.tried_helper = true;
            return Some(CredStep::CredentialHelper);
        }
        if allowed.contains(CredentialType::DEFAULT) && !self.tried_default {
            self.tried_default = true;
            return Some(CredStep::Default);
        }
        None
    }
}

/// Shared state for one network operation's callbacks.
struct NetCtx {
    deadline: Instant,
    timeout: Duration,
    timed_out: Cell<bool>,
    auth_exhausted: Cell<bool>,
    planner: RefCell<CredentialPlanner>,
    push_rejections: RefCell<Vec<String>>,
}

impl NetCtx {
    fn new(timeout: Duration) -> Self {
        ensure_network_timeouts();
        Self {
            deadline: Instant::now() + timeout,
            timeout,
            timed_out: Cell::new(false),
            auth_exhausted: Cell::new(false),
            planner: RefCell::new(CredentialPlanner::for_current_user()),
            push_rejections: RefCell::new(Vec::new()),
        }
    }

    /// `false` (and remember why) once the deadline has passed.
    fn within_deadline(&self) -> bool {
        if Instant::now() >= self.deadline {
            self.timed_out.set(true);
            false
        } else {
            true
        }
    }

    fn credential(
        &self,
        url: &str,
        username_from_url: Option<&str>,
        allowed: CredentialType,
    ) -> Result<Cred, git2::Error> {
        if !self.within_deadline() {
            return Err(git2::Error::from_str("network operation timed out"));
        }
        loop {
            let step = self.planner.borrow_mut().next(username_from_url, allowed);
            let attempt = match step {
                None => {
                    self.auth_exhausted.set(true);
                    return Err(git2::Error::from_str(
                        "authentication failed: no more credentials to try",
                    ));
                }
                Some(CredStep::Username(u)) => Cred::username(&u),
                Some(CredStep::SshAgent(u)) => Cred::ssh_key_from_agent(&u),
                Some(CredStep::SshKey(u, key)) => Cred::ssh_key(&u, None, &key, None),
                Some(CredStep::CredentialHelper) => git2::Config::open_default()
                    .and_then(|cfg| Cred::credential_helper(&cfg, url, username_from_url)),
                Some(CredStep::Default) => Cred::default(),
            };
            // A method that can't even build a credential (no helper
            // configured, unreadable key) just moves on to the next one.
            if let Ok(cred) = attempt {
                return Ok(cred);
            }
        }
    }

    fn callbacks(&self) -> RemoteCallbacks<'_> {
        let mut cb = RemoteCallbacks::new();
        cb.credentials(move |url, user, allowed| self.credential(url, user, allowed));
        cb.transfer_progress(move |_| self.within_deadline());
        cb.sideband_progress(move |_| self.within_deadline());
        cb.push_negotiation(move |_| {
            if self.within_deadline() {
                Ok(())
            } else {
                Err(git2::Error::from_str("network operation timed out"))
            }
        });
        cb.push_update_reference(move |refname, status| {
            if let Some(msg) = status {
                self.push_rejections
                    .borrow_mut()
                    .push(format!("{refname}: {msg}"));
            }
            Ok(())
        });
        cb
    }

    fn map_err(&self, e: git2::Error, what: &str) -> AppError {
        if self.timed_out.get() {
            return AppError::Network(format!(
                "{what} timed out after {}s",
                self.timeout.as_secs()
            ));
        }
        if self.auth_exhausted.get() || e.code() == ErrorCode::Auth {
            return AppError::Unauthorized(format!(
                "the backup destination rejected every available credential ({})",
                e.message()
            ));
        }
        if e.code() == ErrorCode::NotFastForward {
            return AppError::Conflict(
                "the backup destination has newer changes; sync again".into(),
            );
        }
        match e.class() {
            ErrorClass::Net
            | ErrorClass::Http
            | ErrorClass::Ssh
            | ErrorClass::Ssl
            | ErrorClass::Os
            | ErrorClass::Callback => AppError::Network(format!("{what} failed: {}", e.message())),
            _ => AppError::Io(format!("git: {what} failed: {}", e.message())),
        }
    }
}

/// Install libgit2's process-wide connect / read timeouts once.
fn ensure_network_timeouts() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: these set libgit2 global options; called exactly once,
        // before any network operation started by this module.
        unsafe {
            let _ = git2::opts::set_server_connect_timeout_in_milliseconds(CONNECT_TIMEOUT_MS);
            let _ = git2::opts::set_server_timeout_in_milliseconds(IO_TIMEOUT_MS);
        }
    });
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
        commit_all(&repo, MSG_INITIAL)?;
    }
    Ok(())
}

/// Make sure machine-local state files inside `.naiteh/` aren't tracked by
/// git so they don't show up as "dirty" or get pushed to other machines.
/// An existing `.gitignore` is kept; only the missing lines are appended.
fn ensure_gitignore(vault_root: &Path) -> Result<(), AppError> {
    let path = vault_root.join(".gitignore");
    let existing = match std::fs::read(&path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let present: Vec<&str> = existing
        .lines()
        .map(|l| l.trim().trim_start_matches('/'))
        .collect();
    let missing: Vec<&str> = MACHINE_LOCAL_FILES
        .iter()
        .copied()
        .filter(|want| !present.contains(want))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut body = existing.clone();
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    if !body.is_empty() {
        body.push('\n');
    }
    body.push_str("# naiteh - machine-local state, not synced\n");
    for line in missing {
        body.push_str(line);
        body.push('\n');
    }
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

pub fn status(
    vault_root: &Path,
    last_sync: Option<i64>,
    merge_pending: bool,
) -> Result<SyncStatus, AppError> {
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
        merge_pending,
    })
}

fn current_branch_name(repo: &Repository) -> Result<String, AppError> {
    match repo.head() {
        Ok(head) => {
            if !head.is_branch() {
                return Ok("HEAD".to_string());
            }
            Ok(head.shorthand().unwrap_or("").to_string())
        }
        // Unborn branch: HEAD is a symbolic ref to a branch with no commits.
        Err(e) if e.code() == ErrorCode::UnbornBranch => {
            let name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().map(str::to_string))
                .and_then(|t| t.strip_prefix("refs/heads/").map(str::to_string))
                .unwrap_or_else(|| DEFAULT_BRANCH.to_string());
            Ok(name)
        }
        Err(e) => Err(map_git_err(e)),
    }
}

/// Uncommitted changes, ignoring conflict sidecars (they are never
/// committed — see [`stage_all`]).
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
    Ok(statuses.iter().any(|e| {
        e.status().intersects(dirty_mask)
            && !e.path().map(conflicts::is_sidecar_path).unwrap_or(false)
    }))
}

fn ahead_behind(repo: &Repository, branch: &str) -> Result<(u32, u32), AppError> {
    let local_ref = format!("refs/heads/{branch}");
    let remote_ref = tracking_ref(branch);
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

fn tracking_ref(branch: &str) -> String {
    format!("refs/remotes/{REMOTE_NAME}/{branch}")
}

// ── commit all ───────────────────────────────────────────────────────────

/// Stage the whole working tree (additions, edits, deletions) except
/// conflict sidecars, and drop machine-local state files from the index
/// if an older version committed them. Returns the staged tree's OID.
fn stage_all(repo: &Repository) -> Result<Oid, AppError> {
    let mut index = repo.index().map_err(map_git_err)?;
    let mut skip_sidecars = |path: &Path, _spec: &[u8]| -> i32 {
        if conflicts::is_sidecar_path(&path.to_string_lossy()) {
            1
        } else {
            0
        }
    };
    index
        .add_all(
            ["*"].iter(),
            git2::IndexAddOption::DEFAULT,
            Some(&mut skip_sidecars),
        )
        .map_err(map_git_err)?;
    index
        .update_all(["*"].iter(), Some(&mut skip_sidecars))
        .map_err(map_git_err)?;
    for rel in MACHINE_LOCAL_FILES {
        if index.get_path(Path::new(rel), 0).is_some() {
            index.remove_path(Path::new(rel)).map_err(map_git_err)?;
        }
    }
    index.write().map_err(map_git_err)?;
    index.write_tree().map_err(map_git_err)
}

/// Stage every change in the working tree, then create a commit. Returns
/// `Ok(false)` when the working tree was already clean (nothing committed).
pub fn commit_all(repo: &Repository, message: &str) -> Result<bool, AppError> {
    let tree_oid = stage_all(repo)?;
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
            // First commit on the current (unborn) branch.
            let branch_ref = format!("refs/heads/{}", current_branch_name(repo)?);
            repo.commit(Some(&branch_ref), &sig, &sig, message, &tree, &[])
                .map_err(map_git_err)?;
            repo.set_head(&branch_ref).map_err(map_git_err)?;
        }
    }
    Ok(true)
}

// ── pending merge (conflict convergence) ────────────────────────────────

/// Result of [`finalize_pending_merge`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FinalizeOutcome {
    /// No pull was waiting on conflicts.
    NoPending,
    /// This many sidecars of the pending pull still exist.
    StillPending(usize),
    /// All sidecars were resolved; the merge was recorded locally.
    Finalized,
}

/// If a pull stopped on conflicts and every sidecar it wrote has since
/// been resolved, record the merge: a commit whose tree is the working
/// tree (the user's resolution) and whose parents are the local head and
/// the remote commit that was being merged. When the remote commit is
/// already part of local history (joining an existing remote), a plain
/// commit is enough. Clears the pending state.
pub fn finalize_pending_merge(vault_root: &Path) -> Result<FinalizeOutcome, AppError> {
    let repo = open_repo(vault_root)?;
    finalize_pending_in(&repo, vault_root)
}

fn finalize_pending_in(repo: &Repository, vault_root: &Path) -> Result<FinalizeOutcome, AppError> {
    let state = sync_state::load(vault_root)?;
    let Some(pending) = state.pending_merge else {
        return Ok(FinalizeOutcome::NoPending);
    };
    let unresolved = pending
        .sidecars
        .iter()
        .filter(|rel| std::fs::symlink_metadata(vault_root.join(rel.as_str())).is_ok())
        .count();
    if unresolved > 0 {
        return Ok(FinalizeOutcome::StillPending(unresolved));
    }

    let remote_commit = Oid::from_str(&pending.remote_oid)
        .ok()
        .and_then(|oid| repo.find_commit(oid).ok());
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok());

    match (head_commit, remote_commit) {
        (Some(head), Some(remote))
            if head.id() != remote.id()
                && !repo
                    .graph_descendant_of(head.id(), remote.id())
                    .map_err(map_git_err)? =>
        {
            let tree_oid = stage_all(repo)?;
            let tree = repo.find_tree(tree_oid).map_err(map_git_err)?;
            let sig = signature_for(repo)?;
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                MSG_MERGE_RESOLVED,
                &tree,
                &[&head, &remote],
            )
            .map_err(map_git_err)?;
        }
        // Remote already in our history (or gone): an ordinary commit of
        // the resolved working tree is all that's left.
        _ => {
            commit_all(repo, MSG_SYNC)?;
        }
    }
    sync_state::clear_pending_merge(vault_root)?;
    Ok(FinalizeOutcome::Finalized)
}

fn unresolved_conflict_error(n: usize) -> AppError {
    AppError::Conflict(format!(
        "{n} conflicting file{} from the last sync still need a decision \
         (Keep mine / Keep theirs) before syncing again",
        if n == 1 { "" } else { "s" }
    ))
}

// ── sync phases ──────────────────────────────────────────────────────────

/// How [`prepare`] / [`integrate`] treat uncommitted local edits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalChanges {
    /// Commit them first (`sync_now`).
    Commit,
    /// Refuse with `AppError::Conflict` (`sync_pull`).
    RequireClean,
}

/// What [`prepare`] learned; handed to the later phases.
#[derive(Debug, Clone)]
pub struct SyncPlan {
    pub branch: String,
    pub has_remote: bool,
    /// Where `refs/remotes/origin/<branch>` pointed before this sync's
    /// fetch — tells "never synced" apart from "synced with some remote".
    previous_tracking: Option<Oid>,
}

/// Local, lock-holding phase 1: keep `.gitignore` complete, finish a
/// resolved pending merge (or refuse while one is unresolved), then commit
/// or refuse local edits.
pub fn prepare(vault_root: &Path, mode: LocalChanges) -> Result<SyncPlan, AppError> {
    let repo = open_repo(vault_root)?;
    ensure_gitignore(vault_root)?;
    match finalize_pending_in(&repo, vault_root)? {
        FinalizeOutcome::StillPending(n) => return Err(unresolved_conflict_error(n)),
        FinalizeOutcome::NoPending | FinalizeOutcome::Finalized => {}
    }
    handle_local_changes(&repo, mode)?;
    let branch = current_branch_name(&repo)?;
    let has_remote = repo.find_remote(REMOTE_NAME).is_ok();
    let previous_tracking = repo.refname_to_id(&tracking_ref(&branch)).ok();
    Ok(SyncPlan {
        branch,
        has_remote,
        previous_tracking,
    })
}

fn handle_local_changes(repo: &Repository, mode: LocalChanges) -> Result<(), AppError> {
    if !is_dirty(repo)? {
        return Ok(());
    }
    match mode {
        LocalChanges::Commit => {
            commit_all(repo, MSG_SYNC)?;
            Ok(())
        }
        // The checkout steps of a pull would otherwise clobber in-progress
        // edits. `sync_now` commits first; for a raw pull the user must
        // save (autosave handles this) and retry, or use "Sync now".
        LocalChanges::RequireClean => Err(AppError::Conflict(
            "vault has uncommitted changes; save your work or use \"Sync now\" instead of \"Pull\""
                .into(),
        )),
    }
}

/// Network phase (no vault lock needed): download the remote branch into
/// `refs/remotes/origin/<branch>`. Returns the remote head, or `None` when
/// the remote doesn't have the branch yet (empty destination).
pub fn fetch(vault_root: &Path, plan: &SyncPlan) -> Result<Option<Oid>, AppError> {
    let repo = open_repo(vault_root)?;
    let mut remote = repo
        .find_remote(REMOTE_NAME)
        .map_err(|_| AppError::NotFound("no backup destination configured".into()))?;
    let ctx = NetCtx::new(NETWORK_DEADLINE);
    let branch_ref = format!("refs/heads/{}", plan.branch);
    let refspec = format!("+{branch_ref}:{}", tracking_ref(&plan.branch));
    {
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(ctx.callbacks());
        opts.download_tags(AutotagOption::None);
        // Drop a tracking ref whose branch no longer exists remotely, so
        // the ref below reflects what the destination has right now.
        opts.prune(git2::FetchPrune::On);
        remote
            .fetch(&[refspec.as_str()], Some(&mut opts), Some("naiteh: fetch"))
            .map_err(|e| ctx.map_err(e, "download"))?;
    }
    // Read the result from the tracking ref the refspec updates.
    // (`Remote::list()` is not usable here: git2 0.19 hits an aborting
    // `from_raw_parts(null, 0)` precondition on an empty destination.)
    Ok(repo.refname_to_id(&tracking_ref(&plan.branch)).ok())
}

/// Local, lock-holding phase 3: bring `remote_oid` into the local branch.
///
/// - local already contains it → nothing to do;
/// - local is behind → fast-forward;
/// - diverged → three-way merge; a clean merge is committed, colliding
///   edits leave the merged result in the working tree (local version for
///   the collided files), write the remote versions as sidecars, persist
///   the pending merge and return `AppError::Conflict`;
/// - unrelated histories → if local history is only naiteh's own
///   automatic commits and was never synced, join the remote (see
///   [`is_fresh_local_history`]); otherwise a clear `AppError::Conflict`.
pub fn integrate(
    vault_root: &Path,
    plan: &SyncPlan,
    remote_oid: Oid,
    mode: LocalChanges,
) -> Result<(), AppError> {
    let repo = open_repo(vault_root)?;
    // Edits may have landed while the fetch ran unlocked.
    handle_local_changes(&repo, mode)?;
    let remote_commit = repo.find_commit(remote_oid).map_err(map_git_err)?;
    let branch_ref = format!("refs/heads/{}", plan.branch);

    let head_commit = match repo.head() {
        Ok(h) => h.peel_to_commit().map_err(map_git_err)?,
        Err(_) => {
            // Nothing committed locally (no trackable files): take the
            // remote branch as-is.
            repo.reference(&branch_ref, remote_oid, true, "naiteh: adopt remote")
                .map_err(map_git_err)?;
            repo.set_head(&branch_ref).map_err(map_git_err)?;
            repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
                .map_err(map_git_err)?;
            return Ok(());
        }
    };

    if head_commit.id() == remote_oid
        || repo
            .graph_descendant_of(head_commit.id(), remote_oid)
            .map_err(map_git_err)?
    {
        return Ok(());
    }
    if repo
        .graph_descendant_of(remote_oid, head_commit.id())
        .map_err(map_git_err)?
    {
        let mut head_ref = repo.find_reference(&branch_ref).map_err(map_git_err)?;
        head_ref
            .set_target(remote_oid, "naiteh: fast-forward")
            .map_err(map_git_err)?;
        repo.set_head(&branch_ref).map_err(map_git_err)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(map_git_err)?;
        return Ok(());
    }

    match repo.merge_base(head_commit.id(), remote_oid) {
        Ok(base_oid) => {
            let base_tree = repo
                .find_commit(base_oid)
                .and_then(|c| c.tree())
                .map_err(map_git_err)?;
            merge_into_branch(
                &repo,
                vault_root,
                &head_commit,
                &remote_commit,
                &base_tree,
                &branch_ref,
                false,
            )
        }
        Err(e) if e.code() == ErrorCode::NotFound => {
            if !is_fresh_local_history(&repo, &head_commit, plan.previous_tracking)? {
                return Err(AppError::Conflict(
                    "the backup destination holds a different vault with its own unrelated \
                     history, and this vault already has its own sync history; choose an \
                     empty destination, or join it from a new, empty vault"
                        .into(),
                ));
            }
            let empty_oid = repo
                .treebuilder(None)
                .and_then(|tb| tb.write())
                .map_err(map_git_err)?;
            let empty_tree = repo.find_tree(empty_oid).map_err(map_git_err)?;
            merge_into_branch(
                &repo,
                vault_root,
                &head_commit,
                &remote_commit,
                &empty_tree,
                &branch_ref,
                true,
            )
        }
        Err(e) => Err(map_git_err(e)),
    }
}

/// True when local history is something naiteh made on this machine
/// before ever syncing: only `naiteh: initial sync` / `naiteh: sync`
/// commits, no merges, and the remote-tracking ref (if any) isn't part of
/// it. Such a vault can safely join an existing remote; its files are
/// preserved on top of the remote history.
fn is_fresh_local_history(
    repo: &Repository,
    head: &Commit<'_>,
    previous_tracking: Option<Oid>,
) -> Result<bool, AppError> {
    if let Some(prev) = previous_tracking {
        if prev == head.id() || repo.graph_descendant_of(head.id(), prev).unwrap_or(false) {
            return Ok(false);
        }
    }
    let mut walk = repo.revwalk().map_err(map_git_err)?;
    walk.push(head.id()).map_err(map_git_err)?;
    for oid in walk {
        let oid = oid.map_err(map_git_err)?;
        let c = repo.find_commit(oid).map_err(map_git_err)?;
        if c.parent_count() > 1 {
            return Ok(false);
        }
        let msg = c.message().unwrap_or("").trim_end();
        if msg != MSG_INITIAL && msg != MSG_SYNC {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `.gitignore` and `.naiteh/*` are app-internal: their conflicts are
/// settled automatically (never shown as sidecars, which the Conflicts UI
/// couldn't reach under `.naiteh/` anyway).
fn is_internal_path(rel: &str) -> bool {
    rel == ".gitignore" || rel.starts_with(".naiteh/")
}

/// Three-way merge of `head` and `remote` over `base`. With `join` the
/// base is the empty tree (unrelated histories) and the branch ends up on
/// top of `remote` rather than as a two-parent merge.
fn merge_into_branch(
    repo: &Repository,
    vault_root: &Path,
    head: &Commit<'_>,
    remote: &Commit<'_>,
    base_tree: &Tree<'_>,
    branch_ref: &str,
    join: bool,
) -> Result<(), AppError> {
    let head_tree = head.tree().map_err(map_git_err)?;
    let remote_tree = remote.tree().map_err(map_git_err)?;
    let mut merged = repo
        .merge_trees(base_tree, &head_tree, &remote_tree, None)
        .map_err(map_git_err)?;

    // Resolve every conflict in the index — local version for user files
    // (the remote one goes to a sidecar), and remote/local for internal
    // files when joining/merging — so the index can be written as a tree.
    let sidecar_blobs = resolve_index_conflicts(&mut merged, join)?;
    let resolved_oid = merged.write_tree_to(repo).map_err(map_git_err)?;
    let resolved_tree = repo.find_tree(resolved_oid).map_err(map_git_err)?;
    let sig = signature_for(repo)?;

    if sidecar_blobs.is_empty() {
        let new_oid = if join {
            if resolved_oid == remote_tree.id() {
                remote.id()
            } else {
                repo.commit(None, &sig, &sig, MSG_JOIN, &resolved_tree, &[remote])
                    .map_err(map_git_err)?
            }
        } else {
            repo.commit(None, &sig, &sig, MSG_MERGE, &resolved_tree, &[head, remote])
                .map_err(map_git_err)?
        };
        let mut head_ref = repo.find_reference(branch_ref).map_err(map_git_err)?;
        head_ref
            .set_target(new_oid, "naiteh: merge")
            .map_err(map_git_err)?;
        repo.set_head(branch_ref).map_err(map_git_err)?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(map_git_err)?;
        return Ok(());
    }

    // Conflicts: write the remote versions first (containment-checked, no
    // working-tree change yet if any path is unsafe), then apply the
    // merged result to the working tree without moving HEAD, then persist
    // the pending merge so the next sync can record it.
    let sidecars = write_sidecars(repo, vault_root, &sidecar_blobs)?;
    repo.checkout_tree(
        resolved_tree.as_object(),
        Some(git2::build::CheckoutBuilder::new().force()),
    )
    .map_err(map_git_err)?;
    if join {
        // HEAD joins the remote history; the working tree (local files on
        // top of the remote ones) becomes the next commit once resolved.
        let mut head_ref = repo.find_reference(branch_ref).map_err(map_git_err)?;
        head_ref
            .set_target(remote.id(), "naiteh: join existing vault")
            .map_err(map_git_err)?;
    }
    // The remote's .gitignore may lack naiteh's lines.
    ensure_gitignore(vault_root)?;
    sync_state::set_pending_merge(
        vault_root,
        PendingMerge {
            remote_oid: remote.id().to_string(),
            sidecars: sidecars.clone(),
            created_at: now_secs(),
        },
    )?;
    let n = sidecars.len();
    Err(AppError::Conflict(format!(
        "remote diverged on {n} file{}; their versions saved as *.conflict-<timestamp>.md — \
         keep yours or theirs for each, then sync again",
        if n == 1 { "" } else { "s" }
    )))
}

/// Settle every conflict entry in `index` in place. Returns
/// `(rel_path, remote blob)` for each user file whose remote version must
/// be surfaced as a sidecar.
fn resolve_index_conflicts(index: &mut Index, join: bool) -> Result<Vec<(String, Oid)>, AppError> {
    let conflicts: Vec<git2::IndexConflict> = index
        .conflicts()
        .map_err(map_git_err)?
        .collect::<Result<_, _>>()
        .map_err(map_git_err)?;
    let mut sidecars = Vec::new();
    for c in conflicts {
        let path_bytes = c
            .our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map(|e| e.path.clone())
            .unwrap_or_default();
        let rel = String::from_utf8(path_bytes)
            .map_err(|_| AppError::InvalidPath("remote contains a non-UTF-8 path".into()))?;
        conflicts::check_safe_rel(&rel).map_err(|e| {
            AppError::InvalidPath(format!("remote contains an unsafe path ({e}); not merged"))
        })?;

        let internal = is_internal_path(&rel);
        let keep = if internal && join { &c.their } else { &c.our };
        // Drop the ancestor / ours / theirs stages (absent ones are fine).
        for stage in 1..=3 {
            let _ = index.remove(Path::new(&rel), stage);
        }
        if let Some(entry) = keep {
            let resolved = git2::IndexEntry {
                ctime: entry.ctime,
                mtime: entry.mtime,
                dev: entry.dev,
                ino: entry.ino,
                mode: entry.mode,
                uid: entry.uid,
                gid: entry.gid,
                file_size: entry.file_size,
                id: entry.id,
                flags: entry.flags & !INDEX_STAGE_MASK,
                flags_extended: entry.flags_extended,
                path: entry.path.clone(),
            };
            index.add(&resolved).map_err(map_git_err)?;
        }
        if internal {
            continue;
        }
        if let Some(theirs) = &c.their {
            let same = c.our.as_ref().map(|o| o.id == theirs.id).unwrap_or(false);
            if !same {
                sidecars.push((rel, theirs.id));
            }
        }
    }
    Ok(sidecars)
}

/// Write each remote blob as `<stem>.conflict-<ts>[-N].<ext>` next to its
/// original. Every target is containment-checked before anything is
/// written. Returns the vault-relative sidecar paths.
fn write_sidecars(
    repo: &Repository,
    vault_root: &Path,
    blobs: &[(String, Oid)],
) -> Result<Vec<String>, AppError> {
    let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let mut planned: Vec<(String, PathBuf, Oid)> = Vec::new();
    for (rel, oid) in blobs {
        // Probe for an unused name so two conflicts on the same path within
        // the same second don't clobber each other. The `-N` lands before
        // the extension so the sidecar parser still recovers the original.
        let mut n = None;
        let (sidecar_rel, abs) = loop {
            let candidate = sidecar_rel_path(rel, &timestamp, n);
            let abs = conflicts::safe_vault_target(vault_root, &candidate)?;
            let taken = std::fs::symlink_metadata(&abs).is_ok()
                || planned.iter().any(|(r, _, _)| r == &candidate);
            if !taken {
                break (candidate, abs);
            }
            n = Some(n.map_or(1, |k| k + 1));
        };
        planned.push((sidecar_rel, abs, *oid));
    }
    let mut written = Vec::with_capacity(planned.len());
    for (rel, abs, oid) in planned {
        let blob = repo.find_blob(oid).map_err(map_git_err)?;
        fsx::atomic_write(&abs, blob.content())?;
        written.push(rel);
    }
    Ok(written)
}

/// Build `<dir>/<stem>.conflict-<ts>[-N].<ext>` (always `/`-separated)
/// from a `/`-separated vault-relative path, falling back to appending the
/// suffix when there is no extension. `n` adds a `-N` disambiguator.
fn sidecar_rel_path(rel_path: &str, timestamp: &str, n: Option<usize>) -> String {
    let (dir, name) = match rel_path.rsplit_once('/') {
        Some((d, f)) => (Some(d), f),
        None => (None, rel_path),
    };
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, Some(e)),
        _ => (name, None),
    };
    let suffix = n.map(|n| format!("-{n}")).unwrap_or_default();
    let file = match ext {
        Some(e) => format!("{stem}.conflict-{timestamp}{suffix}.{e}"),
        None => format!("{stem}.conflict-{timestamp}{suffix}"),
    };
    match dir {
        Some(d) => format!("{d}/{file}"),
        None => file,
    }
}

/// Network phase (no vault lock needed): upload the local branch. A
/// rejected update (the destination moved on) is `AppError::Conflict`;
/// on success the remote-tracking ref is moved to what was pushed.
pub fn push(vault_root: &Path) -> Result<(), AppError> {
    let repo = open_repo(vault_root)?;
    let branch = current_branch_name(&repo)?;
    let branch_ref = format!("refs/heads/{branch}");
    let Ok(local_oid) = repo.refname_to_id(&branch_ref) else {
        // Nothing committed yet; nothing to upload.
        return Ok(());
    };
    let mut remote = repo
        .find_remote(REMOTE_NAME)
        .map_err(|_| AppError::NotFound("no backup destination configured".into()))?;
    let ctx = NetCtx::new(NETWORK_DEADLINE);
    {
        let mut opts = PushOptions::new();
        opts.remote_callbacks(ctx.callbacks());
        let refspec = format!("{branch_ref}:{branch_ref}");
        remote
            .push(&[refspec.as_str()], Some(&mut opts))
            .map_err(|e| ctx.map_err(e, "upload"))?;
    }
    let rejections = ctx.push_rejections.borrow();
    if !rejections.is_empty() {
        return Err(AppError::Conflict(format!(
            "the backup destination refused the upload ({}); sync again",
            rejections.join("; ")
        )));
    }
    repo.reference(&tracking_ref(&branch), local_oid, true, "naiteh: push")
        .map_err(map_git_err)?;
    Ok(())
}

// ── one-shot wrappers (no locking; the IPC layer runs the phases itself) ─

/// Fetch + integrate. Refuses a dirty working tree.
#[cfg(test)]
pub fn pull_ff_only(vault_root: &Path) -> Result<(), AppError> {
    let plan = prepare(vault_root, LocalChanges::RequireClean)?;
    if !plan.has_remote {
        return Err(AppError::NotFound(
            "no backup destination configured".into(),
        ));
    }
    if let Some(oid) = fetch(vault_root, &plan)? {
        integrate(vault_root, &plan, oid, LocalChanges::RequireClean)?;
    }
    Ok(())
}

/// One-shot sync: commit local changes, then (with a remote) fetch,
/// integrate and push. The IPC layer runs the same phases with the vault
/// lock held only around the local ones.
#[cfg(test)]
pub fn sync_now(vault_root: &Path) -> Result<(), AppError> {
    let plan = prepare(vault_root, LocalChanges::Commit)?;
    if !plan.has_remote {
        return Ok(());
    }
    if let Some(oid) = fetch(vault_root, &plan)? {
        integrate(vault_root, &plan, oid, LocalChanges::Commit)?;
    }
    push(vault_root)
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

    fn read(root: &Path, rel: &str) -> String {
        // Normalise line endings in case a global autocrlf applies.
        std::fs::read_to_string(root.join(rel))
            .unwrap()
            .replace("\r\n", "\n")
    }

    fn head_oid(root: &Path) -> Oid {
        Repository::open(root)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap()
    }

    fn bare_head(bare: &Path) -> Oid {
        Repository::open_bare(bare)
            .unwrap()
            .refname_to_id(&format!("refs/heads/{DEFAULT_BRANCH}"))
            .unwrap()
    }

    fn sidecars_under(root: &Path) -> Vec<conflicts::ConflictPair> {
        conflicts::list(root).unwrap()
    }

    /// A local remote "URL": the plain filesystem path, which libgit2
    /// accepts on every platform (unlike a hand-built `file://C:\...`).
    fn remote_url(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

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

        let s = status(v.path(), Some(123), false).unwrap();
        assert_eq!(
            s.remote_url.as_deref(),
            Some("https://example.com/repo.git")
        );
        assert_eq!(s.branch, DEFAULT_BRANCH);
        assert_eq!(s.ahead, 0);
        assert_eq!(s.behind, 0);
        assert!(!s.dirty);
        assert_eq!(s.last_sync, Some(123));
        assert!(!s.merge_pending);
    }

    #[test]
    fn status_marks_dirty_when_files_change() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();

        // Untracked new file.
        fsx::atomic_write(&v.path().join("notes/new.md"), b"new").unwrap();
        assert!(status(v.path(), None, false).unwrap().dirty);

        // Modify tracked file.
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x v2").unwrap();
        assert!(status(v.path(), None, false).unwrap().dirty);
    }

    #[test]
    fn status_ignores_conflict_sidecars() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();
        fsx::atomic_write(&v.path().join("notes/x.conflict-ts.md"), b"theirs").unwrap();
        assert!(!status(v.path(), None, false).unwrap().dirty);
    }

    #[test]
    fn status_returns_not_found_when_no_repo() {
        let v = tempdir().unwrap();
        let err = status(v.path(), None, false).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
    }

    #[test]
    fn sync_now_commits_local_changes_and_clears_dirty() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();

        fsx::atomic_write(&v.path().join("notes/x.md"), b"x updated").unwrap();
        assert!(status(v.path(), None, false).unwrap().dirty);

        // No remote configured → sync_now is purely a local commit.
        sync_now(v.path()).unwrap();
        assert!(!status(v.path(), None, false).unwrap().dirty);

        let repo = Repository::open(v.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
        assert_eq!(head.message(), Some(MSG_SYNC));
    }

    #[test]
    fn commit_all_stages_deletions_and_skips_sidecars() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        fsx::atomic_write(&v.path().join("notes/y.md"), b"y").unwrap();
        init(v.path()).unwrap();
        std::fs::remove_file(v.path().join("notes/y.md")).unwrap();
        fsx::atomic_write(&v.path().join("notes/x.conflict-ts.md"), b"theirs").unwrap();
        sync_now(v.path()).unwrap();
        let repo = Repository::open(v.path()).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_path(Path::new("notes/y.md")).is_err());
        assert!(tree.get_path(Path::new("notes/x.conflict-ts.md")).is_err());
        assert!(tree.get_path(Path::new("notes/x.md")).is_ok());
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
            merge_pending: true,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"remoteUrl\":\"https://example.com/repo.git\""));
        assert!(json.contains("\"lastSync\":42"));
        assert!(json.contains("\"dirty\":true"));
        assert!(json.contains("\"mergePending\":true"));
    }

    // ── .gitignore (bug: existing .gitignore skipped) ─────────────────────

    #[test]
    fn ensure_gitignore_appends_missing_lines_to_existing_file() {
        let v = tempdir().unwrap();
        fsx::atomic_write(
            &v.path().join(".gitignore"),
            b"node_modules\n/.naiteh/workspace.json",
        )
        .unwrap();
        init(v.path()).unwrap();
        let body = read(v.path(), ".gitignore");
        assert!(body.starts_with("node_modules\n/.naiteh/workspace.json\n"));
        assert!(body.contains("\n.naiteh/sync-state.json\n"));
        assert!(body.contains("\n.naiteh/tags.json\n"));
        // Already present (leading-slash form) → not duplicated.
        assert_eq!(body.matches("workspace.json").count(), 1);

        // Idempotent.
        init(v.path()).unwrap();
        assert_eq!(read(v.path(), ".gitignore"), body);
    }

    #[test]
    fn machine_local_state_is_never_committed() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join(".gitignore"), b"*.tmp\n").unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        fsx::atomic_write(&v.path().join(".naiteh/sync-state.json"), b"{}").unwrap();
        fsx::atomic_write(&v.path().join(".naiteh/config.json"), b"{}").unwrap();
        init(v.path()).unwrap();
        let repo = Repository::open(v.path()).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_path(Path::new(".naiteh/sync-state.json")).is_err());
        assert!(tree.get_path(Path::new(".naiteh/config.json")).is_ok());
    }

    #[test]
    fn previously_committed_machine_local_state_gets_untracked() {
        // Simulate an old vault whose .gitignore lacked the lines and
        // whose state file got committed.
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        fsx::atomic_write(&v.path().join(".naiteh/workspace.json"), b"{}").unwrap();
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head(DEFAULT_BRANCH);
        let repo = Repository::init_opts(v.path(), &opts).unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_all(["*"].iter(), git2::IndexAddOption::FORCE, None)
            .unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = Signature::now("t", "t@t").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "old", &tree, &[])
            .unwrap();

        sync_now(v.path()).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        assert!(tree.get_path(Path::new(".naiteh/workspace.json")).is_err());
        assert!(v.path().join(".naiteh/workspace.json").exists());
    }

    // ── credentials (bug: unbounded callback loop) ────────────────────────

    #[test]
    fn credential_planner_tries_each_method_once_then_gives_up() {
        let ssh = tempdir().unwrap();
        fsx::atomic_write(&ssh.path().join("id_ed25519"), b"k").unwrap();
        fsx::atomic_write(&ssh.path().join("id_rsa"), b"k").unwrap();
        let mut p = CredentialPlanner::new(Some(ssh.path().to_path_buf()));
        let allowed = CredentialType::SSH_KEY;
        assert_eq!(
            p.next(Some("git"), allowed),
            Some(CredStep::SshAgent("git".into()))
        );
        assert_eq!(
            p.next(Some("git"), allowed),
            Some(CredStep::SshKey(
                "git".into(),
                ssh.path().join("id_ed25519")
            ))
        );
        assert_eq!(
            p.next(Some("git"), allowed),
            Some(CredStep::SshKey("git".into(), ssh.path().join("id_rsa")))
        );
        // libgit2 keeps calling back after each rejection; we must stop.
        for _ in 0..50 {
            assert_eq!(p.next(Some("git"), allowed), None);
        }
    }

    #[test]
    fn credential_planner_sends_username_then_ssh_and_skips_missing_keys() {
        let ssh = tempdir().unwrap();
        let mut p = CredentialPlanner::new(Some(ssh.path().to_path_buf()));
        assert_eq!(
            p.next(None, CredentialType::USERNAME),
            Some(CredStep::Username("git".into()))
        );
        assert_eq!(
            p.next(None, CredentialType::SSH_KEY),
            Some(CredStep::SshAgent("git".into()))
        );
        assert_eq!(p.next(None, CredentialType::SSH_KEY), None);
    }

    #[test]
    fn credential_planner_https_uses_helper_then_default_once() {
        let mut p = CredentialPlanner::new(None);
        let allowed = CredentialType::USER_PASS_PLAINTEXT | CredentialType::DEFAULT;
        assert_eq!(p.next(None, allowed), Some(CredStep::CredentialHelper));
        assert_eq!(p.next(None, allowed), Some(CredStep::Default));
        assert_eq!(p.next(None, allowed), None);
        assert_eq!(p.next(None, allowed), None);
    }

    #[test]
    fn credential_callback_is_bounded_end_to_end() {
        // Drive the real callback the way libgit2 does on repeated
        // rejection; it must error out after finitely many calls.
        // SSH only: the credential-helper step could launch a real helper
        // (and its UI) on a developer machine.
        let ctx = NetCtx::new(Duration::from_secs(60));
        let allowed = CredentialType::SSH_KEY;
        let mut calls = 0;
        loop {
            calls += 1;
            assert!(calls <= MAX_CREDENTIAL_CALLS + 1, "callback looped");
            if ctx
                .credential("ssh://git@example.invalid/x.git", Some("git"), allowed)
                .is_err()
            {
                break;
            }
        }
        assert!(ctx.auth_exhausted.get());
        let err = ctx.map_err(git2::Error::from_str("boom"), "download");
        assert!(matches!(err, AppError::Unauthorized(_)), "{err:?}");
    }

    #[test]
    fn expired_deadline_aborts_and_maps_to_network_timeout() {
        let ctx = NetCtx::new(Duration::from_secs(0));
        assert!(!ctx.within_deadline());
        let err = ctx.map_err(git2::Error::from_str("cancelled"), "download");
        match err {
            AppError::Network(m) => assert!(m.contains("timed out"), "{m}"),
            other => panic!("expected Network, got {other:?}"),
        }
    }

    // ── pull / conflict capture ───────────────────────────────────────────

    /// Set up a bare "remote" plus two working vaults sharing it, without
    /// touching the network. Returns (`local`, `remote_bare`, `seed`).
    /// Both have the initial commit on `main` containing `notes/x.md = "v0"`,
    /// and both `origin`s point at `remote_bare`.
    fn diverged_pair() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
        let remote_bare = tempdir().unwrap();
        let mut bare_opts = git2::RepositoryInitOptions::new();
        bare_opts.bare(true).initial_head(DEFAULT_BRANCH);
        Repository::init_opts(remote_bare.path(), &bare_opts).unwrap();

        // Seed via a working vault, then push.
        let seed = tempdir().unwrap();
        fsx::atomic_write(&seed.path().join("notes/x.md"), b"v0\n").unwrap();
        init(seed.path()).unwrap();
        set_remote(seed.path(), &remote_url(remote_bare.path())).unwrap();
        push(seed.path()).unwrap();

        // Local clone of the remote.
        let local = tempdir().unwrap();
        Repository::clone(&remote_url(remote_bare.path()), local.path()).unwrap();
        init(local.path()).unwrap();

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
        assert_eq!(read(local.path(), "notes/x.md"), "v1\n");
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

        // Local copy untouched.
        assert_eq!(read(local.path(), "notes/x.md"), "local v1\n");
        // Their version landed on disk next to it.
        let pairs = sidecars_under(local.path());
        assert_eq!(pairs.len(), 1, "exactly one conflict capture file");
        assert_eq!(pairs[0].rel_path, "notes/x.md");
        assert_eq!(
            read(local.path(), &pairs[0].conflict_rel_path),
            "remote v1\n"
        );
        assert!(sync_state::load(local.path())
            .unwrap()
            .pending_merge
            .is_some());
    }

    // ── conflict convergence (bug: Keep mine never ends a conflict) ──────

    /// Diverge `notes/x.md` on both sides (remote also adds an unrelated
    /// file), sync `local`, and return after the conflict was recorded.
    fn conflicted_sync() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir, Oid) {
        let (local, remote, seed) = diverged_pair();
        fsx::atomic_write(&local.path().join("notes/x.md"), b"local v1\n").unwrap();
        fsx::atomic_write(&seed.path().join("notes/x.md"), b"remote v1\n").unwrap();
        fsx::atomic_write(&seed.path().join("notes/remote-only.md"), b"r\n").unwrap();
        sync_now(seed.path()).unwrap();
        let remote_head = bare_head(remote.path());

        let err = sync_now(local.path()).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
        // Non-colliding remote change is already in the working tree.
        assert_eq!(read(local.path(), "notes/remote-only.md"), "r\n");
        assert_eq!(read(local.path(), "notes/x.md"), "local v1\n");
        assert_eq!(sidecars_under(local.path()).len(), 1);
        (local, remote, seed, remote_head)
    }

    fn assert_converged(local: &Path, remote: &Path, seed: &Path, remote_head: Oid, x: &str) {
        let repo = Repository::open(local).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2, "expected a merge commit");
        assert_eq!(head.parent_id(1).unwrap(), remote_head);
        let tree = head.tree().unwrap();
        assert!(tree.get_path(Path::new("notes/remote-only.md")).is_ok());
        assert!(sidecars_under(local).is_empty());
        assert!(sync_state::load(local).unwrap().pending_merge.is_none());
        // Pushed.
        assert_eq!(bare_head(remote), head.id());
        assert_eq!(read(local, "notes/x.md"), x);
        // Other machine fast-forwards to the same content.
        sync_now(seed).unwrap();
        assert_eq!(read(seed, "notes/x.md"), x);
        assert_eq!(head_oid(seed), head.id());
        let s = status(local, None, false).unwrap();
        assert_eq!((s.ahead, s.behind, s.dirty), (0, 0, false));
    }

    #[test]
    fn keep_mine_then_sync_records_merge_and_pushes() {
        let (local, remote, seed, remote_head) = conflicted_sync();

        // Syncing again before resolving: refused, no new sidecar.
        let err = sync_now(local.path()).unwrap_err();
        match err {
            AppError::Conflict(m) => assert!(m.contains("need a decision"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(sidecars_under(local.path()).len(), 1);
        assert_eq!(bare_head(remote.path()), remote_head);

        let sidecar = sidecars_under(local.path())[0].conflict_rel_path.clone();
        conflicts::resolve_keep_ours(local.path(), &sidecar).unwrap();
        sync_now(local.path()).unwrap();
        assert_converged(
            local.path(),
            remote.path(),
            seed.path(),
            remote_head,
            "local v1\n",
        );
    }

    #[test]
    fn keep_theirs_then_sync_converges() {
        let (local, remote, seed, remote_head) = conflicted_sync();
        let sidecar = sidecars_under(local.path())[0].conflict_rel_path.clone();
        conflicts::resolve_keep_theirs(local.path(), &sidecar).unwrap();
        sync_now(local.path()).unwrap();
        assert_converged(
            local.path(),
            remote.path(),
            seed.path(),
            remote_head,
            "remote v1\n",
        );
    }

    #[test]
    fn hand_edit_then_keep_mine_converges_and_finalize_works_offline() {
        let (local, remote, seed, remote_head) = conflicted_sync();
        fsx::atomic_write(&local.path().join("notes/x.md"), b"merged by hand\n").unwrap();
        let sidecar = sidecars_under(local.path())[0].conflict_rel_path.clone();
        conflicts::resolve_keep_ours(local.path(), &sidecar).unwrap();
        // Finalizing locally (what the resolve commands do) records the
        // merge without the network.
        assert_eq!(
            finalize_pending_merge(local.path()).unwrap(),
            FinalizeOutcome::Finalized
        );
        assert_eq!(
            finalize_pending_merge(local.path()).unwrap(),
            FinalizeOutcome::NoPending
        );
        sync_now(local.path()).unwrap();
        assert_converged(
            local.path(),
            remote.path(),
            seed.path(),
            remote_head,
            "merged by hand\n",
        );
    }

    #[test]
    fn finalize_reports_still_pending_while_sidecars_exist() {
        let (local, _remote, _seed, _) = conflicted_sync();
        assert_eq!(
            finalize_pending_merge(local.path()).unwrap(),
            FinalizeOutcome::StillPending(1)
        );
    }

    // ── joining an existing remote (bug: "no merge base") ─────────────────

    /// Machine 1 creates and pushes a vault; returns (`bare`, `machine1`).
    fn existing_remote() -> (tempfile::TempDir, tempfile::TempDir) {
        let bare = tempdir().unwrap();
        let mut bare_opts = git2::RepositoryInitOptions::new();
        bare_opts.bare(true).initial_head(DEFAULT_BRANCH);
        Repository::init_opts(bare.path(), &bare_opts).unwrap();
        let m1 = tempdir().unwrap();
        fsx::atomic_write(&m1.path().join("notes/shared.md"), b"from m1\n").unwrap();
        fsx::atomic_write(&m1.path().join(".naiteh/config.json"), b"{\"m\":1}\n").unwrap();
        init(m1.path()).unwrap();
        set_remote(m1.path(), &remote_url(bare.path())).unwrap();
        sync_now(m1.path()).unwrap();
        (bare, m1)
    }

    #[test]
    fn second_machine_joins_existing_remote_and_keeps_its_files() {
        let (bare, m1) = existing_remote();
        let m1_head = bare_head(bare.path());

        let m2 = tempdir().unwrap();
        fsx::atomic_write(&m2.path().join("notes/own.md"), b"from m2\n").unwrap();
        fsx::atomic_write(&m2.path().join(".naiteh/config.json"), b"{\"m\":2}\n").unwrap();
        init(m2.path()).unwrap();
        set_remote(m2.path(), &remote_url(bare.path())).unwrap();
        // An edit made before the first sync becomes a "naiteh: sync" commit.
        fsx::atomic_write(&m2.path().join("notes/own2.md"), b"more\n").unwrap();
        sync_now(m2.path()).unwrap();

        assert_eq!(read(m2.path(), "notes/shared.md"), "from m1\n");
        assert_eq!(read(m2.path(), "notes/own.md"), "from m2\n");
        // Internal config: the existing vault's wins when joining.
        assert_eq!(read(m2.path(), ".naiteh/config.json"), "{\"m\":1}\n");
        let repo = Repository::open(m2.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_ids().collect::<Vec<_>>(), vec![m1_head]);
        assert_eq!(bare_head(bare.path()), head.id());

        // Machine 1 picks up machine 2's notes by fast-forward.
        sync_now(m1.path()).unwrap();
        assert_eq!(read(m1.path(), "notes/own.md"), "from m2\n");
        assert_eq!(head_oid(m1.path()), head.id());
    }

    #[test]
    fn joining_with_a_colliding_file_surfaces_a_sidecar_then_converges() {
        let (bare, m1) = existing_remote();
        let m1_head = bare_head(bare.path());

        let m2 = tempdir().unwrap();
        fsx::atomic_write(&m2.path().join("notes/shared.md"), b"m2 version\n").unwrap();
        init(m2.path()).unwrap();
        set_remote(m2.path(), &remote_url(bare.path())).unwrap();
        let err = sync_now(m2.path()).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
        // Remote untouched until resolved.
        assert_eq!(bare_head(bare.path()), m1_head);
        assert_eq!(read(m2.path(), "notes/shared.md"), "m2 version\n");
        let pairs = sidecars_under(m2.path());
        assert_eq!(pairs.len(), 1);
        assert_eq!(read(m2.path(), &pairs[0].conflict_rel_path), "from m1\n");
        assert!(sync_state::load(m2.path()).unwrap().pending_merge.is_some());

        conflicts::resolve_keep_theirs(m2.path(), &pairs[0].conflict_rel_path).unwrap();
        sync_now(m2.path()).unwrap();
        let repo = Repository::open(m2.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert!(repo.graph_descendant_of(head.id(), m1_head).unwrap() || head.id() == m1_head);
        assert_eq!(bare_head(bare.path()), head.id());
        assert_eq!(read(m2.path(), "notes/shared.md"), "from m1\n");
        assert!(sidecars_under(m2.path()).is_empty());
        let gi = read(m2.path(), ".gitignore");
        for line in MACHINE_LOCAL_FILES {
            assert!(gi.contains(line));
        }
        sync_now(m1.path()).unwrap();
        assert_eq!(head_oid(m1.path()), head.id());
    }

    #[test]
    fn unrelated_history_with_real_local_history_is_a_clear_error() {
        let (bare, _m1) = existing_remote();
        let m2 = tempdir().unwrap();
        fsx::atomic_write(&m2.path().join("notes/own.md"), b"mine\n").unwrap();
        init(m2.path()).unwrap();
        commit_change(m2.path(), "notes/own.md", b"edited\n", "my own commit");
        set_remote(m2.path(), &remote_url(bare.path())).unwrap();
        let err = sync_now(m2.path()).unwrap_err();
        match err {
            AppError::Conflict(m) => assert!(m.contains("unrelated history"), "{m}"),
            other => panic!("expected Conflict, got {other:?}"),
        }
        assert!(sidecars_under(m2.path()).is_empty());
    }

    #[test]
    fn vault_that_synced_elsewhere_does_not_silently_join_another_remote() {
        let (bare_b, _m1) = existing_remote();
        // m2 syncs with its own remote A first...
        let bare_a = tempdir().unwrap();
        let mut bare_opts = git2::RepositoryInitOptions::new();
        bare_opts.bare(true).initial_head(DEFAULT_BRANCH);
        Repository::init_opts(bare_a.path(), &bare_opts).unwrap();
        let m2 = tempdir().unwrap();
        fsx::atomic_write(&m2.path().join("notes/own.md"), b"mine\n").unwrap();
        init(m2.path()).unwrap();
        set_remote(m2.path(), &remote_url(bare_a.path())).unwrap();
        sync_now(m2.path()).unwrap();
        // ...then gets pointed at an unrelated vault B.
        set_remote(m2.path(), &remote_url(bare_b.path())).unwrap();
        let err = sync_now(m2.path()).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "{err:?}");
    }

    #[test]
    fn first_sync_into_an_empty_remote_pushes() {
        let bare = tempdir().unwrap();
        let mut bare_opts = git2::RepositoryInitOptions::new();
        bare_opts.bare(true).initial_head(DEFAULT_BRANCH);
        Repository::init_opts(bare.path(), &bare_opts).unwrap();
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();
        set_remote(v.path(), &remote_url(bare.path())).unwrap();
        sync_now(v.path()).unwrap();
        assert_eq!(bare_head(bare.path()), head_oid(v.path()));
    }

    // ── sidecar paths / containment ──────────────────────────────────────

    #[test]
    fn sidecar_rel_path_keeps_extension_and_directory() {
        let p = sidecar_rel_path("notes/work/standup.md", "2026-05-09T10-00-00", None);
        assert_eq!(p, "notes/work/standup.conflict-2026-05-09T10-00-00.md");
        // Separator-agnostic when joined onto a vault root.
        let v = tempdir().unwrap();
        assert_eq!(
            v.path().join(&p).strip_prefix(v.path()).unwrap(),
            Path::new("notes/work/standup.conflict-2026-05-09T10-00-00.md")
        );
    }

    #[test]
    fn sidecar_rel_path_handles_extension_less_files() {
        assert_eq!(
            sidecar_rel_path("notes/README", "ts", None),
            "notes/README.conflict-ts"
        );
        assert_eq!(sidecar_rel_path(".env", "ts", None), ".env.conflict-ts");
    }

    #[test]
    fn sidecar_rel_path_inserts_collision_suffix_before_extension() {
        // `-N` lands before the extension so the sidecar parser still
        // recovers `standup.md` as the original (timestamp is opaque).
        assert_eq!(
            sidecar_rel_path("notes/work/standup.md", "ts", Some(2)),
            "notes/work/standup.conflict-ts-2.md"
        );
    }

    #[test]
    fn write_sidecars_rejects_paths_escaping_the_vault() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();
        let repo = Repository::open(v.path()).unwrap();
        let blob = repo.blob(b"evil").unwrap();
        for bad in [
            "../escape.md",
            ".git/hooks/pre-commit",
            "/abs.md",
            "a/.Git/x",
        ] {
            let err = write_sidecars(&repo, v.path(), &[(bad.to_string(), blob)]).unwrap_err();
            assert!(matches!(err, AppError::InvalidPath(_)), "{bad}: {err:?}");
        }
        assert!(conflicts::list(v.path()).unwrap().is_empty());
        assert!(!v
            .path()
            .parent()
            .unwrap()
            .join("escape.conflict-ts.md")
            .exists());
    }

    #[test]
    fn write_sidecars_does_not_clobber_existing_sidecars() {
        let v = tempdir().unwrap();
        fsx::atomic_write(&v.path().join("notes/x.md"), b"x").unwrap();
        init(v.path()).unwrap();
        let repo = Repository::open(v.path()).unwrap();
        let a = repo.blob(b"a").unwrap();
        let b = repo.blob(b"b").unwrap();
        let written = write_sidecars(
            &repo,
            v.path(),
            &[("notes/x.md".into(), a), ("notes/x.md".into(), b)],
        )
        .unwrap();
        assert_eq!(written.len(), 2);
        assert_ne!(written[0], written[1]);
        assert_eq!(read(v.path(), &written[0]), "a");
        assert_eq!(read(v.path(), &written[1]), "b");
    }
}
