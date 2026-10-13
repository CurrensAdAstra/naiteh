//! Backup-target IPC commands — see vault/wiki/ipc-api.md ("Backup
//! targets"). Targets (Drive-synced folder, SFTP) live in the app config
//! dir (`backup-targets.json`, services::backup); secrets never leave the
//! backend. Copying runs on the blocking pool without the vault lock;
//! only `backup_restore_file` takes the lock, for its single write.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::domain::AppError;
use crate::services::backup::{
    self, BackupTarget, CompareReport, CompareSource, DriveConfig, Listing, ReadFileResult,
    RestoreResult, StoredSftp, StoredTarget, KIND_DRIVE, KIND_SFTP, LOCAL_SOURCE,
};
use crate::services::backup_sftp;
use crate::services::calendar;
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::index::TagIndex;
use crate::services::notes;
use crate::services::session::{require_session, ActiveSession};
use crate::services::vault_lock::VaultLocks;

pub const PROGRESS_EVENT: &str = "backup:progress";
pub const DONE_EVENT: &str = "backup:done";
/// How often the auto-backup scheduler wakes up.
const SCHEDULER_TICK: Duration = Duration::from_secs(60);

fn config_dir() -> Result<PathBuf, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    Ok(dir)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRunResult {
    pub target_id: String,
    pub uploaded: usize,
    pub trashed: usize,
    pub unchanged: usize,
    pub bytes: u64,
    pub duration_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    target_id: &'a str,
    done: usize,
    total: usize,
    rel_path: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload<'a> {
    target_id: &'a str,
    result: &'a BackupRunResult,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddSftpResult {
    pub target: BackupTarget,
    pub fingerprint: String,
}

fn non_empty(s: Option<String>) -> Option<String> {
    s.filter(|v| !v.is_empty())
}

// ── list / candidates ────────────────────────────────────────────────────

#[tauri::command]
pub async fn backup_targets_list(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<BackupTarget>, AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        Ok(backup::load_targets(&dir)?
            .iter()
            .map(StoredTarget::view)
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn backup_drive_candidates(
    active: tauri::State<'_, ActiveSession>,
) -> Result<Vec<String>, AppError> {
    require_session(&active)?;
    fsx::run_blocking(|| Ok(backup::drive_candidates_in(&backup::candidate_roots()))).await
}

// ── add / confirm / update / remove ──────────────────────────────────────

fn new_target(kind: &str, name: String) -> Result<StoredTarget, AppError> {
    Ok(StoredTarget {
        id: calendar::new_source_id()?,
        kind: kind.into(),
        name,
        enabled: true,
        auto_backup: false,
        interval_minutes: backup::DEFAULT_INTERVAL_MINUTES,
        last_backup_at: None,
        last_error: None,
        last_attempt_at: None,
        drive: None,
        sftp: None,
    })
}

#[tauri::command]
pub async fn backup_target_add_drive(
    active: tauri::State<'_, ActiveSession>,
    name: String,
    folder: String,
) -> Result<BackupTarget, AppError> {
    require_session(&active)?;
    let name = backup::validate_name(&name)?;
    let vault_root = config::current_vault_root()?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let folder = backup::resolve_drive_folder(&vault_root, &folder)?;
        fsx::ensure_dir(&folder)?;
        let mut t = new_target(KIND_DRIVE, name)?;
        t.drive = Some(DriveConfig {
            folder: folder.to_string_lossy().into_owned(),
        });
        let view = t.view();
        backup::modify_targets(&dir, |list| {
            list.push(t);
            Ok(())
        })?;
        Ok(view)
    })
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn backup_target_add_sftp(
    active: tauri::State<'_, ActiveSession>,
    name: String,
    host: String,
    port: Option<u16>,
    username: String,
    auth_method: String,
    password: Option<String>,
    key_path: Option<String>,
    passphrase: Option<String>,
    remote_dir: Option<String>,
) -> Result<AddSftpResult, AppError> {
    require_session(&active)?;
    let name = backup::validate_name(&name)?;
    let host = host.trim().to_string();
    if host.is_empty() || host.contains(char::is_whitespace) {
        return Err(AppError::Validation("Host is invalid".into()));
    }
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::Validation("Username is required".into()));
    }
    let (password, key_path, passphrase) = (
        non_empty(password),
        non_empty(key_path),
        non_empty(passphrase),
    );
    match auth_method.as_str() {
        "password" if password.is_none() => {
            return Err(AppError::Validation("Password is required".into()))
        }
        "key" if !key_path.as_deref().is_some_and(|k| Path::new(k).is_file()) => {
            return Err(AppError::Validation("Private key file not found".into()))
        }
        "password" | "key" => {}
        _ => return Err(AppError::Validation("Unknown auth method".into())),
    }
    let vault_root = config::current_vault_root()?;
    let remote_dir =
        backup::normalize_remote_dir(remote_dir.as_deref().unwrap_or(""), &vault_root)?;
    let port = port.unwrap_or(22);
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        // Handshake only: no credential goes to a host the user hasn't
        // confirmed yet.
        let (_sess, fingerprint) = backup_sftp::handshake(&host, port)?;
        let mut t = new_target(KIND_SFTP, name)?;
        t.enabled = false;
        t.sftp = Some(StoredSftp {
            host,
            port,
            username,
            auth_method,
            key_path,
            password,
            passphrase,
            remote_dir,
            host_key_fingerprint: None,
        });
        let target = t.view();
        backup::modify_targets(&dir, |list| {
            list.push(t);
            Ok(())
        })?;
        Ok(AddSftpResult {
            target,
            fingerprint,
        })
    })
    .await
}

#[tauri::command]
pub async fn backup_target_confirm_host_key(
    active: tauri::State<'_, ActiveSession>,
    id: String,
    fingerprint: String,
) -> Result<BackupTarget, AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let t = backup::find_target(&dir, &id)?;
        let cfg = t
            .sftp
            .ok_or_else(|| AppError::Validation("not an SFTP target".into()))?;
        // The server must still present the confirmed key, and the
        // credentials must work, before the target is enabled.
        backup_sftp::connect_pinned(&cfg, Some(&fingerprint))?;
        backup::modify_target(&dir, &id, |t| {
            if let Some(s) = t.sftp.as_mut() {
                s.host_key_fingerprint = Some(fingerprint);
            }
            t.enabled = true;
            t.last_error = None;
            Ok(())
        })
    })
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn backup_target_update(
    active: tauri::State<'_, ActiveSession>,
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
    auto_backup: Option<bool>,
    interval_minutes: Option<u32>,
    folder: Option<String>,
    remote_dir: Option<String>,
    password: Option<String>,
    passphrase: Option<String>,
    key_path: Option<String>,
) -> Result<BackupTarget, AppError> {
    require_session(&active)?;
    let name = name.map(|n| backup::validate_name(&n)).transpose()?;
    let interval = interval_minutes
        .map(backup::validate_interval)
        .transpose()?;
    let vault_root = config::current_vault_root()?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let folder = folder
            .map(|f| backup::resolve_drive_folder(&vault_root, &f))
            .transpose()?;
        if let Some(f) = &folder {
            fsx::ensure_dir(f)?;
        }
        let remote_dir = remote_dir
            .map(|r| backup::normalize_remote_dir(&r, &vault_root))
            .transpose()?;
        backup::modify_target(&dir, &id, |t| {
            if let Some(n) = name {
                t.name = n;
            }
            if let Some(a) = auto_backup {
                t.auto_backup = a;
            }
            if let Some(i) = interval {
                t.interval_minutes = i;
            }
            if let Some(f) = folder {
                let d = t
                    .drive
                    .as_mut()
                    .ok_or_else(|| AppError::Validation("not a Drive target".into()))?;
                d.folder = f.to_string_lossy().into_owned();
            }
            if remote_dir.is_some()
                || password.is_some()
                || passphrase.is_some()
                || key_path.is_some()
            {
                let s = t
                    .sftp
                    .as_mut()
                    .ok_or_else(|| AppError::Validation("not an SFTP target".into()))?;
                if let Some(r) = remote_dir {
                    s.remote_dir = r;
                }
                // "" clears a secret / key path.
                if let Some(p) = password {
                    s.password = non_empty(Some(p));
                }
                if let Some(p) = passphrase {
                    s.passphrase = non_empty(Some(p));
                }
                if let Some(k) = key_path {
                    s.key_path = non_empty(Some(k));
                }
            }
            if let Some(e) = enabled {
                if e && !t.runnable() {
                    return Err(AppError::Validation(
                        "Confirm the server's host key before enabling".into(),
                    ));
                }
                t.enabled = e;
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn backup_target_remove(
    active: tauri::State<'_, ActiveSession>,
    id: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        backup::modify_targets(&dir, |list| {
            let before = list.len();
            list.retain(|t| t.id != id);
            if list.len() == before {
                return Err(AppError::NotFound(format!("backup target {id}")));
            }
            Ok(())
        })
    })
    .await
}

// ── test / run ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn backup_test(
    active: tauri::State<'_, ActiveSession>,
    id: String,
) -> Result<(), AppError> {
    require_session(&active)?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let t = backup::find_target(&dir, &id)?;
        let remote = backup::open_target(&t)?;
        backup::probe(remote.as_ref(), &calendar::new_source_id()?)
    })
    .await
}

/// Run one target and record the outcome. `Err` only when the target is
/// already running (`Conflict`); run failures land in `result.error`.
async fn run_one(
    app: &AppHandle,
    config_dir: &Path,
    vault_root: &Path,
    target: StoredTarget,
) -> Result<BackupRunResult, AppError> {
    let guard = backup::try_begin(&target.id)?;
    backup::record_run_start(&target.id);
    let (app2, dir, root) = (
        app.clone(),
        config_dir.to_path_buf(),
        vault_root.to_path_buf(),
    );
    let started = std::time::Instant::now();
    let id = target.id.clone();
    let outcome = fsx::run_blocking(move || {
        let _guard = guard;
        let remote = backup::open_target(&target)?;
        let mut last_emit = std::time::Instant::now() - Duration::from_secs(1);
        let mut progress = |done: usize, total: usize, rel: &str| {
            if done == total || last_emit.elapsed() >= Duration::from_millis(100) {
                last_emit = std::time::Instant::now();
                let _ = app2.emit(
                    PROGRESS_EVENT,
                    ProgressPayload {
                        target_id: &target.id,
                        done,
                        total,
                        rel_path: rel,
                    },
                );
            }
        };
        backup::run_backup(
            &root,
            remote.as_ref(),
            &backup::now_stamp(),
            calendar::unix_now(),
            &mut progress,
        )
    })
    .await;
    let now = calendar::unix_now();
    let result = match &outcome {
        Ok(o) => BackupRunResult {
            target_id: id.clone(),
            uploaded: o.uploaded,
            trashed: o.trashed,
            unchanged: o.unchanged,
            bytes: o.bytes,
            duration_ms: started.elapsed().as_millis() as u64,
            error: None,
        },
        Err(e) => BackupRunResult {
            target_id: id.clone(),
            uploaded: 0,
            trashed: 0,
            unchanged: 0,
            bytes: 0,
            duration_ms: started.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
        },
    };
    let (dir2, id2, err) = (dir, id.clone(), result.error.clone());
    let _ = fsx::run_blocking(move || {
        backup::modify_target(&dir2, &id2, |t| {
            t.last_attempt_at = Some(now);
            if err.is_none() {
                t.last_backup_at = Some(now);
            }
            t.last_error = err;
            Ok(())
        })
    })
    .await;
    let _ = app.emit(
        DONE_EVENT,
        DonePayload {
            target_id: &id,
            result: &result,
        },
    );
    Ok(result)
}

#[tauri::command]
pub async fn backup_run(
    active: tauri::State<'_, ActiveSession>,
    app: AppHandle,
    id: Option<String>,
) -> Result<Vec<BackupRunResult>, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let dir = config_dir()?;
    let d = dir.clone();
    let all = fsx::run_blocking(move || backup::load_targets(&d)).await?;
    let mut results = Vec::new();
    match id {
        Some(id) => {
            let t = all
                .into_iter()
                .find(|t| t.id == id)
                .ok_or_else(|| AppError::NotFound(format!("backup target {id}")))?;
            if !t.runnable() {
                return Err(AppError::Validation(
                    "Confirm the server's host key first".into(),
                ));
            }
            results.push(run_one(&app, &dir, &vault_root, t).await?);
        }
        None => {
            for t in all.into_iter().filter(|t| t.enabled && t.runnable()) {
                let id = t.id.clone();
                match run_one(&app, &dir, &vault_root, t).await {
                    Ok(r) => results.push(r),
                    Err(e) => results.push(BackupRunResult {
                        target_id: id,
                        uploaded: 0,
                        trashed: 0,
                        unchanged: 0,
                        bytes: 0,
                        duration_ms: 0,
                        error: Some(e.to_string()),
                    }),
                }
            }
        }
    }
    Ok(results)
}

/// Background auto-backup: every minute, while someone is signed in, run
/// each due target (see `backup::is_due`). Started once from `setup`.
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SCHEDULER_TICK).await;
            if !app.state::<ActiveSession>().is_signed_in() {
                continue;
            }
            let (Ok(vault_root), Ok(dir)) = (config::current_vault_root(), config_dir()) else {
                continue;
            };
            let Ok(targets) = backup::load_targets(&dir) else {
                continue;
            };
            let now = calendar::unix_now();
            for t in targets {
                if backup::is_due(&t, now, backup::changed_since_last_run(&t.id)) {
                    let _ = run_one(&app, &dir, &vault_root, t).await;
                }
            }
        }
    });
}

// ── compare / read / restore ─────────────────────────────────────────────

#[tauri::command]
pub async fn backup_compare(
    active: tauri::State<'_, ActiveSession>,
    deep: bool,
    include_same: Option<bool>,
) -> Result<CompareReport, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let local = backup::scan_local(&vault_root)?;
        let mut sources = vec![CompareSource {
            id: LOCAL_SOURCE.into(),
            name: "Local vault".into(),
            kind: LOCAL_SOURCE.into(),
            ok: true,
            error: None,
            file_count: local.len(),
        }];
        let mut listings: Vec<(String, Listing)> = vec![(LOCAL_SOURCE.into(), local)];
        for t in backup::load_targets(&dir)? {
            let scanned = backup::open_target(&t).and_then(|r| {
                // Drive is a local folder: always hash the real files.
                backup::scan_remote(r.as_ref(), t.kind == KIND_DRIVE || deep)
            });
            let (ok, error, count) = match &scanned {
                Ok(l) => (true, None, l.len()),
                Err(e) => (false, Some(e.to_string()), 0),
            };
            sources.push(CompareSource {
                id: t.id.clone(),
                name: t.name.clone(),
                kind: t.kind.clone(),
                ok,
                error,
                file_count: count,
            });
            if let Ok(l) = scanned {
                listings.push((t.id, l));
            }
        }
        let refs: Vec<(String, &Listing)> = listings.iter().map(|(i, l)| (i.clone(), l)).collect();
        Ok(CompareReport {
            generated_at: calendar::unix_now(),
            sources,
            rows: backup::compare_rows(&refs, include_same.unwrap_or(false)),
        })
    })
    .await
}

/// Bytes of `rel` from a source (`"local"` or a target id) and the
/// source's display name.
fn read_source(
    config_dir: &Path,
    vault_root: &Path,
    source_id: &str,
    rel: &str,
) -> Result<(Vec<u8>, String), AppError> {
    let rel = backup::safe_rel(rel)?;
    if backup::is_excluded(&rel) {
        return Err(AppError::InvalidPath(format!(
            "not a backed-up path: {rel}"
        )));
    }
    if source_id == LOCAL_SOURCE {
        let abs = notes::resolve_in_vault(vault_root, &rel)?;
        return match std::fs::read(&abs) {
            Ok(b) => Ok((b, "local".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(AppError::NotFound(rel)),
            Err(e) => Err(AppError::Io(e.to_string())),
        };
    }
    let t = backup::find_target(config_dir, source_id)?;
    let remote = backup::open_target(&t)?;
    let bytes = remote.read(&rel)?.ok_or(AppError::NotFound(rel))?;
    Ok((bytes, t.name))
}

#[tauri::command]
pub async fn backup_read_file(
    active: tauri::State<'_, ActiveSession>,
    source_id: String,
    rel_path: String,
) -> Result<ReadFileResult, AppError> {
    require_session(&active)?;
    let vault_root = config::current_vault_root()?;
    let dir = config_dir()?;
    fsx::run_blocking(move || {
        let (bytes, _) = read_source(&dir, &vault_root, &source_id, &rel_path)?;
        Ok(backup::read_result(bytes))
    })
    .await
}

#[tauri::command]
pub async fn backup_restore_file(
    active: tauri::State<'_, ActiveSession>,
    locks: tauri::State<'_, VaultLocks>,
    index: tauri::State<'_, TagIndex>,
    source_id: String,
    rel_path: String,
    mode: String,
    expected_version: Option<String>,
) -> Result<RestoreResult, AppError> {
    require_session(&active)?;
    if mode != "copy" && mode != "overwrite" {
        return Err(AppError::Validation(format!(
            "unknown restore mode: {mode}"
        )));
    }
    if source_id == LOCAL_SOURCE {
        return Err(AppError::Validation("Pick a backup to restore from".into()));
    }
    let vault_root = config::current_vault_root()?;
    let dir = config_dir()?;
    // Fetch first (network / Drive I/O) without the lock …
    let (root, rel) = (vault_root.clone(), rel_path.clone());
    let (bytes, source_name) =
        fsx::run_blocking(move || read_source(&dir, &root, &source_id, &rel)).await?;
    // … then write under it.
    let lock = locks.for_vault(&vault_root);
    let _guard = lock.lock().await;
    let root = vault_root.clone();
    let result = fsx::run_blocking(move || {
        backup::restore_into_vault(
            &root,
            &rel_path,
            &bytes,
            &mode,
            expected_version.as_deref(),
            &source_name,
            &backup::now_stamp(),
        )
    })
    .await;
    if result.is_ok() {
        index.invalidate(&vault_root);
    }
    result
}
