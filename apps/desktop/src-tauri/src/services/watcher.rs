//! External file-change detection for the active vault.
//!
//! The vault folder is typically mirrored by Google Drive for desktop
//! (and may be synced to a second PC), so files change on disk while the
//! app runs. This module watches the active vault root recursively with
//! the `notify` crate, debounces the raw OS events into batches, maps
//! them to vault-relative paths, drops noise (`.naiteh/`, `.git/`, our
//! own temp files, Drive / OS junk), tags each change as naiteh's own or
//! external (`services::own_changes`), and emits one `vault:changed`
//! event per batch. If the native watcher cannot start it falls back to
//! `notify`'s polling watcher; only when both fail does it emit
//! `vault:watch-error`. See vault/wiki/ipc-api.md ("Events") and
//! vault/wiki/concurrency-safety.md ("External change detection").
//!
//! Threading / locking: the watcher runs on its own OS thread (never the
//! async runtime), emits through an `AppHandle`, and **never takes the
//! vault lock** — it only reads the own-change registry (a short
//! `std::sync::Mutex`) and bumps the tag index generation. Emission is
//! abstracted behind [`ChangeSink`] so tests drive it with a channel.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::event::{ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::domain::{ChangeKind, VaultChange, VaultChanged, VaultWatchError};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::index::TagIndex;
use crate::services::notes::canonicalize_lenient;
use crate::services::own_changes;

/// Event channel names (frontend `listen` targets).
pub const CHANGED_EVENT: &str = "vault:changed";
pub const WATCH_ERROR_EVENT: &str = "vault:watch-error";

/// A batch closes this long after its first raw event.
pub const DEBOUNCE: Duration = Duration::from_millis(400);
/// Scan interval of the fallback polling watcher.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// How often an idle watcher thread checks its stop flag.
const IDLE_TICK: Duration = Duration::from_millis(250);

// ── sink ─────────────────────────────────────────────────────────────────

/// Where batches go. The app emits Tauri events; tests use a channel.
pub trait ChangeSink: Send + Sync + 'static {
    fn changed(&self, batch: VaultChanged);
    fn watch_error(&self, err: VaultWatchError);
}

/// Emits to every window through the app handle.
pub struct AppSink<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> ChangeSink for AppSink<R> {
    fn changed(&self, batch: VaultChanged) {
        let _ = self.0.emit(CHANGED_EVENT, batch);
    }

    fn watch_error(&self, err: VaultWatchError) {
        let _ = self.0.emit(WATCH_ERROR_EVENT, err);
    }
}

// ── managed state ────────────────────────────────────────────────────────

/// Tauri-managed handle to the (at most one) running vault watcher.
/// `start` replaces the previous watcher; the old thread notices its stop
/// flag within [`IDLE_TICK`] and exits. A late batch from an old thread
/// still carries its own `vaultRoot`, so the frontend can ignore it.
#[derive(Default)]
pub struct VaultWatcher {
    current: Mutex<Option<Arc<AtomicBool>>>,
}

impl VaultWatcher {
    /// Watch `root` recursively, replacing any running watcher. Failures
    /// to start are reported through `sink.watch_error`, never returned.
    pub fn start(&self, root: PathBuf, sink: Arc<dyn ChangeSink>, index: TagIndex) {
        self.stop();
        let root_str = root.to_string_lossy().to_string();
        let fail = |message: String| {
            sink.watch_error(VaultWatchError {
                vault_root: root_str.clone(),
                message,
            })
        };
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let watcher = match open_watcher(&root, tx) {
            Ok(w) => w,
            Err(message) => {
                fail(message);
                return;
            }
        };
        let stop = Arc::new(AtomicBool::new(false));
        *self.lock() = Some(stop.clone());
        let ctx = Context {
            root,
            root_str: root_str.clone(),
            sink: sink.clone(),
            index,
            stop,
        };
        let spawned = thread::Builder::new()
            .name("naiteh-vault-watcher".into())
            .spawn(move || {
                // The watcher object must outlive the loop: dropping it
                // unwatches and closes the channel.
                let _keep = watcher;
                run_loop(ctx, rx);
            });
        if let Err(e) = spawned {
            *self.lock() = None;
            fail(format!("could not start the watcher thread: {e}"));
        }
    }

    /// Stop the running watcher, if any.
    pub fn stop(&self) {
        if let Some(stop) = self.lock().take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Arc<AtomicBool>>> {
        self.current.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// (Re)start the managed watcher on `root`, emitting through `app`.
/// Called wherever the active vault changes.
pub fn restart<R: Runtime>(app: &AppHandle<R>, root: PathBuf) {
    let watcher = app.state::<VaultWatcher>();
    let index = app.state::<TagIndex>().inner().clone();
    watcher.start(root, Arc::new(AppSink(app.clone())), index);
}

/// Start the watcher for the configured active vault (app setup). No
/// active vault → nothing to watch yet.
pub fn restart_for_active_vault<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(root) = config::current_vault_root() {
        restart(app, root);
    }
}

// ── notify plumbing ──────────────────────────────────────────────────────

type BoxedWatcher = Box<dyn Watcher + Send>;

/// Native watcher first; on any failure to create or arm it, the polling
/// watcher. `Err` only when both fail.
fn open_watcher(root: &Path, tx: Sender<notify::Result<Event>>) -> Result<BoxedWatcher, String> {
    let poll_tx = tx.clone();
    let native = RecommendedWatcher::new(tx, Config::default()).and_then(|mut w| {
        w.watch(root, RecursiveMode::Recursive)?;
        Ok(w)
    });
    let native_err = match native {
        Ok(w) => return Ok(Box::new(w)),
        Err(e) => e,
    };
    let poll = PollWatcher::new(poll_tx, Config::default().with_poll_interval(POLL_INTERVAL))
        .and_then(|mut w| {
            w.watch(root, RecursiveMode::Recursive)?;
            Ok(w)
        });
    match poll {
        Ok(w) => Ok(Box::new(w)),
        Err(poll_err) => Err(format!(
            "native watcher: {native_err}; polling watcher: {poll_err}"
        )),
    }
}

struct Context {
    root: PathBuf,
    root_str: String,
    sink: Arc<dyn ChangeSink>,
    index: TagIndex,
    stop: Arc<AtomicBool>,
}

fn run_loop(ctx: Context, rx: mpsc::Receiver<notify::Result<Event>>) {
    // Prefix stripping happens in canonical space: Windows reports paths
    // with arbitrary case or 8.3 short names.
    let canon_root = ctx.root.canonicalize().unwrap_or_else(|_| ctx.root.clone());
    let mut pending: Vec<(PathBuf, RawKind)> = Vec::new();
    let mut overflow = false;
    let mut deadline: Option<Instant> = None;

    loop {
        if ctx.stop.load(Ordering::SeqCst) {
            return;
        }
        let timeout = match deadline {
            Some(d) => d.saturating_duration_since(Instant::now()),
            None => IDLE_TICK,
        };
        match rx.recv_timeout(timeout) {
            Ok(Ok(event)) => {
                if event.need_rescan() {
                    overflow = true;
                }
                pending.extend(raw_changes(&event));
                deadline.get_or_insert_with(|| Instant::now() + DEBOUNCE);
            }
            Ok(Err(_)) => {
                // The backend lost track of something; the frontend
                // refreshes everything. If the root itself is gone there
                // is nothing left to watch.
                if !ctx.root.is_dir() {
                    ctx.sink.watch_error(VaultWatchError {
                        vault_root: ctx.root_str.clone(),
                        message: "the vault folder is no longer accessible".into(),
                    });
                    return;
                }
                overflow = true;
                deadline.get_or_insert_with(|| Instant::now() + DEBOUNCE);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if !ctx.stop.load(Ordering::SeqCst) {
                    ctx.sink.watch_error(VaultWatchError {
                        vault_root: ctx.root_str.clone(),
                        message: "the file watcher stopped unexpectedly".into(),
                    });
                }
                return;
            }
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            flush(&ctx, &canon_root, std::mem::take(&mut pending), overflow);
            overflow = false;
            deadline = None;
        }
    }
}

/// Turn one debounce window of raw events into a `vault:changed` batch.
fn flush(ctx: &Context, canon_root: &Path, pending: Vec<(PathBuf, RawKind)>, overflow: bool) {
    let rel_raw: Vec<(String, RawKind)> = pending
        .iter()
        .filter_map(|(abs, kind)| to_rel(canon_root, abs).map(|rel| (rel, *kind)))
        .filter(|(rel, _)| !is_ignored(rel))
        .collect();
    let root = &ctx.root;
    let coalesced = coalesce(rel_raw, |rel| {
        std::fs::symlink_metadata(join_rel(root, rel)).is_ok()
    });
    let changes: Vec<VaultChange> = coalesced
        .into_iter()
        .map(|(rel, kind)| VaultChange {
            own: own_changes::is_own(&join_rel(root, &rel)),
            rel_path: rel,
            kind,
        })
        .collect();
    if changes.is_empty() && !overflow {
        return;
    }
    // Any change (own or external) makes the vault due for auto backup.
    crate::services::backup::note_vault_changed();
    if overflow || changes.iter().any(|c| !c.own) {
        ctx.index.invalidate(root);
    }
    ctx.sink.changed(VaultChanged {
        vault_root: ctx.root_str.clone(),
        changes,
        overflow,
    });
}

fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut p = root.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p
}

// ── pure pieces (unit-tested) ────────────────────────────────────────────

/// What a single raw OS event says about one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawKind {
    Created,
    Modified,
    Removed,
    /// The backend didn't say (generic / unknown rename); decided by
    /// whether the path exists when the batch closes.
    Any,
}

/// Map a `notify` event to per-path raw kinds. Renames become
/// `Removed(old)` + `Created(new)`; access events are dropped.
pub fn raw_changes(event: &Event) -> Vec<(PathBuf, RawKind)> {
    let all = |kind: RawKind| -> Vec<(PathBuf, RawKind)> {
        event.paths.iter().map(|p| (p.clone(), kind)).collect()
    };
    match &event.kind {
        EventKind::Access(_) => Vec::new(),
        EventKind::Create(_) => all(RawKind::Created),
        EventKind::Remove(_) => all(RawKind::Removed),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => all(RawKind::Removed),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => all(RawKind::Created),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => vec![
            (event.paths[0].clone(), RawKind::Removed),
            (event.paths[1].clone(), RawKind::Created),
        ],
        EventKind::Modify(ModifyKind::Name(_)) => all(RawKind::Any),
        EventKind::Modify(_) => all(RawKind::Modified),
        EventKind::Any | EventKind::Other => all(RawKind::Any),
    }
}

/// Vault-relative normal form (`/`-separated) of `abs`, or `None` when
/// the path cannot be placed under the canonical root (outside it, the
/// root itself, a non-UTF-8 name). The existing part of `abs` is
/// canonicalized first so a different-case or 8.3 spelling (Windows)
/// still strips cleanly.
pub fn to_rel(canon_root: &Path, abs: &Path) -> Option<String> {
    let canon = canonicalize_lenient(abs)?;
    let rel = canon.strip_prefix(canon_root).ok()?;
    let mut parts: Vec<&str> = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?),
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Paths the watcher never reports: anything under `.naiteh/` or
/// `.git/` (any depth, case-insensitive), and names matching
/// [`is_ignored_name`].
pub fn is_ignored(rel: &str) -> bool {
    let mut name = rel;
    for comp in rel.split('/') {
        if comp.eq_ignore_ascii_case(".naiteh") || comp.eq_ignore_ascii_case(".git") {
            return true;
        }
        name = comp;
    }
    is_ignored_name(name)
}

/// File / folder names that are never note content: naiteh's own
/// atomic-write and case-rename temp files (`.<name>.tmp.<suffix>`,
/// `.<name>.rename.<suffix>`), OS metadata files (`desktop.ini`,
/// `Thumbs.db`, `.DS_Store`), Office lock files (`~$…`, `.~lock.…`),
/// in-progress downloads / temps (`*.tmp`, `*.crdownload`) and Google
/// Docs placeholders (`*.gdoc`, `*.gsheet`, `*.gslides`).
pub fn is_ignored_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(lower.as_str(), "desktop.ini" | "thumbs.db" | ".ds_store") {
        return true;
    }
    if name.starts_with("~$") || name.starts_with(".~lock.") {
        return true;
    }
    if name.starts_with('.')
        && (name.contains(fsx::TMP_MARKER) || name.contains(fsx::RENAME_MARKER))
    {
        return true;
    }
    [".tmp", ".crdownload", ".gdoc", ".gsheet", ".gslides"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

#[derive(Default)]
struct Seen {
    created: bool,
    removed: bool,
}

/// Collapse a batch to one entry per path (first-seen order). The final
/// kind is decided by what the OS reported **and** whether the path
/// exists when the batch closes (`exists`):
///
/// - path gone → `removed` (whatever else was reported);
/// - path present and the batch had both a create and a remove for it
///   (replace / delete-and-recreate) → `modified`;
/// - path present with a create → `created`;
/// - otherwise (`modified`, a stray `removed` for a present path, or an
///   undecided kind) → `modified`.
pub fn coalesce(
    raw: Vec<(String, RawKind)>,
    exists: impl Fn(&str) -> bool,
) -> Vec<(String, ChangeKind)> {
    let mut order: Vec<String> = Vec::new();
    let mut seen: HashMap<String, Seen> = HashMap::new();
    for (rel, kind) in raw {
        let entry = seen.entry(rel.clone()).or_insert_with(|| {
            order.push(rel.clone());
            Seen::default()
        });
        match kind {
            RawKind::Created => entry.created = true,
            RawKind::Removed => entry.removed = true,
            RawKind::Modified | RawKind::Any => {}
        }
    }
    order
        .into_iter()
        .map(|rel| {
            let s = &seen[&rel];
            let kind = if !exists(&rel) {
                ChangeKind::Removed
            } else if s.created && s.removed {
                ChangeKind::Modified
            } else if s.created {
                ChangeKind::Created
            } else {
                ChangeKind::Modified
            };
            (rel, kind)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::mpsc::Receiver;
    use tempfile::tempdir;

    // ── pure pieces ───────────────────────────────────────────────────

    #[test]
    fn ignores_internal_dirs_temp_files_and_junk() {
        for rel in [
            ".naiteh/config.json",
            ".NAITEH/workspace.json",
            ".git/HEAD",
            "notes/.git/config",
            "notes/.x.md.tmp.123-456-7",
            "notes/.Note.md.rename.1-2-3",
            "notes/desktop.ini",
            "notes/Thumbs.db",
            "notes/THUMBS.DB",
            "notes/.DS_Store",
            "notes/~$draft.docx",
            "notes/.~lock.plan.odt#",
            "notes/scratch.tmp",
            "notes/scratch.TMP",
            "notes/big.zip.crdownload",
            "notes/sheet.gsheet",
            "notes/doc.gdoc",
            "notes/deck.gslides",
        ] {
            assert!(is_ignored(rel), "{rel} should be ignored");
        }
        for rel in [
            "notes/a.md",
            "notes/.gitignore-notes.md",
            "notes/tmp/a.md",
            "notes/gdoc-notes.md",
            "journal/2026/05/2026-05-09.md",
            "attachments/x.png",
            "notes/work",
            ".github/x.md",
        ] {
            assert!(!is_ignored(rel), "{rel} should not be ignored");
        }
    }

    #[test]
    fn coalesce_keeps_one_entry_per_path_in_first_seen_order() {
        let present: HashSet<&str> = ["a.md", "b.md", "d.md", "e.md"].into_iter().collect();
        let exists = |rel: &str| present.contains(rel);
        let raw = vec![
            ("a.md".to_string(), RawKind::Created),
            ("b.md".to_string(), RawKind::Modified),
            ("a.md".to_string(), RawKind::Modified),
            ("c.md".to_string(), RawKind::Removed),
            ("d.md".to_string(), RawKind::Removed),
            ("d.md".to_string(), RawKind::Created),
            ("e.md".to_string(), RawKind::Any),
            ("f.md".to_string(), RawKind::Created),
            ("f.md".to_string(), RawKind::Removed),
        ];
        let out = coalesce(raw, exists);
        assert_eq!(
            out,
            vec![
                // create + later modify, still present → created
                ("a.md".to_string(), ChangeKind::Created),
                ("b.md".to_string(), ChangeKind::Modified),
                ("c.md".to_string(), ChangeKind::Removed),
                // remove + create, present → modified (replaced)
                ("d.md".to_string(), ChangeKind::Modified),
                // undecided but present → modified
                ("e.md".to_string(), ChangeKind::Modified),
                // create + remove, gone → removed
                ("f.md".to_string(), ChangeKind::Removed),
            ]
        );
    }

    #[test]
    fn coalesce_trusts_existence_over_reported_kind() {
        // Reported created but already gone → removed; reported removed
        // but present → modified.
        let out = coalesce(
            vec![
                ("gone.md".to_string(), RawKind::Created),
                ("back.md".to_string(), RawKind::Removed),
            ],
            |rel| rel == "back.md",
        );
        assert_eq!(
            out,
            vec![
                ("gone.md".to_string(), ChangeKind::Removed),
                ("back.md".to_string(), ChangeKind::Modified),
            ]
        );
    }

    #[test]
    fn raw_changes_maps_renames_to_removed_plus_created() {
        let ev = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path(PathBuf::from("/v/old.md"))
            .add_path(PathBuf::from("/v/new.md"));
        assert_eq!(
            raw_changes(&ev),
            vec![
                (PathBuf::from("/v/old.md"), RawKind::Removed),
                (PathBuf::from("/v/new.md"), RawKind::Created),
            ]
        );
        let ev = Event::new(EventKind::Access(notify::event::AccessKind::Any))
            .add_path(PathBuf::from("/v/a.md"));
        assert!(raw_changes(&ev).is_empty());
        let ev = Event::new(EventKind::Modify(ModifyKind::Data(
            notify::event::DataChange::Any,
        )))
        .add_path(PathBuf::from("/v/a.md"));
        assert_eq!(
            raw_changes(&ev),
            vec![(PathBuf::from("/v/a.md"), RawKind::Modified)]
        );
    }

    #[test]
    fn to_rel_normalizes_separators_and_drops_outsiders() {
        let v = tempdir().unwrap();
        std::fs::create_dir_all(v.path().join("notes/sub")).unwrap();
        let canon_root = v.path().canonicalize().unwrap();
        // Existing nested file.
        std::fs::write(v.path().join("notes/sub/a.md"), b"x").unwrap();
        assert_eq!(
            to_rel(&canon_root, &v.path().join("notes/sub/a.md")).as_deref(),
            Some("notes/sub/a.md")
        );
        // Not-yet / no-longer existing tail.
        assert_eq!(
            to_rel(&canon_root, &v.path().join("notes/sub/gone.md")).as_deref(),
            Some("notes/sub/gone.md")
        );
        // The root itself and anything outside are dropped.
        assert!(to_rel(&canon_root, v.path()).is_none());
        let outside = tempdir().unwrap();
        assert!(to_rel(&canon_root, &outside.path().join("x.md")).is_none());
        if cfg!(windows) {
            // Different case still strips (canonical spelling wins).
            let upper =
                PathBuf::from(v.path().to_string_lossy().to_uppercase()).join("notes/sub/a.md");
            assert_eq!(
                to_rel(&canon_root, &upper).as_deref(),
                Some("notes/sub/a.md")
            );
        }
    }

    // ── integration: real watcher on a temp vault ─────────────────────

    struct ChannelSink {
        changed: Mutex<Sender<VaultChanged>>,
        errors: Mutex<Sender<VaultWatchError>>,
    }

    impl ChangeSink for ChannelSink {
        fn changed(&self, batch: VaultChanged) {
            let _ = self.changed.lock().unwrap().send(batch);
        }
        fn watch_error(&self, err: VaultWatchError) {
            let _ = self.errors.lock().unwrap().send(err);
        }
    }

    fn start_on(
        root: &Path,
    ) -> (
        VaultWatcher,
        Receiver<VaultChanged>,
        Receiver<VaultWatchError>,
    ) {
        let (ctx, crx) = mpsc::channel();
        let (etx, erx) = mpsc::channel();
        let sink = Arc::new(ChannelSink {
            changed: Mutex::new(ctx),
            errors: Mutex::new(etx),
        });
        let w = VaultWatcher::default();
        w.start(root.to_path_buf(), sink, TagIndex::default());
        (w, crx, erx)
    }

    /// Wait (up to 10 s) for a batch containing `rel`, returning that
    /// change. Own-only echoes of other paths are skipped.
    fn wait_for(rx: &Receiver<VaultChanged>, rel: &str) -> (VaultChange, VaultChanged) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let batch = rx
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no vault:changed for {rel} within 10 s"));
            if let Some(c) = batch.changes.iter().find(|c| c.rel_path == rel) {
                return (c.clone(), batch);
            }
        }
    }

    #[test]
    fn watcher_reports_external_create_modify_delete() {
        let v = tempdir().unwrap();
        std::fs::create_dir_all(v.path().join("notes")).unwrap();
        let (watcher, rx, erx) = start_on(v.path());
        let root_str = v.path().to_string_lossy().to_string();

        // Create (outside the app → not own).
        std::fs::write(v.path().join("notes/ext.md"), b"hello").unwrap();
        let (c, batch) = wait_for(&rx, "notes/ext.md");
        assert_eq!(batch.vault_root, root_str);
        assert!(!batch.overflow);
        assert_eq!(c.kind, ChangeKind::Created, "{batch:?}");
        assert!(!c.own);
        assert_eq!(
            batch
                .changes
                .iter()
                .filter(|x| x.rel_path == "notes/ext.md")
                .count(),
            1,
            "one entry per path per batch"
        );

        // Modify, after the previous batch has closed.
        thread::sleep(DEBOUNCE * 2);
        std::fs::write(v.path().join("notes/ext.md"), b"hello again").unwrap();
        let (c, _) = wait_for(&rx, "notes/ext.md");
        assert_eq!(c.kind, ChangeKind::Modified);
        assert!(!c.own);

        // Delete.
        thread::sleep(DEBOUNCE * 2);
        std::fs::remove_file(v.path().join("notes/ext.md")).unwrap();
        let (c, _) = wait_for(&rx, "notes/ext.md");
        assert_eq!(c.kind, ChangeKind::Removed);
        assert!(!c.own);

        assert!(erx.try_recv().is_err(), "no watch error expected");
        watcher.stop();
    }

    #[test]
    fn watcher_tags_app_writes_as_own_and_hides_temp_files() {
        let v = tempdir().unwrap();
        std::fs::create_dir_all(v.path().join("notes")).unwrap();
        let (watcher, rx, _erx) = start_on(v.path());

        fsx::atomic_write(&v.path().join("notes/mine.md"), b"from naiteh").unwrap();
        let (c, batch) = wait_for(&rx, "notes/mine.md");
        assert!(c.own, "{batch:?}");
        assert!(
            batch
                .changes
                .iter()
                .all(|x| !x.rel_path.contains(fsx::TMP_MARKER)),
            "temp files must be filtered: {batch:?}"
        );
        watcher.stop();
    }

    #[test]
    fn watcher_ignores_naiteh_and_git_internals() {
        let v = tempdir().unwrap();
        std::fs::create_dir_all(v.path().join(".naiteh")).unwrap();
        std::fs::create_dir_all(v.path().join(".git")).unwrap();
        std::fs::create_dir_all(v.path().join("notes")).unwrap();
        let (watcher, rx, _erx) = start_on(v.path());

        std::fs::write(v.path().join(".naiteh/workspace.json"), b"{}").unwrap();
        std::fs::write(v.path().join(".git/HEAD"), b"ref").unwrap();
        std::fs::write(v.path().join("notes/desktop.ini"), b"[x]").unwrap();
        thread::sleep(DEBOUNCE * 3);
        // A real note afterwards proves the watcher is alive and that the
        // earlier writes produced no batch of their own.
        std::fs::write(v.path().join("notes/real.md"), b"x").unwrap();
        let (_, batch) = wait_for(&rx, "notes/real.md");
        let rels: Vec<&str> = batch.changes.iter().map(|c| c.rel_path.as_str()).collect();
        assert!(
            rels.iter().all(|r| !r.starts_with(".naiteh")
                && !r.starts_with(".git")
                && !r.ends_with("desktop.ini")),
            "{rels:?}"
        );
        watcher.stop();
    }

    #[test]
    fn missing_root_reports_watch_error() {
        let v = tempdir().unwrap();
        let missing = v.path().join("nope");
        let (_watcher, _rx, erx) = start_on(&missing);
        let err = erx
            .recv_timeout(Duration::from_secs(10))
            .expect("watch error for a missing root");
        assert_eq!(err.vault_root, missing.to_string_lossy());
        assert!(!err.message.is_empty());
    }
}
