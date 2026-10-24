//! Backup targets — one-way mirrors of the vault to a Google-Drive-synced
//! folder ("drive") and/or an SFTP server ("sftp"), plus a three-way
//! compare and single-file restore. See vault/wiki/vault-and-data.md
//! ("Backup"), vault/wiki/ipc-api.md ("Backup targets") and
//! vault/wiki/app-config.md ("Backup targets").
//!
//! Everything that touches a target goes through the [`RemoteFs`] trait so
//! the engine (manifest diff, upload, trash, compare) is tested against a
//! plain directory ([`LocalDirFs`]); the SFTP implementation lives in
//! `services::backup_sftp` and is deliberately thin.
//!
//! Layout on a target (relative to its root folder / remote dir):
//!
//! ```text
//! <root>/<vault files…>
//! <root>/.naiteh-backup/manifest.json        relPath → { size, hash }
//! <root>/.naiteh-backup/trash/<ts>/<relPath> files deleted locally
//! ```
//!
//! The backup never takes the vault lock: it reads each file once (bytes
//! and SHA-256 together, so the manifest always describes what was
//! uploaded); a file that changes mid-run is picked up next time.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex as StdMutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::AppError;
use crate::services::credentials::{self, CredentialRef, CredentialStore, Transaction};
use crate::services::fs as fsx;
use crate::services::notes::{self, canonicalize_lenient};
use crate::services::watcher::is_ignored_name;

pub const TARGETS_FILE: &str = "backup-targets.json";
/// Metadata folder at the root of every target.
pub const META_DIR: &str = ".naiteh-backup";
pub const MANIFEST_REL: &str = ".naiteh-backup/manifest.json";
pub const TRASH_REL: &str = ".naiteh-backup/trash";
/// Default parent folder for a target (`naiteh-backup/<vault name>`).
pub const BACKUP_ROOT_DIR: &str = "naiteh-backup";
pub const DEFAULT_INTERVAL_MINUTES: u32 = 30;
pub const MIN_INTERVAL_MINUTES: u32 = 5;
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
/// Folder names Google Drive for desktop uses for the "My Drive" root.
pub const DRIVE_ROOT_NAMES: &[&str] = &["My Drive", "내 드라이브"];
/// Save the manifest every this many operations, so an interrupted run
/// does not redo everything.
const MANIFEST_SAVE_EVERY: usize = 50;

pub const KIND_DRIVE: &str = "drive";
pub const KIND_SFTP: &str = "sftp";
pub const LOCAL_SOURCE: &str = "local";

// ── stored targets (app-config dir) ──────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveConfig {
    pub folder: String,
}

/// Disk metadata plus deserialize-only legacy secrets. New JSON writes contain
/// credential references; the renderer receives only [`StoredTarget::view`].
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSftp {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `"password"` | `"key"`.
    pub auth_method: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    #[serde(default, skip_serializing)]
    pub passphrase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_ref: Option<CredentialRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase_ref: Option<CredentialRef>,
    pub remote_dir: String,
    /// Pinned `SHA256:<base64>` host-key fingerprint (TOFU); `None` until
    /// the user confirms it.
    #[serde(default)]
    pub host_key_fingerprint: Option<String>,
}

impl StoredSftp {
    pub fn has_password(&self) -> bool {
        self.password_ref.is_some() || self.password.as_deref().is_some_and(|p| !p.is_empty())
    }

    pub fn has_passphrase(&self) -> bool {
        self.passphrase_ref.is_some() || self.passphrase.as_deref().is_some_and(|p| !p.is_empty())
    }
}

impl std::fmt::Debug for StoredSftp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredSftp")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("auth_method", &self.auth_method)
            .field("has_password", &self.has_password())
            .field("has_passphrase", &self.has_passphrase())
            .finish_non_exhaustive()
    }
}

fn default_interval() -> u32 {
    DEFAULT_INTERVAL_MINUTES
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTarget {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub auto_backup: bool,
    #[serde(default = "default_interval")]
    pub interval_minutes: u32,
    #[serde(default)]
    pub last_backup_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    /// Last run attempt (success or failure); keeps the scheduler from
    /// retrying a failing target every minute. Not in the view.
    #[serde(default)]
    pub last_attempt_at: Option<i64>,
    #[serde(default)]
    pub drive: Option<DriveConfig>,
    #[serde(default)]
    pub sftp: Option<StoredSftp>,
}

impl std::fmt::Debug for StoredTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredTarget")
            .field("target", &self.view())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpView {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub has_password: bool,
    pub has_passphrase: bool,
    pub remote_dir: String,
    pub host_key_fingerprint: Option<String>,
}

/// IPC view of a target (`BackupTarget` in ipc-api.md). Secret-free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    pub auto_backup: bool,
    pub interval_minutes: u32,
    pub last_backup_at: Option<i64>,
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drive: Option<DriveConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sftp: Option<SftpView>,
}

impl StoredTarget {
    pub fn view(&self) -> BackupTarget {
        let secrets: Vec<&str> = self
            .sftp
            .as_ref()
            .into_iter()
            .flat_map(|s| [s.password.as_deref(), s.passphrase.as_deref()])
            .flatten()
            .collect();
        BackupTarget {
            id: self.id.clone(),
            kind: self.kind.clone(),
            name: self.name.clone(),
            enabled: self.enabled,
            auto_backup: self.auto_backup,
            interval_minutes: self.interval_minutes,
            last_backup_at: self.last_backup_at,
            last_error: self
                .last_error
                .clone()
                .map(|e| credentials::redact_text(e, &secrets)),
            drive: self.drive.clone(),
            sftp: self.sftp.as_ref().map(|s| SftpView {
                host: s.host.clone(),
                port: s.port,
                username: s.username.clone(),
                auth_method: s.auth_method.clone(),
                key_path: s.key_path.clone(),
                has_password: s.has_password(),
                has_passphrase: s.has_passphrase(),
                remote_dir: s.remote_dir.clone(),
                host_key_fingerprint: s.host_key_fingerprint.clone(),
            }),
        }
    }

    /// Can this target be backed up / compared right now? (An SFTP target
    /// needs a confirmed host key.)
    pub fn runnable(&self) -> bool {
        match self.kind.as_str() {
            KIND_DRIVE => self.drive.is_some(),
            KIND_SFTP => self
                .sftp
                .as_ref()
                .is_some_and(|s| s.host_key_fingerprint.is_some()),
            _ => false,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct TargetsFile {
    #[serde(default)]
    pub targets: Vec<StoredTarget>,
}

/// Serializes read-modify-write cycles on `backup-targets.json`. Never
/// held across network I/O.
static STORE_LOCK: StdMutex<()> = StdMutex::new(());

pub fn targets_path(config_dir: &Path) -> PathBuf {
    config_dir.join(TARGETS_FILE)
}

fn read_store(config_dir: &Path) -> Result<TargetsFile, AppError> {
    credentials::read_json(&targets_path(config_dir)).map(|(_, file)| file)
}

pub fn load_targets(config_dir: &Path) -> Result<Vec<StoredTarget>, AppError> {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    Ok(read_store(config_dir)?.targets)
}

pub fn find_target(config_dir: &Path, id: &str) -> Result<StoredTarget, AppError> {
    load_targets(config_dir)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::NotFound(format!("backup target {id}")))
}

pub fn modify_targets<T>(
    config_dir: &Path,
    f: impl FnOnce(&mut Vec<StoredTarget>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    credentials::with_store(|store| modify_targets_with_store(config_dir, store, &[], f))
}

fn modify_targets_with_store<T>(
    config_dir: &Path,
    store: &dyn CredentialStore,
    touched: &[(&str, &str)],
    f: impl FnOnce(&mut Vec<StoredTarget>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _g = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (mut raw, mut file): (_, TargetsFile) = credentials::read_json(&targets_path(config_dir))?;
    let previous = raw.clone();
    let before = file.targets.clone();
    let out = f(&mut file.targets)?;
    let mut transaction = Transaction::new(store);
    let old_raw = previous.get("targets").and_then(Value::as_array);
    let find_raw = |id: &str| {
        old_raw.and_then(|list| {
            list.iter()
                .find(|t| t.get("id").and_then(Value::as_str) == Some(id))
        })
    };
    for removed in before
        .iter()
        .filter(|old| !file.targets.iter().any(|t| t.id == old.id))
    {
        if let Some(mut removed) = find_raw(&removed.id).cloned() {
            migrate_sftp(&mut removed, &mut transaction, None, true)?;
        }
    }
    let mut next_targets = Vec::new();
    for target in &mut file.targets {
        let old = before.iter().find(|t| t.id == target.id);
        let mut raw_target = find_raw(&target.id)
            .cloned()
            .unwrap_or(credentials::json(target)?);
        if let Some(sftp) = &mut target.sftp {
            if !raw_target.get("sftp").is_some_and(Value::is_object) {
                raw_target["sftp"] = credentials::json(sftp)?;
            }
            let old_sftp = old.and_then(|t| t.sftp.as_ref());
            for (legacy, reference, secret, new_ref, old_secret, old_ref) in [
                (
                    "password",
                    "passwordRef",
                    &mut sftp.password,
                    &mut sftp.password_ref,
                    old_sftp.and_then(|s| s.password.as_ref()),
                    old_sftp.and_then(|s| s.password_ref.as_ref()),
                ),
                (
                    "passphrase",
                    "passphraseRef",
                    &mut sftp.passphrase,
                    &mut sftp.passphrase_ref,
                    old_sftp.and_then(|s| s.passphrase.as_ref()),
                    old_sftp.and_then(|s| s.passphrase_ref.as_ref()),
                ),
            ] {
                if secret.as_ref() != old_secret
                    || new_ref.as_ref() != old_ref
                    || touched.contains(&(target.id.as_str(), legacy))
                {
                    migrate_sftp(&mut raw_target, &mut transaction, Some(legacy), true)?;
                    if let Some(value) = secret.as_deref().filter(|s| !s.is_empty()) {
                        *new_ref = Some(transaction.stage(value)?);
                    }
                    *secret = None;
                    // A new target's serialized metadata already has an SFTP object.
                    let object = raw_target["sftp"].as_object_mut().unwrap();
                    object.remove(legacy);
                    credentials::set_reference(object, reference, new_ref.as_ref())?;
                }
            }
        } else if old.and_then(|t| t.sftp.as_ref()).is_some() {
            migrate_sftp(&mut raw_target, &mut transaction, None, true)?;
        }
        if let Some(old) = old {
            credentials::merge_changes(
                &mut raw_target,
                &credentials::json(old)?,
                &credentials::json(target)?,
            );
        } else {
            raw_target = credentials::json(target)?;
        }
        next_targets.push(raw_target);
    }
    raw["targets"] = Value::Array(next_targets);
    transaction.finish(&previous, &raw, || {
        fsx::write_json(&targets_path(config_dir), &raw)
    })?;
    Ok(out)
}

fn migrate_sftp(
    target: &mut Value,
    transaction: &mut Transaction<'_>,
    only: Option<&str>,
    superseded: bool,
) -> Result<usize, AppError> {
    let Some(sftp) = target.get_mut("sftp").and_then(Value::as_object_mut) else {
        return Ok(0);
    };
    let secrets: Vec<String> = ["password", "passphrase"]
        .iter()
        .filter_map(|field| sftp.get(*field).and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut count = 0;
    for (legacy, reference) in [("password", "passwordRef"), ("passphrase", "passphraseRef")] {
        if only.is_none_or(|field| field == legacy) {
            count +=
                credentials::migrate_slot(transaction, sftp, legacy, reference, false, superseded)?;
        }
    }
    if let Some(error) = target.get_mut("lastError") {
        if let Some(message) = error.as_str() {
            *error = Value::String(credentials::redact_text(
                message.into(),
                &secrets.iter().map(String::as_str).collect::<Vec<_>>(),
            ));
        }
    }
    Ok(count)
}

pub fn migrate_credentials(config_dir: &Path) -> Result<usize, AppError> {
    credentials::with_store(|store| migrate_credentials_with_store(config_dir, store, None))
}

/// `only` is (target id, selected auth field); unrelated targets/auth methods
/// never need a working keyring for an operation on another target.
fn migrate_credentials_with_store(
    config_dir: &Path,
    store: &dyn CredentialStore,
    only: Option<(&str, &str)>,
) -> Result<usize, AppError> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let (mut raw, _): (_, TargetsFile) = credentials::read_json(&targets_path(config_dir))?;
    let previous = raw.clone();
    let mut transaction = Transaction::new(store);
    let mut count = 0;
    if let Some(targets) = raw.get_mut("targets").and_then(Value::as_array_mut) {
        for target in targets {
            if only.is_none_or(|(id, _)| target.get("id").and_then(Value::as_str) == Some(id)) {
                count += migrate_sftp(
                    target,
                    &mut transaction,
                    only.map(|(_, field)| field),
                    false,
                )?;
            }
        }
    }
    if raw != previous {
        transaction.finish(&previous, &raw, || {
            fsx::write_json(&targets_path(config_dir), &raw)
        })?;
    }
    Ok(count)
}

/// Called only after host-key validation. Migration and lookup are scoped to the
/// selected auth method. Passwords/passphrases are never trimmed.
pub fn resolve_sftp_secret(
    config_dir: &Path,
    id: &str,
    expected: &StoredSftp,
) -> Result<Option<String>, AppError> {
    credentials::with_store(|store| resolve_sftp_secret_with_store(config_dir, id, expected, store))
}

fn resolve_sftp_secret_with_store(
    config_dir: &Path,
    id: &str,
    expected: &StoredSftp,
    store: &dyn CredentialStore,
) -> Result<Option<String>, AppError> {
    let field = match expected.auth_method.as_str() {
        "password" => "password",
        "key" => "passphrase",
        _ => return Err(AppError::Validation("Unknown SFTP auth method".into())),
    };
    migrate_credentials_with_store(config_dir, store, Some((id, field)))?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let target = read_store(config_dir)?
        .targets
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| AppError::NotFound("Backup target was removed".into()))?;
    let actual = target
        .sftp
        .ok_or_else(|| AppError::Validation("Not an SFTP target".into()))?;
    if actual.host != expected.host
        || actual.port != expected.port
        || actual.username != expected.username
        || actual.auth_method != expected.auth_method
        || actual.key_path != expected.key_path
        || actual.remote_dir != expected.remote_dir
        || actual.host_key_fingerprint != expected.host_key_fingerprint
    {
        return Err(AppError::Conflict(
            "SFTP settings changed; retry the operation".into(),
        ));
    }
    let reference = if field == "password" {
        actual.password_ref
    } else {
        actual.passphrase_ref
    };
    reference
        .as_ref()
        .map(|r| credentials::resolve(store, r))
        .transpose()
}

/// Apply `f` to one target and persist; returns its new view.
pub fn modify_target(
    config_dir: &Path,
    id: &str,
    f: impl FnOnce(&mut StoredTarget) -> Result<(), AppError>,
) -> Result<BackupTarget, AppError> {
    modify_targets(config_dir, |list| {
        let t = list
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::NotFound(format!("backup target {id}")))?;
        f(t)?;
        Ok(t.view())
    })
}

/// Explicit secret updates must migrate even if the supplied value equals the
/// legacy plaintext. `None` keeps a field; an empty string clears it.
pub fn modify_target_credentials(
    config_dir: &Path,
    id: &str,
    password: Option<String>,
    passphrase: Option<String>,
    f: impl FnOnce(&mut StoredTarget) -> Result<(), AppError>,
) -> Result<BackupTarget, AppError> {
    let mut touched = Vec::new();
    if password.is_some() {
        touched.push((id, "password"));
    }
    if passphrase.is_some() {
        touched.push((id, "passphrase"));
    }
    credentials::with_store(|store| {
        modify_targets_with_store(config_dir, store, &touched, |list| {
            let target = list
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| AppError::NotFound("Backup target not found".into()))?;
            if password.is_some() || passphrase.is_some() {
                // The old values will no longer be available to redact the returned view.
                target.last_error = target.view().last_error;
                let sftp = target
                    .sftp
                    .as_mut()
                    .ok_or_else(|| AppError::Validation("Not an SFTP target".into()))?;
                if let Some(password) = password {
                    sftp.password = (!password.is_empty()).then_some(password);
                    sftp.password_ref = None;
                }
                if let Some(passphrase) = passphrase {
                    sftp.passphrase = (!passphrase.is_empty()).then_some(passphrase);
                    sftp.passphrase_ref = None;
                }
            }
            f(target)?;
            Ok(target.view())
        })
    })
}

// ── validation ───────────────────────────────────────────────────────────

pub fn validate_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Validation("Name is required".into()));
    }
    if name.chars().count() > 80 {
        return Err(AppError::Validation("Name is too long".into()));
    }
    Ok(name.to_string())
}

pub fn validate_interval(minutes: u32) -> Result<u32, AppError> {
    if minutes < MIN_INTERVAL_MINUTES {
        return Err(AppError::Validation(format!(
            "Interval must be at least {MIN_INTERVAL_MINUTES} minutes"
        )));
    }
    Ok(minutes)
}

/// Last component of the vault root, used in default target folders.
pub fn vault_name(vault_root: &Path) -> String {
    vault_root
        .canonicalize()
        .ok()
        .as_deref()
        .unwrap_or(vault_root)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "vault".into())
}

fn path_key(p: &Path) -> PathBuf {
    let c = canonicalize_lenient(p).unwrap_or_else(|| p.to_path_buf());
    if cfg!(windows) {
        PathBuf::from(c.to_string_lossy().to_lowercase())
    } else {
        c
    }
}

/// Resolve the folder for a drive target. A bare "My Drive" root gets
/// `naiteh-backup/<vault name>` appended. The folder must not be inside
/// the vault and the vault must not be inside it (canonicalized, so
/// symlinks / case / 8.3 names can't sneak around the check).
pub fn resolve_drive_folder(vault_root: &Path, folder: &str) -> Result<PathBuf, AppError> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err(AppError::Validation("Folder is required".into()));
    }
    let mut path = PathBuf::from(folder);
    if !path.is_absolute() {
        return Err(AppError::Validation(
            "Folder must be an absolute path".into(),
        ));
    }
    let is_drive_root = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| DRIVE_ROOT_NAMES.contains(&n));
    if is_drive_root {
        path = path.join(BACKUP_ROOT_DIR).join(vault_name(vault_root));
    }
    let f = path_key(&path);
    let v = path_key(vault_root);
    if f.starts_with(&v) {
        return Err(AppError::Validation(
            "The backup folder must be outside the vault".into(),
        ));
    }
    if v.starts_with(&f) {
        return Err(AppError::Validation(
            "The vault must not be inside the backup folder".into(),
        ));
    }
    Ok(path)
}

/// Normalize an SFTP remote dir; empty → `naiteh-backup/<vault name>`.
/// Absolute (`/srv/x`) or relative to the login directory; no `..`.
pub fn normalize_remote_dir(raw: &str, vault_root: &Path) -> Result<String, AppError> {
    let raw = raw.trim().replace('\\', "/");
    if raw.is_empty() {
        return Ok(format!("{BACKUP_ROOT_DIR}/{}", vault_name(vault_root)));
    }
    let absolute = raw.starts_with('/');
    let parts: Vec<&str> = raw
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    if parts.contains(&"..") {
        return Err(AppError::Validation(
            "Remote folder may not contain '..'".into(),
        ));
    }
    if parts.is_empty() {
        return Err(AppError::Validation(
            "Remote folder must not be the server root".into(),
        ));
    }
    let joined = parts.join("/");
    Ok(if absolute {
        format!("/{joined}")
    } else {
        joined
    })
}

// ── Google Drive for desktop detection ───────────────────────────────────

/// Folders that may contain a "My Drive" root on this machine.
pub fn candidate_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(windows) {
        for letter in b'A'..=b'Z' {
            roots.push(PathBuf::from(format!("{}:\\", letter as char)));
        }
    }
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Google Drive"));
        roots.push(home.clone());
        if let Ok(entries) = std::fs::read_dir(home.join("Library").join("CloudStorage")) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with("GoogleDrive-") {
                    roots.push(e.path());
                }
            }
        }
    }
    roots
}

/// Every `<root>/My Drive` (or localized name) that exists, deduplicated.
pub fn drive_candidates_in(roots: &[PathBuf]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        for name in DRIVE_ROOT_NAMES {
            let p = root.join(name);
            if p.is_dir() && seen.insert(path_key(&p)) {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    out
}

// ── exclusion rules ──────────────────────────────────────────────────────

/// Vault paths a backup never copies: `.git/` (any depth), the target
/// metadata folder, machine-local state (`.naiteh/workspace.json`,
/// `.naiteh/sync-state.json`) and the temp / junk names the watcher
/// ignores. Conflict sidecars are user data and *are* copied.
pub fn is_excluded(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if lower == ".naiteh/workspace.json" || lower == ".naiteh/sync-state.json" {
        return true;
    }
    rel.split('/').any(|c| {
        c.eq_ignore_ascii_case(".git") || c.eq_ignore_ascii_case(META_DIR) || is_ignored_name(c)
    })
}

// ── manifests ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub size: u64,
    pub hash: String,
    pub mtime: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Canonical vault root this target mirrors; a run from another vault
    /// is refused so it can't trash the first vault's files.
    #[serde(default)]
    pub vault: String,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub files: BTreeMap<String, ManifestEntry>,
}

pub type Listing = BTreeMap<String, FileEntry>;

fn mtime_of(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// Walk `root` (no symlinks followed), yielding `/`-joined rel paths of
/// regular files for which `keep(rel)` holds; directories for which
/// `keep` fails are not descended.
fn walk_files(
    root: &Path,
    keep: &dyn Fn(&str) -> bool,
) -> Result<Vec<(String, PathBuf, std::fs::Metadata)>, AppError> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if prefix.is_empty() => return Err(AppError::Io(e.to_string())),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let rel = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if !keep(&rel) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push((entry.path(), rel));
            } else if meta.is_file() {
                out.push((rel, entry.path(), meta));
            }
        }
    }
    Ok(out)
}

/// Hash every backed-up file in the vault.
pub fn scan_local(vault_root: &Path) -> Result<Listing, AppError> {
    let mut out = Listing::new();
    for (rel, abs, meta) in walk_files(vault_root, &|r| !is_excluded(r))? {
        let Ok(bytes) = std::fs::read(&abs) else {
            continue; // vanished / unreadable — next run
        };
        out.insert(
            rel,
            FileEntry {
                size: bytes.len() as u64,
                hash: notes::file_version(&bytes),
                mtime: mtime_of(&meta),
            },
        );
    }
    Ok(out)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub upload: Vec<String>,
    pub trash: Vec<String>,
    pub unchanged: usize,
}

/// Diff the local listing against the target manifest.
pub fn plan(local: &Listing, remote: &BTreeMap<String, ManifestEntry>) -> Plan {
    let mut p = Plan::default();
    for (rel, l) in local {
        match remote.get(rel) {
            Some(r) if r.hash == l.hash && r.size == l.size => p.unchanged += 1,
            _ => p.upload.push(rel.clone()),
        }
    }
    p.trash = remote
        .keys()
        .filter(|k| !local.contains_key(*k))
        .cloned()
        .collect();
    p
}

// ── remote abstraction ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFile {
    pub rel: String,
    pub size: u64,
    pub mtime: Option<i64>,
}

/// A backup target's file tree. Paths are `/`-separated and relative to
/// the target root; implementations must refuse unsafe ones
/// ([`safe_rel`]).
pub trait RemoteFs {
    /// `None` when the file does not exist.
    fn read(&self, rel: &str) -> Result<Option<Vec<u8>>, AppError>;
    /// Write via a temp file + rename, creating parent folders.
    fn write_atomic(&self, rel: &str, bytes: &[u8]) -> Result<(), AppError>;
    /// Move a file (creating `to`'s parents, replacing `to`). `NotFound`
    /// when `from` is missing.
    fn rename(&self, from: &str, to: &str) -> Result<(), AppError>;
    fn remove(&self, rel: &str) -> Result<(), AppError>;
    /// Every regular file under the root except the `.naiteh-backup/`
    /// metadata folder.
    fn list_files(&self) -> Result<Vec<RemoteFile>, AppError>;
}

/// Validate a target-relative path (no `..`, absolute, empty segments).
pub fn safe_rel(rel: &str) -> Result<String, AppError> {
    notes::normalize_rel_path(rel)
}

/// A plain directory as a target: the Drive-synced folder (and the
/// stand-in for SFTP in tests).
pub struct LocalDirFs {
    pub root: PathBuf,
}

impl LocalDirFs {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn abs(&self, rel: &str) -> Result<PathBuf, AppError> {
        let rel = safe_rel(rel)?;
        let mut p = self.root.clone();
        for part in rel.split('/') {
            p.push(part);
        }
        Ok(p)
    }
}

impl RemoteFs for LocalDirFs {
    fn read(&self, rel: &str) -> Result<Option<Vec<u8>>, AppError> {
        match std::fs::read(self.abs(rel)?) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::Io(e.to_string())),
        }
    }

    fn write_atomic(&self, rel: &str, bytes: &[u8]) -> Result<(), AppError> {
        fsx::atomic_write(&self.abs(rel)?, bytes)
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let (from, to) = (self.abs(from)?, self.abs(to)?);
        if !from.is_file() {
            return Err(AppError::NotFound(from.display().to_string()));
        }
        if let Some(parent) = to.parent() {
            fsx::ensure_dir(parent)?;
        }
        std::fs::rename(&from, &to).map_err(|e| AppError::Io(e.to_string()))
    }

    fn remove(&self, rel: &str) -> Result<(), AppError> {
        std::fs::remove_file(self.abs(rel)?).map_err(|e| AppError::Io(e.to_string()))
    }

    fn list_files(&self) -> Result<Vec<RemoteFile>, AppError> {
        if !self.root.is_dir() {
            return Ok(Vec::new());
        }
        Ok(
            walk_files(&self.root, &|r| r.split('/').next() != Some(META_DIR))?
                .into_iter()
                .map(|(rel, _, meta)| RemoteFile {
                    rel,
                    size: meta.len(),
                    mtime: mtime_of(&meta),
                })
                .collect(),
        )
    }
}

/// Read the target's manifest; missing → empty, unparseable → empty
/// (everything is re-uploaded, nothing is trashed). Unsafe paths in a
/// tampered manifest are dropped.
pub fn load_manifest(remote: &dyn RemoteFs) -> Result<Manifest, AppError> {
    let Some(bytes) = remote.read(MANIFEST_REL)? else {
        return Ok(Manifest::default());
    };
    let mut m: Manifest = serde_json::from_slice(&bytes).unwrap_or_default();
    m.files
        .retain(|k, _| safe_rel(k).is_ok_and(|s| s == *k) && !is_excluded(k));
    Ok(m)
}

fn save_manifest(remote: &dyn RemoteFs, m: &mut Manifest, now: i64) -> Result<(), AppError> {
    m.updated_at = now;
    let bytes = serde_json::to_vec_pretty(m).map_err(|e| AppError::Io(e.to_string()))?;
    remote.write_atomic(MANIFEST_REL, &bytes)
}

pub fn vault_key(vault_root: &Path) -> String {
    vault_root
        .canonicalize()
        .unwrap_or_else(|_| vault_root.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

// ── backup run ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunOutcome {
    pub uploaded: usize,
    pub trashed: usize,
    pub unchanged: usize,
    pub bytes: u64,
}

/// Mirror the vault onto `remote`: upload new/changed files, move files
/// deleted locally into `.naiteh-backup/trash/<stamp>/` (never delete).
/// `progress(done, total, relPath)` is called after each operation.
pub fn run_backup(
    vault_root: &Path,
    remote: &dyn RemoteFs,
    stamp: &str,
    now: i64,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Result<RunOutcome, AppError> {
    let key = vault_key(vault_root);
    let mut manifest = load_manifest(remote)?;
    if !manifest.vault.is_empty() && manifest.vault != key {
        return Err(AppError::Validation(format!(
            "This backup location holds a backup of another vault ({}); choose a different folder",
            manifest.vault
        )));
    }
    manifest.vault = key;
    let local = scan_local(vault_root)?;
    let p = plan(&local, &manifest.files);
    let total = p.upload.len() + p.trash.len();
    let mut out = RunOutcome {
        unchanged: p.unchanged,
        ..Default::default()
    };
    let mut done = 0usize;

    let result = (|| -> Result<(), AppError> {
        for rel in &p.upload {
            let abs = notes::resolve_in_vault(vault_root, rel)?;
            if let Ok(bytes) = std::fs::read(&abs) {
                remote.write_atomic(rel, &bytes)?;
                manifest.files.insert(
                    rel.clone(),
                    ManifestEntry {
                        size: bytes.len() as u64,
                        hash: notes::file_version(&bytes),
                    },
                );
                out.uploaded += 1;
                out.bytes += bytes.len() as u64;
            }
            done += 1;
            progress(done, total, rel);
            if done.is_multiple_of(MANIFEST_SAVE_EVERY) {
                save_manifest(remote, &mut manifest, now)?;
            }
        }
        for rel in &p.trash {
            let to = format!("{TRASH_REL}/{stamp}/{rel}");
            match remote.rename(rel, &to) {
                Ok(()) => out.trashed += 1,
                Err(AppError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
            manifest.files.remove(rel);
            done += 1;
            progress(done, total, rel);
            if done.is_multiple_of(MANIFEST_SAVE_EVERY) {
                save_manifest(remote, &mut manifest, now)?;
            }
        }
        Ok(())
    })();
    // Persist whatever was done, even on failure.
    let saved = save_manifest(remote, &mut manifest, now);
    result?;
    saved?;
    Ok(out)
}

/// Write, read back and delete a probe file.
pub fn probe(remote: &dyn RemoteFs, token: &str) -> Result<(), AppError> {
    let rel = format!("{META_DIR}/probe-{token}.txt");
    let body = format!("naiteh backup probe {token}");
    remote.write_atomic(&rel, body.as_bytes())?;
    let back = remote.read(&rel)?;
    remote.remove(&rel)?;
    if back.as_deref() != Some(body.as_bytes()) {
        return Err(AppError::Io("probe file read back differently".into()));
    }
    Ok(())
}

// ── compare ──────────────────────────────────────────────────────────────

/// Listing of a target: hash the actual files (`hash_files`) or trust the
/// manifest (size + hash, no mtime).
pub fn scan_remote(remote: &dyn RemoteFs, hash_files: bool) -> Result<Listing, AppError> {
    let mut out = Listing::new();
    if hash_files {
        for f in remote.list_files()? {
            if is_excluded(&f.rel) || safe_rel(&f.rel).is_err() {
                continue;
            }
            if let Some(bytes) = remote.read(&f.rel)? {
                out.insert(
                    f.rel,
                    FileEntry {
                        size: bytes.len() as u64,
                        hash: notes::file_version(&bytes),
                        mtime: f.mtime,
                    },
                );
            }
        }
    } else {
        for (rel, e) in load_manifest(remote)?.files {
            out.insert(
                rel,
                FileEntry {
                    size: e.size,
                    hash: e.hash,
                    mtime: None,
                },
            );
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub ok: bool,
    pub error: Option<String>,
    pub file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRow {
    pub rel_path: String,
    pub entries: BTreeMap<String, Option<FileEntry>>,
    /// `"same"` | `"differs"` | `"missing"`.
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareReport {
    pub generated_at: i64,
    pub sources: Vec<CompareSource>,
    pub rows: Vec<CompareRow>,
}

/// Build per-path rows over the sources that could be listed. A path is
/// `missing` when some source lacks it, `differs` when all have it but
/// hashes differ, `same` otherwise. `same` rows only with `include_same`.
pub fn compare_rows(listings: &[(String, &Listing)], include_same: bool) -> Vec<CompareRow> {
    let paths: BTreeSet<&String> = listings.iter().flat_map(|(_, l)| l.keys()).collect();
    let mut rows = Vec::new();
    for rel in paths {
        let entries: BTreeMap<String, Option<FileEntry>> = listings
            .iter()
            .map(|(id, l)| (id.clone(), l.get(rel).cloned()))
            .collect();
        let status = if entries.values().any(Option::is_none) {
            "missing"
        } else {
            let mut hashes = entries.values().flatten().map(|e| &e.hash);
            let first = hashes.next();
            if hashes.all(|h| Some(h) == first) {
                "same"
            } else {
                "differs"
            }
        };
        if status == "same" && !include_same {
            continue;
        }
        rows.push(CompareRow {
            rel_path: rel.clone(),
            entries,
            status: status.into(),
        });
    }
    rows
}

// ── restore ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub content: Option<String>,
    pub size: u64,
    pub hash: String,
    pub binary: bool,
}

pub fn read_result(bytes: Vec<u8>) -> ReadFileResult {
    let size = bytes.len() as u64;
    let hash = notes::file_version(&bytes);
    match String::from_utf8(bytes) {
        Ok(s) if size <= MAX_TEXT_BYTES => ReadFileResult {
            content: Some(s),
            size,
            hash,
            binary: false,
        },
        Ok(_) => ReadFileResult {
            content: None,
            size,
            hash,
            binary: false,
        },
        Err(_) => ReadFileResult {
            content: None,
            size,
            hash,
            binary: true,
        },
    }
}

/// `dir/stem.from-<source>-<ts>.ext` (no extension → no trailing dot);
/// `n > 0` adds `-n` before the extension to dodge an existing file.
pub fn restore_copy_rel(rel: &str, source_name: &str, ts: &str, n: u32) -> String {
    let (dir, file) = match rel.rfind('/') {
        Some(i) => (&rel[..=i], &rel[i + 1..]),
        None => ("", rel),
    };
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    let src = notes::slugify(source_name);
    let dup = if n > 0 {
        format!("-{n}")
    } else {
        String::new()
    };
    format!("{dir}{stem}.from-{src}-{ts}{dup}{ext}")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub rel_path: String,
    pub version: String,
}

/// Write `bytes` from a backup into the vault. `copy` creates a sibling
/// file; `overwrite` replaces `rel` only if its current version equals
/// `expected` (`None` = the file must not exist), else `StaleWrite`.
/// Caller holds the vault lock. Writes are own-change tagged (fsx).
pub fn restore_into_vault(
    vault_root: &Path,
    rel: &str,
    bytes: &[u8],
    mode: &str,
    expected: Option<&str>,
    source_name: &str,
    ts: &str,
) -> Result<RestoreResult, AppError> {
    let rel = safe_rel(rel)?;
    if is_excluded(&rel) {
        return Err(AppError::InvalidPath(format!(
            "not a backed-up path: {rel}"
        )));
    }
    let target_rel = match mode {
        "overwrite" => {
            let abs = notes::resolve_in_vault(vault_root, &rel)?;
            let current = notes::current_version(&abs)?;
            if current.as_deref() != expected {
                return Err(AppError::StaleWrite(current.unwrap_or_default()));
            }
            rel
        }
        "copy" => {
            let mut n = 0;
            loop {
                let cand = restore_copy_rel(&rel, source_name, ts, n);
                if !notes::resolve_in_vault(vault_root, &cand)?.exists() {
                    break cand;
                }
                n += 1;
            }
        }
        other => {
            return Err(AppError::Validation(format!(
                "unknown restore mode: {other}"
            )))
        }
    };
    let abs = notes::resolve_in_vault(vault_root, &target_rel)?;
    fsx::atomic_write(&abs, bytes)?;
    Ok(RestoreResult {
        rel_path: target_rel,
        version: notes::file_version(bytes),
    })
}

// ── SFTP host keys (TOFU) ────────────────────────────────────────────────

/// OpenSSH-style `SHA256:<base64, no padding>` fingerprint.
pub fn fingerprint_string(sha256: &[u8]) -> String {
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(sha256)
    )
}

#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyCheck {
    Trusted,
    Unknown,
    Mismatch,
}

pub fn check_host_key(pinned: Option<&str>, actual: &str) -> HostKeyCheck {
    match pinned {
        None => HostKeyCheck::Unknown,
        Some(p) if p == actual => HostKeyCheck::Trusted,
        Some(_) => HostKeyCheck::Mismatch,
    }
}

/// Gate before any credential is sent: only a pinned, matching key passes.
pub fn require_trusted(pinned: Option<&str>, actual: &str) -> Result<(), AppError> {
    match check_host_key(pinned, actual) {
        HostKeyCheck::Trusted => Ok(()),
        HostKeyCheck::Unknown => Err(AppError::Validation(format!(
            "Host key not confirmed yet (server presents {actual})"
        ))),
        HostKeyCheck::Mismatch => Err(AppError::Validation(format!(
            "Host key changed: the server now presents {actual}, expected {}",
            pinned.unwrap_or_default()
        ))),
    }
}

// ── auto-backup scheduling ───────────────────────────────────────────────

/// Bumped on every watcher batch (own or external change).
static CHANGE_GEN: AtomicU64 = AtomicU64::new(1);

fn run_gens() -> &'static StdMutex<HashMap<String, u64>> {
    static M: std::sync::OnceLock<StdMutex<HashMap<String, u64>>> = std::sync::OnceLock::new();
    M.get_or_init(|| StdMutex::new(HashMap::new()))
}

pub fn note_vault_changed() {
    CHANGE_GEN.fetch_add(1, Ordering::Relaxed);
}

/// Has the vault changed since `id` last started a run in this process?
/// (True before the first run: the app can't know what happened while it
/// was closed.)
pub fn changed_since_last_run(id: &str) -> bool {
    let cur = CHANGE_GEN.load(Ordering::Relaxed);
    let map = run_gens().lock().unwrap_or_else(|p| p.into_inner());
    map.get(id).is_none_or(|g| cur > *g)
}

pub fn record_run_start(id: &str) {
    let cur = CHANGE_GEN.load(Ordering::Relaxed);
    let mut map = run_gens().lock().unwrap_or_else(|p| p.into_inner());
    map.insert(id.to_string(), cur);
}

/// Failed runs (including a locked credential store) remain retryable without
/// another edit. The usual interval still bounds retries.
pub fn is_due(t: &StoredTarget, now: i64, vault_changed: bool) -> bool {
    if !(t.enabled && t.auto_backup && t.runnable() && (vault_changed || t.last_error.is_some())) {
        return false;
    }
    let last = t.last_backup_at.max(t.last_attempt_at);
    last.is_none_or(|l| now - l >= i64::from(t.interval_minutes) * 60)
}

// ── one run per target ───────────────────────────────────────────────────

static RUNNING: StdMutex<Option<HashSet<String>>> = StdMutex::new(None);

pub struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(set) = g.as_mut() {
            set.remove(&self.0);
        }
    }
}

pub fn try_begin(id: &str) -> Result<RunGuard, AppError> {
    let mut g = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    let set = g.get_or_insert_with(HashSet::new);
    if !set.insert(id.to_string()) {
        return Err(AppError::Conflict(format!(
            "a backup to target {id} is already running"
        )));
    }
    Ok(RunGuard(id.to_string()))
}

/// Open a target's file tree (connects for SFTP; refuses an unconfirmed
/// or changed host key before any credential is sent).
pub fn open_target(config_dir: &Path, t: &StoredTarget) -> Result<Box<dyn RemoteFs>, AppError> {
    match (t.kind.as_str(), &t.drive, &t.sftp) {
        (KIND_DRIVE, Some(d), _) => Ok(Box::new(LocalDirFs::new(PathBuf::from(&d.folder)))),
        (KIND_SFTP, _, Some(s)) => Ok(Box::new(crate::services::backup_sftp::connect(
            config_dir, &t.id, s,
        )?)),
        _ => Err(AppError::Validation(format!(
            "backup target {} is misconfigured",
            t.id
        ))),
    }
}

pub fn now_stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn noop() -> impl FnMut(usize, usize, &str) {
        |_, _, _| {}
    }

    fn drive_target(folder: &str) -> StoredTarget {
        StoredTarget {
            id: "t1".into(),
            kind: KIND_DRIVE.into(),
            name: "Drive".into(),
            enabled: true,
            auto_backup: true,
            interval_minutes: 30,
            last_backup_at: None,
            last_error: None,
            last_attempt_at: None,
            drive: Some(DriveConfig {
                folder: folder.into(),
            }),
            sftp: None,
        }
    }

    #[test]
    fn drive_candidates_found_under_fake_roots() {
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let c = tempdir().unwrap();
        std::fs::create_dir(a.path().join("My Drive")).unwrap();
        std::fs::create_dir(b.path().join("내 드라이브")).unwrap();
        let roots = vec![
            a.path().into(),
            b.path().into(),
            c.path().into(),
            a.path().into(),
        ];
        let found = drive_candidates_in(&roots);
        assert_eq!(found.len(), 2, "{found:?}");
        assert!(found[0].ends_with("My Drive"));
        assert!(found[1].ends_with("내 드라이브"));
    }

    #[test]
    fn drive_folder_must_be_outside_vault_and_not_contain_it() {
        let base = tempdir().unwrap();
        let vault = base.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let inside = vault.join("backup");
        assert!(matches!(
            resolve_drive_folder(&vault, inside.to_str().unwrap()),
            Err(AppError::Validation(_))
        ));
        assert!(matches!(
            resolve_drive_folder(&vault, base.path().to_str().unwrap()),
            Err(AppError::Validation(_))
        ));
        assert!(resolve_drive_folder(&vault, "relative/dir").is_err());
        let ok = base.path().join("elsewhere");
        assert_eq!(
            resolve_drive_folder(&vault, ok.to_str().unwrap()).unwrap(),
            ok
        );
        // A bare My Drive root gets naiteh-backup/<vault> appended.
        let md = base.path().join("My Drive");
        assert_eq!(
            resolve_drive_folder(&vault, md.to_str().unwrap()).unwrap(),
            md.join(BACKUP_ROOT_DIR).join("vault")
        );
    }

    #[test]
    fn remote_dir_normalization() {
        let v = Path::new("/x/myvault");
        assert_eq!(
            normalize_remote_dir("", v).unwrap(),
            "naiteh-backup/myvault"
        );
        assert_eq!(normalize_remote_dir("/srv//b/", v).unwrap(), "/srv/b");
        assert!(normalize_remote_dir("a/../b", v).is_err());
        assert!(normalize_remote_dir("/", v).is_err());
    }

    #[test]
    fn exclusion_rules() {
        for rel in [
            ".git/config",
            "sub/.git/HEAD",
            ".naiteh/workspace.json",
            ".naiteh/sync-state.json",
            ".naiteh-backup/manifest.json",
            "notes/.a.md.tmp.1-2-3",
            "notes/desktop.ini",
            "x/~$doc.docx",
            "a.crdownload",
        ] {
            assert!(is_excluded(rel), "{rel} should be excluded");
        }
        for rel in [
            "notes/a.md",
            ".naiteh/config.json",
            "notes/a.conflict-2026-01-01.md",
            "attachments/img.png",
        ] {
            assert!(!is_excluded(rel), "{rel} should be included");
        }
    }

    #[test]
    fn plan_classifies_new_changed_deleted_unchanged() {
        let e = |h: &str| FileEntry {
            size: 1,
            hash: h.into(),
            mtime: None,
        };
        let m = |h: &str| ManifestEntry {
            size: 1,
            hash: h.into(),
        };
        let local: Listing = [("new", e("n")), ("chg", e("c2")), ("same", e("s"))]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect();
        let remote: BTreeMap<String, ManifestEntry> =
            [("chg", m("c1")), ("same", m("s")), ("gone", m("g"))]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect();
        let p = plan(&local, &remote);
        assert_eq!(p.upload, vec!["chg".to_string(), "new".to_string()]);
        assert_eq!(p.trash, vec!["gone".to_string()]);
        assert_eq!(p.unchanged, 1);
    }

    #[test]
    fn run_uploads_incrementally_and_trashes_instead_of_deleting() {
        let vault = tempdir().unwrap();
        let target = tempdir().unwrap();
        write(vault.path(), "notes/a.md", "A");
        write(vault.path(), "notes/b.md", "B");
        write(vault.path(), ".git/config", "secret");
        write(vault.path(), ".naiteh/workspace.json", "{}");
        let remote = LocalDirFs::new(target.path().to_path_buf());

        let r1 = run_backup(vault.path(), &remote, "s1", 1, &mut noop()).unwrap();
        assert_eq!((r1.uploaded, r1.trashed, r1.unchanged), (2, 0, 0));
        assert!(!target.path().join(".git").exists());
        assert!(!target.path().join(".naiteh/workspace.json").exists());

        // unchanged second run
        let r2 = run_backup(vault.path(), &remote, "s2", 2, &mut noop()).unwrap();
        assert_eq!((r2.uploaded, r2.trashed, r2.unchanged), (0, 0, 2));

        // change a, delete b
        write(vault.path(), "notes/a.md", "A2");
        std::fs::remove_file(vault.path().join("notes/b.md")).unwrap();
        let mut events = Vec::new();
        let r3 = run_backup(vault.path(), &remote, "s3", 3, &mut |d, t, r: &str| {
            events.push((d, t, r.to_string()))
        })
        .unwrap();
        assert_eq!((r3.uploaded, r3.trashed, r3.unchanged), (1, 1, 0));
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].0, 2);
        assert_eq!(
            std::fs::read_to_string(target.path().join("notes/a.md")).unwrap(),
            "A2"
        );
        assert!(!target.path().join("notes/b.md").exists());
        assert_eq!(
            std::fs::read_to_string(target.path().join(".naiteh-backup/trash/s3/notes/b.md"))
                .unwrap(),
            "B"
        );
        let m = load_manifest(&remote).unwrap();
        assert_eq!(m.files.len(), 1);
        assert!(m.files.contains_key("notes/a.md"));
    }

    #[test]
    fn run_refuses_target_of_another_vault() {
        let v1 = tempdir().unwrap();
        let v2 = tempdir().unwrap();
        let target = tempdir().unwrap();
        write(v1.path(), "a.md", "1");
        let remote = LocalDirFs::new(target.path().to_path_buf());
        run_backup(v1.path(), &remote, "s", 1, &mut noop()).unwrap();
        assert!(matches!(
            run_backup(v2.path(), &remote, "s", 2, &mut noop()),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn tampered_manifest_paths_are_dropped() {
        let target = tempdir().unwrap();
        let remote = LocalDirFs::new(target.path().to_path_buf());
        write(
            target.path(),
            MANIFEST_REL,
            r#"{"files":{"../evil":{"size":1,"hash":"x"},"ok.md":{"size":1,"hash":"y"}}}"#,
        );
        let m = load_manifest(&remote).unwrap();
        assert_eq!(m.files.keys().collect::<Vec<_>>(), vec!["ok.md"]);
        assert!(remote.read("../evil").is_err());
    }

    #[test]
    fn compare_across_three_sources() {
        let vault = tempdir().unwrap();
        let drive = tempdir().unwrap();
        let sftp = tempdir().unwrap(); // stands in for the SFTP server
        write(vault.path(), "same.md", "S");
        write(vault.path(), "diff.md", "local");
        write(vault.path(), "onlylocal.md", "L");
        let d = LocalDirFs::new(drive.path().to_path_buf());
        let s = LocalDirFs::new(sftp.path().to_path_buf());
        run_backup(vault.path(), &d, "x", 1, &mut noop()).unwrap();
        run_backup(vault.path(), &s, "x", 1, &mut noop()).unwrap();
        // drift: drive copy edited, sftp missing one file, new local file
        write(drive.path(), "diff.md", "drive edit");
        write(vault.path(), "fresh.md", "F");

        let local = scan_local(vault.path()).unwrap();
        let dl = scan_remote(&d, true).unwrap();
        let sl = scan_remote(&s, false).unwrap(); // manifest
        let sources = vec![
            (LOCAL_SOURCE.to_string(), &local),
            ("drive".to_string(), &dl),
            ("sftp".to_string(), &sl),
        ];
        let rows = compare_rows(&sources, false);
        let status: BTreeMap<_, _> = rows
            .iter()
            .map(|r| (r.rel_path.as_str(), r.status.as_str()))
            .collect();
        assert_eq!(status.get("diff.md"), Some(&"differs"));
        assert_eq!(status.get("fresh.md"), Some(&"missing"));
        assert!(!status.contains_key("same.md"));
        let fresh = rows.iter().find(|r| r.rel_path == "fresh.md").unwrap();
        assert!(fresh.entries["drive"].is_none());
        assert!(fresh.entries[LOCAL_SOURCE].is_some());
        // sftp manifest entries carry no mtime; drive ones do
        let diff = rows.iter().find(|r| r.rel_path == "diff.md").unwrap();
        assert!(diff.entries["sftp"].as_ref().unwrap().mtime.is_none());
        assert!(diff.entries["drive"].as_ref().unwrap().mtime.is_some());

        let all = compare_rows(&sources, true);
        assert!(all
            .iter()
            .any(|r| r.rel_path == "same.md" && r.status == "same"));
        // deep (hashing) scan of the stand-in sees the same files
        let deep = scan_remote(&s, true).unwrap();
        assert_eq!(
            deep.keys().collect::<Vec<_>>(),
            sl.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn host_key_tofu() {
        let fp = fingerprint_string(&[0u8; 32]);
        assert!(fp.starts_with("SHA256:") && !fp.ends_with('='));
        assert_eq!(check_host_key(None, &fp), HostKeyCheck::Unknown);
        assert_eq!(check_host_key(Some(&fp), &fp), HostKeyCheck::Trusted);
        assert_eq!(
            check_host_key(Some("SHA256:x"), &fp),
            HostKeyCheck::Mismatch
        );
        assert!(require_trusted(Some(&fp), &fp).is_ok());
        match require_trusted(Some("SHA256:x"), &fp) {
            Err(AppError::Validation(m)) => assert!(m.starts_with("Host key changed")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            require_trusted(None, &fp),
            Err(AppError::Validation(_))
        ));
    }

    #[test]
    fn restore_copy_naming() {
        assert_eq!(
            restore_copy_rel("notes/a.md", "My Drive", "20260101T000000Z", 0),
            "notes/a.from-my-drive-20260101T000000Z.md"
        );
        assert_eq!(
            restore_copy_rel("README", "srv", "t", 2),
            "README.from-srv-t-2"
        );
        assert_eq!(restore_copy_rel(".hidden", "s", "t", 0), ".hidden.from-s-t");
    }

    #[test]
    fn restore_copy_and_overwrite_versioning() {
        let vault = tempdir().unwrap();
        write(vault.path(), "notes/a.md", "local");
        let r = restore_into_vault(
            vault.path(),
            "notes/a.md",
            b"old",
            "copy",
            None,
            "Drive",
            "t",
        )
        .unwrap();
        assert_eq!(r.rel_path, "notes/a.from-drive-t.md");
        let r2 = restore_into_vault(
            vault.path(),
            "notes/a.md",
            b"old",
            "copy",
            None,
            "Drive",
            "t",
        )
        .unwrap();
        assert_eq!(r2.rel_path, "notes/a.from-drive-t-1.md");
        assert_eq!(
            std::fs::read_to_string(vault.path().join("notes/a.md")).unwrap(),
            "local"
        );

        // overwrite with a stale version → StaleWrite carrying the current one
        let cur = notes::file_version(b"local");
        match restore_into_vault(
            vault.path(),
            "notes/a.md",
            b"old",
            "overwrite",
            Some("bad"),
            "D",
            "t",
        ) {
            Err(AppError::StaleWrite(v)) => assert_eq!(v, cur),
            other => panic!("{other:?}"),
        }
        // None expects absence
        assert!(matches!(
            restore_into_vault(
                vault.path(),
                "notes/a.md",
                b"old",
                "overwrite",
                None,
                "D",
                "t"
            ),
            Err(AppError::StaleWrite(_))
        ));
        let ok = restore_into_vault(
            vault.path(),
            "notes/a.md",
            b"old",
            "overwrite",
            Some(&cur),
            "D",
            "t",
        )
        .unwrap();
        assert_eq!(ok.version, notes::file_version(b"old"));
        assert_eq!(
            std::fs::read_to_string(vault.path().join("notes/a.md")).unwrap(),
            "old"
        );
        assert!(restore_into_vault(vault.path(), "../x.md", b"", "copy", None, "D", "t").is_err());
        assert!(restore_into_vault(
            vault.path(),
            ".git/config",
            b"",
            "overwrite",
            None,
            "D",
            "t"
        )
        .is_err());
    }

    #[test]
    fn scheduler_due_logic() {
        let mut t = drive_target("/x");
        let now = 10_000;
        assert!(is_due(&t, now, true), "never backed up");
        assert!(!is_due(&t, now, false), "vault unchanged");
        t.last_backup_at = Some(now - 29 * 60);
        assert!(!is_due(&t, now, true), "too recent");
        t.last_backup_at = Some(now - 30 * 60);
        assert!(is_due(&t, now, true));
        t.last_attempt_at = Some(now - 60);
        assert!(!is_due(&t, now, true), "recent failed attempt");
        t.last_error = Some("Secure credential store unavailable".into());
        assert!(
            !is_due(&t, now, false),
            "failed runs still respect the interval"
        );
        t.last_attempt_at = Some(now - 30 * 60);
        assert!(
            is_due(&t, now, false),
            "retry store failures even without another edit"
        );
        t.last_error = None;
        assert!(
            !is_due(&t, now, false),
            "successful unchanged runs remain idle"
        );
        t.last_attempt_at = None;
        t.auto_backup = false;
        assert!(!is_due(&t, now, true));
        t.auto_backup = true;
        t.enabled = false;
        assert!(!is_due(&t, now, true));

        // change generations
        record_run_start("gen-test");
        assert!(!changed_since_last_run("gen-test"));
        note_vault_changed();
        assert!(changed_since_last_run("gen-test"));
        assert!(changed_since_last_run("never-ran"));
    }

    #[test]
    fn view_json_never_contains_secrets() {
        let t = StoredTarget {
            kind: KIND_SFTP.into(),
            drive: None,
            sftp: Some(StoredSftp {
                host: "h".into(),
                port: 22,
                username: "u".into(),
                auth_method: "password".into(),
                key_path: None,
                password: Some("hunter2-secret".into()),
                passphrase: Some("pp-secret".into()),
                password_ref: None,
                passphrase_ref: None,
                remote_dir: "d".into(),
                host_key_fingerprint: None,
            }),
            ..drive_target("/x")
        };
        let json = serde_json::to_string(&t.view()).unwrap();
        assert!(!json.contains("hunter2-secret") && !json.contains("pp-secret"));
        assert!(json.contains(r#""hasPassword":true"#));
        assert!(json.contains(r#""hasPassphrase":true"#));
        assert!(!json.contains("\"drive\""));
        assert!(!t.runnable(), "unconfirmed host key");
        assert!(!format!("{t:?}").contains("hunter2-secret"));
        assert!(!format!("{t:?}").contains("pp-secret"));
    }

    fn legacy_sftp_file(dir: &Path) -> Vec<u8> {
        let mut target = credentials::json(&drive_target("/drive")).unwrap();
        target["id"] = "sftp-test".into();
        target["kind"] = KIND_SFTP.into();
        target["drive"] = Value::Null;
        target["sftp"] = serde_json::json!({
            "host":"example.test", "port":22, "username":"u", "authMethod":"password",
            "keyPath":"/private/key", "password":"  password-secret  ", "passphrase":"  passphrase-secret  ",
            "remoteDir":"backup", "hostKeyFingerprint":"SHA256:pin"
        });
        fsx::write_json(&targets_path(dir), &serde_json::json!({"targets":[target]})).unwrap();
        std::fs::read(targets_path(dir)).unwrap()
    }

    #[test]
    fn sftp_migration_is_references_only_idempotent_and_preserves_whitespace() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        legacy_sftp_file(dir.path());
        assert_eq!(
            migrate_credentials_with_store(dir.path(), &store, None).unwrap(),
            2
        );
        let target = find_target(dir.path(), "sftp-test").unwrap();
        let sftp = target.sftp.as_ref().unwrap();
        assert!(sftp.password.is_none() && sftp.passphrase.is_none());
        assert!(target.view().sftp.unwrap().has_password);
        assert_eq!(
            resolve_sftp_secret_with_store(dir.path(), &target.id, sftp, &store)
                .unwrap()
                .as_deref(),
            Some("  password-secret  ")
        );
        assert_eq!(
            credentials::resolve(&store, sftp.passphrase_ref.as_ref().unwrap()).unwrap(),
            "  passphrase-secret  "
        );
        let bytes = std::fs::read(targets_path(dir.path())).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("password-secret"));
        assert!(!String::from_utf8_lossy(&bytes).contains("passphrase-secret"));
        assert_eq!(
            migrate_credentials_with_store(dir.path(), &store, None).unwrap(),
            0
        );
        assert_eq!(std::fs::read(targets_path(dir.path())).unwrap(), bytes);
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn legacy_error_messages_are_redacted_in_views_and_migrated_json() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        legacy_sftp_file(dir.path());
        let mut raw: Value = fsx::read_json(&targets_path(dir.path())).unwrap();
        raw["targets"][0]["lastError"] =
            "SSH rejected:   password-secret  ,   passphrase-secret  ".into();
        fsx::write_json(&targets_path(dir.path()), &raw).unwrap();
        let before = find_target(dir.path(), "sftp-test").unwrap();
        assert!(!serde_json::to_string(&before.view())
            .unwrap()
            .contains("password-secret"));
        assert!(!format!("{before:?}").contains("passphrase-secret"));
        migrate_credentials_with_store(dir.path(), &store, None).unwrap();
        let raw = std::fs::read_to_string(targets_path(dir.path())).unwrap();
        assert!(!raw.contains("password-secret") && !raw.contains("passphrase-secret"));
    }

    #[test]
    fn sftp_migration_failure_preserves_plaintext_and_cleans_partial_staging() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        let original = legacy_sftp_file(dir.path());
        store.fail_after_writes(1);
        assert!(migrate_credentials_with_store(dir.path(), &store, None).is_err());
        assert_eq!(std::fs::read(targets_path(dir.path())).unwrap(), original);
        assert_eq!(store.len(), 0);
        store.fail_after_writes(usize::MAX);
        assert_eq!(
            migrate_credentials_with_store(dir.path(), &store, None).unwrap(),
            2
        );
    }

    #[test]
    fn failed_sftp_replacement_leaves_previous_reference_usable() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        legacy_sftp_file(dir.path());
        migrate_credentials_with_store(dir.path(), &store, None).unwrap();
        let previous = std::fs::read(targets_path(dir.path())).unwrap();
        let old = find_target(dir.path(), "sftp-test")
            .unwrap()
            .sftp
            .unwrap()
            .password_ref
            .unwrap();
        store.fail_after_writes(0);
        assert!(modify_targets_with_store(dir.path(), &store, &[], |list| {
            list[0].sftp.as_mut().unwrap().password = Some("replacement-secret".into());
            Ok(())
        })
        .is_err());
        assert_eq!(std::fs::read(targets_path(dir.path())).unwrap(), previous);
        assert_eq!(
            credentials::resolve(&store, &old).unwrap(),
            "  password-secret  "
        );
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn sftp_keep_set_clear_uses_exact_password_and_cleans_old_references() {
        let dir = tempdir().unwrap();
        legacy_sftp_file(dir.path());
        let view = modify_target_credentials(
            dir.path(),
            "sftp-test",
            Some("  new-password  ".into()),
            Some("  new-passphrase  ".into()),
            |_| Ok(()),
        )
        .unwrap();
        assert!(view.sftp.unwrap().has_password);
        let stored = find_target(dir.path(), "sftp-test").unwrap().sftp.unwrap();
        assert_eq!(
            resolve_sftp_secret(dir.path(), "sftp-test", &stored)
                .unwrap()
                .as_deref(),
            Some("  new-password  ")
        );
        modify_target_credentials(dir.path(), "sftp-test", None, None, |t| {
            t.name = "Renamed".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            find_target(dir.path(), "sftp-test").unwrap().sftp.unwrap(),
            stored
        );
        let view = modify_target_credentials(
            dir.path(),
            "sftp-test",
            Some(String::new()),
            Some(String::new()),
            |_| Ok(()),
        )
        .unwrap();
        assert!(!view.sftp.as_ref().unwrap().has_password);
        assert!(!view.sftp.as_ref().unwrap().has_passphrase);
        credentials::with_store(|store| {
            assert!(credentials::resolve(store, stored.password_ref.as_ref().unwrap()).is_err());
            assert!(credentials::resolve(store, stored.passphrase_ref.as_ref().unwrap()).is_err());
        });
        let raw = std::fs::read_to_string(targets_path(dir.path())).unwrap();
        assert!(!raw.contains("password-secret") && !raw.contains("new-password"));
    }

    #[test]
    fn mixed_sftp_set_clear_recovers_missing_reference() {
        for password_auth in [true, false] {
            for clear in [false, true] {
                let dir = tempdir().unwrap();
                legacy_sftp_file(dir.path());
                let mut original: Value = fsx::read_json(&targets_path(dir.path())).unwrap();
                let sftp = &mut original["targets"][0]["sftp"];
                let reference = if password_auth {
                    "passwordRef"
                } else {
                    "passphraseRef"
                };
                sftp[reference] = "v1-00000000000000000000000000000000".into();
                sftp["authMethod"] = if password_auth { "password" } else { "key" }.into();
                fsx::write_json(&targets_path(dir.path()), &original).unwrap();
                let before = std::fs::read(targets_path(dir.path())).unwrap();
                let expected = find_target(dir.path(), "sftp-test").unwrap().sftp.unwrap();
                assert!(resolve_sftp_secret(dir.path(), "sftp-test", &expected).is_err());
                assert!(migrate_credentials(dir.path()).is_err());
                assert_eq!(std::fs::read(targets_path(dir.path())).unwrap(), before);

                let field = if password_auth {
                    "password"
                } else {
                    "passphrase"
                };
                let store = credentials::MemoryStore::default();
                store.fail_after_writes(0);
                let error = modify_targets_with_store(
                    dir.path(),
                    &store,
                    &[("sftp-test", field)],
                    |targets| {
                        let sftp = targets[0].sftp.as_mut().unwrap();
                        if password_auth {
                            sftp.password = (!clear).then(|| "  replacement  ".into());
                            sftp.password_ref = None;
                        } else {
                            sftp.passphrase = (!clear).then(|| "  replacement  ".into());
                            sftp.passphrase_ref = None;
                        }
                        Ok(())
                    },
                )
                .unwrap_err();
                assert!(matches!(error, AppError::Io(_)), "{error:?}");
                assert_eq!(std::fs::read(targets_path(dir.path())).unwrap(), before);
                assert_eq!(store.len(), 0);

                let value = if clear {
                    String::new()
                } else {
                    "  replacement  ".into()
                };
                modify_target_credentials(
                    dir.path(),
                    "sftp-test",
                    password_auth.then(|| value.clone()),
                    (!password_auth).then_some(value),
                    |_| Ok(()),
                )
                .unwrap();
                let stored = find_target(dir.path(), "sftp-test").unwrap().sftp.unwrap();
                assert_eq!(
                    resolve_sftp_secret(dir.path(), "sftp-test", &stored)
                        .unwrap()
                        .as_deref(),
                    (!clear).then_some("  replacement  ")
                );
                let raw = std::fs::read_to_string(targets_path(dir.path())).unwrap();
                assert!(!raw.contains(if password_auth {
                    "password-secret"
                } else {
                    "passphrase-secret"
                }));
                assert!(!raw.contains("replacement"));
            }
        }
    }

    #[test]
    fn secret_updates_redact_previous_credentials_before_returning_view() {
        for clear in [false, true] {
            let dir = tempdir().unwrap();
            legacy_sftp_file(dir.path());
            let mut raw: Value = fsx::read_json(&targets_path(dir.path())).unwrap();
            raw["targets"][0]["lastError"] =
                "SSH rejected:   password-secret  ,   passphrase-secret  ".into();
            fsx::write_json(&targets_path(dir.path()), &raw).unwrap();
            let view = modify_target_credentials(
                dir.path(),
                "sftp-test",
                Some(if clear {
                    String::new()
                } else {
                    "new-password".into()
                }),
                Some(if clear {
                    String::new()
                } else {
                    "new-passphrase".into()
                }),
                |_| Ok(()),
            )
            .unwrap();
            let serialized = serde_json::to_string(&view).unwrap();
            assert!(!serialized.contains("password-secret"));
            assert!(!serialized.contains("passphrase-secret"));
            let stored = find_target(dir.path(), "sftp-test").unwrap();
            assert_eq!(view.last_error, stored.last_error);
            let raw = std::fs::read_to_string(targets_path(dir.path())).unwrap();
            assert!(!raw.contains("password-secret"));
            assert!(!raw.contains("passphrase-secret"));
        }
    }

    #[test]
    fn unrelated_target_changes_and_selected_auth_do_not_resolve_other_secrets() {
        let dir = tempdir().unwrap();
        let store = credentials::MemoryStore::default();
        legacy_sftp_file(dir.path());
        store.unavailable(true);
        modify_targets_with_store(dir.path(), &store, &[], |targets| {
            targets.insert(0, drive_target("/drive"));
            Ok(())
        })
        .unwrap();
        modify_targets_with_store(dir.path(), &store, &[], |targets| {
            targets.remove(0);
            targets[0].name = "Renamed".into();
            Ok(())
        })
        .unwrap();
        let sftp = find_target(dir.path(), "sftp-test").unwrap().sftp.unwrap();
        assert_eq!(sftp.password.as_deref(), Some("  password-secret  "));
        let previous = std::fs::read(targets_path(dir.path())).unwrap();
        assert!(
            modify_targets_with_store(dir.path(), &store, &[], |targets| {
                let sftp = targets[0].sftp.as_mut().unwrap();
                sftp.password = None;
                sftp.password_ref = None;
                Ok(())
            })
            .is_err()
        );
        assert_eq!(std::fs::read(targets_path(dir.path())).unwrap(), previous);
        store.unavailable(false);
        assert_eq!(
            resolve_sftp_secret_with_store(dir.path(), "sftp-test", &sftp, &store)
                .unwrap()
                .as_deref(),
            Some("  password-secret  ")
        );
        // Password auth did not migrate or look up the unused passphrase.
        assert_eq!(store.len(), 1);
        let stored = find_target(dir.path(), "sftp-test").unwrap().sftp.unwrap();
        assert_eq!(stored.passphrase.as_deref(), Some("  passphrase-secret  "));
        assert!(stored.passphrase_ref.is_none());
    }

    #[test]
    fn run_guard_rejects_concurrent_runs() {
        let g = try_begin("busy-test").unwrap();
        assert!(matches!(try_begin("busy-test"), Err(AppError::Conflict(_))));
        drop(g);
        assert!(try_begin("busy-test").is_ok());
    }

    #[test]
    fn probe_writes_reads_and_removes() {
        let target = tempdir().unwrap();
        let remote = LocalDirFs::new(target.path().to_path_buf());
        probe(&remote, "abc").unwrap();
        assert!(!target.path().join(META_DIR).join("probe-abc.txt").exists());
    }

    #[test]
    fn read_result_flags_binary_and_large() {
        let r = read_result(b"hi".to_vec());
        assert_eq!(r.content.as_deref(), Some("hi"));
        assert!(!r.binary);
        let b = read_result(vec![0xff, 0xfe]);
        assert!(b.binary && b.content.is_none());
    }
}
