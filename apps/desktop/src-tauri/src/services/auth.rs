//! Audit-log storage and legacy account verification for one-time migration.
//! See vault/wiki/ipc-api.md ("Auth & Audit") for migration and audit APIs.
//!
//! Existing `auth.json` accounts may use Argon2id PHC strings or the old
//! `sha256(username:password:static_pepper)` digest. Successful SHA-256
//! verification upgrades the hash to Argon2id. Missing or corrupt stores
//! never create accounts or fall back to default credentials.

use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{AppError, AuditLogEntry, AuthSession, UserRole};
use crate::services::fs as fsx;

const AUTH_FILE: &str = "auth.json";
const AUDIT_FILE: &str = "audit-log.jsonl";
const AUDIT_FILE_ROTATED: &str = "audit-log.1.jsonl";
/// Rotate the audit log once it crosses this size. Single-level
/// rotation bounds total audit history to ~2× this.
const MAX_AUDIT_BYTES: u64 = 5 * 1024 * 1024;
/// Legacy hash pepper, retained only for migrating older `auth.json`
/// files to Argon2. New hashes ignore it entirely.
const LEGACY_PASSWORD_PEPPER: &str = "naiteh-local-auth-v1";

/// The one message for every credential failure (unknown user, wrong
/// password, wrong password on a disabled account) so the response
/// never reveals which part was wrong.
pub const INVALID_CREDENTIALS: &str = "invalid username or password";
/// New app-lock passwords use this minimum; legacy passwords may be shorter.
pub const MIN_PASSWORD_CHARS: usize = 8;
/// Upper bound so a multi-megabyte "password" can't pin a CPU in Argon2.
pub const MAX_PASSWORD_CHARS: usize = 1024;
/// `auth_log_action` truncates `detail` to this many characters.
pub const MAX_AUDIT_DETAIL_CHARS: usize = 512;

/// Work events the renderer may record through `auth_log_action`.
/// Everything else (login_*, session_resume, user_*, password_changed)
/// is written only by the backend itself.
pub const CLIENT_AUDIT_ACTIONS: &[&str] = &[
    "logout",
    "note_open",
    "note_save",
    "note_create",
    "note_rename",
    "note_delete",
    "notes_create_dir",
    "notes_rename_dir",
    "notes_delete_dir",
    "journal_open",
    "journal_save",
    "quick_note_create",
    "vault_switch",
    "evernote_import",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthStore {
    users: Vec<StoredUser>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredUser {
    username: String,
    role: UserRole,
    active: bool,
    /// Argon2id PHC string (`$argon2id$v=19$m=…$t=…$p=…$<salt>$<hash>`)
    /// or a legacy 64-char SHA-256 hex digest, upgraded by `authenticate`.
    password_hash: String,
    /// Older stores omit this flag; successful verification also detects
    /// a historical default password equal to the username.
    #[serde(default)]
    must_change_password: bool,
}

/// A successful legacy account password check; does not open a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginOutcome {
    pub session: AuthSession,
    pub must_change_password: bool,
}

// ── path helpers ─────────────────────────────────────────────────────

fn auth_path(config_dir: &Path) -> PathBuf {
    config_dir.join(AUTH_FILE)
}

fn audit_path(config_dir: &Path) -> PathBuf {
    config_dir.join(AUDIT_FILE)
}

fn canonical_username(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

// ── hashing ──────────────────────────────────────────────────────────

/// Hash a bounded password without imposing a minimum on legacy credentials.
pub(crate) fn hash_password_argon2(password: &str) -> Result<String, AppError> {
    validate_password_length(password)?;
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AppError::Io(format!("argon2 hash: {e}")))
}

fn verify_password(password: &str, stored: &str, username_canonical: &str) -> bool {
    if is_legacy_sha256(stored) {
        return verify_legacy_sha256(password, stored, username_canonical);
    }
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// A fixed Argon2id hash (same default parameters as real hashes) that
/// unknown-username logins are verified against, so "no such user"
/// costs the same time as "wrong password".
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| {
        hash_password_argon2("naiteh-timing-equalizer").expect("argon2 hash of constant")
    })
}

fn is_legacy_sha256(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

fn verify_legacy_sha256(password: &str, stored: &str, username_canonical: &str) -> bool {
    let input = format!("{username_canonical}:{password}:{LEGACY_PASSWORD_PEPPER}");
    let digest = Sha256::digest(input.as_bytes());
    let recomputed: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    // Constant-time isn't critical for the legacy path (it's only hit
    // during one-shot migrations), but match length so an attacker can't
    // shave time off via early-exit comparison.
    recomputed.len() == stored.len()
        && recomputed
            .as_bytes()
            .iter()
            .zip(stored.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

// ── validation ───────────────────────────────────────────────────────

fn validate_password_length(password: &str) -> Result<(), AppError> {
    if password.chars().take(MAX_PASSWORD_CHARS + 1).count() > MAX_PASSWORD_CHARS {
        return Err(AppError::Validation(format!(
            "password must be at most {MAX_PASSWORD_CHARS} characters"
        )));
    }
    Ok(())
}

// ── store IO ─────────────────────────────────────────────────────────

fn save_store(config_dir: &Path, store: &AuthStore) -> Result<(), AppError> {
    fsx::ensure_dir(config_dir)?;
    fsx::write_json(&auth_path(config_dir), store)
}

fn find_user(store: &AuthStore, username_canonical: &str) -> Option<usize> {
    store
        .users
        .iter()
        .position(|u| canonical_username(&u.username) == username_canonical)
}

// ── public API ───────────────────────────────────────────────────────

/// Verify an explicit active legacy account for one-time migration.
/// Missing stores return `NotFound`; malformed stores or stores without an
/// active administrator return `ConfigCorrupt`. Slow (Argon2): call off the
/// main thread. Unknown users use a dummy hash; disabled accounts are only
/// reported after their password checks out.
pub fn authenticate(
    config_dir: &Path,
    username: &str,
    password: &str,
) -> Result<LoginOutcome, AppError> {
    let username = canonical_username(username);
    if username.is_empty() || password.is_empty() {
        return Err(AppError::Unauthorized(
            "username and password are required".into(),
        ));
    }
    validate_password_length(password)?;
    let mut store: AuthStore = fsx::read_json(&auth_path(config_dir))?;

    if !store
        .users
        .iter()
        .any(|u| u.active && u.role == UserRole::Admin)
    {
        return Err(AppError::ConfigCorrupt(
            "auth.json has no active administrator account; restore it from a backup \
             before migrating"
                .into(),
        ));
    }

    let Some(user_idx) = find_user(&store, &username) else {
        // Burn the same Argon2 time as a real verification.
        let _ = verify_password(password, dummy_hash(), &username);
        return Err(AppError::Unauthorized(INVALID_CREDENTIALS.into()));
    };

    {
        let user = &store.users[user_idx];
        if !verify_password(password, &user.password_hash, &username) {
            return Err(AppError::Unauthorized(INVALID_CREDENTIALS.into()));
        }
        if !user.active {
            return Err(AppError::Unauthorized("account is disabled".into()));
        }
    }

    let mut dirty = false;
    // Transparent upgrade from legacy SHA-256 to Argon2.
    if is_legacy_sha256(&store.users[user_idx].password_hash) {
        store.users[user_idx].password_hash = hash_password_argon2(password)?;
        dirty = true;
    }
    // Older auth.json files predate the flag: a password equal to the
    // username is the seeded default and must be changed.
    if !store.users[user_idx].must_change_password && canonical_username(password) == username {
        store.users[user_idx].must_change_password = true;
        dirty = true;
    }
    if dirty {
        save_store(config_dir, &store)?;
    }

    let user = &store.users[user_idx];
    Ok(LoginOutcome {
        session: AuthSession {
            username: user.username.clone(),
            role: user.role.clone(),
        },
        must_change_password: user.must_change_password,
    })
}

/// Record a renderer-originated work event (`auth_log_action`). Only
/// [`CLIENT_AUDIT_ACTIONS`] are accepted; `detail` is truncated to
/// [`MAX_AUDIT_DETAIL_CHARS`].
pub fn log_client_action(
    config_dir: &Path,
    username: &str,
    action: &str,
    detail: Option<String>,
) -> Result<(), AppError> {
    let action = action.trim();
    if !CLIENT_AUDIT_ACTIONS.contains(&action) {
        return Err(AppError::Validation(format!(
            "unknown audit action: {}",
            truncate_chars(action, 64)
        )));
    }
    let detail = detail.map(|d| truncate_chars(d.trim(), MAX_AUDIT_DETAIL_CHARS));
    append_audit(config_dir, username, action, detail)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

pub fn append_audit(
    config_dir: &Path,
    username: &str,
    action: &str,
    detail: Option<String>,
) -> Result<(), AppError> {
    let username = canonical_username(username);
    let action = action.trim();
    if username.is_empty() || action.is_empty() {
        return Err(AppError::Validation(
            "audit username and action are required".into(),
        ));
    }
    fsx::ensure_dir(config_dir)?;
    let entry = AuditLogEntry {
        timestamp: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
        username,
        action: action.to_string(),
        detail: detail
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty()),
    };
    let json = serde_json::to_string(&entry)
        .map_err(|e| AppError::Io(format!("serialize audit entry: {e}")))?;

    let path = audit_path(config_dir);
    rotate_audit_if_needed(config_dir, &path);

    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{json}")?;
    Ok(())
}

/// When the active log reaches the size cap, move it to
/// `audit-log.1.jsonl` (overwriting any prior rotation) so the next
/// append starts a fresh file. Best-effort: a failed rename just means
/// the file keeps growing a bit longer.
fn rotate_audit_if_needed(config_dir: &Path, path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() >= MAX_AUDIT_BYTES {
            let rotated = config_dir.join(AUDIT_FILE_ROTATED);
            let _ = std::fs::rename(path, rotated);
        }
    }
}

pub fn read_audit(config_dir: &Path, limit: u32) -> Result<Vec<AuditLogEntry>, AppError> {
    let limit = limit.clamp(1, 500) as usize;
    // Read only the file's tail rather than slurping the whole thing —
    // the active log can be multiple MB before rotation kicks in.
    let lines = read_last_lines(&audit_path(config_dir), limit)?;
    let mut entries = Vec::with_capacity(limit);
    for line in lines.iter().rev() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<AuditLogEntry>(line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// Read the last `n` newline-delimited lines of a file by seeking from
/// the end in chunks, without loading the whole file. Returns lines in
/// file order (oldest first); caller reverses for newest-first.
fn read_last_lines(path: &Path, n: usize) -> Result<Vec<String>, AppError> {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(e.to_string())),
    };
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(Vec::new());
    }

    const CHUNK: u64 = 8192;
    let mut pos = len;
    let mut buf: Vec<u8> = Vec::new();
    // Read backwards until we've seen more than `n` newlines (so we're
    // sure to have `n` complete lines) or reached the start of the file.
    while pos > 0 {
        let read_size = CHUNK.min(pos);
        pos -= read_size;
        file.seek(SeekFrom::Start(pos))?;
        let mut chunk = vec![0u8; read_size as usize];
        file.read_exact(&mut chunk)?;
        chunk.extend_from_slice(&buf);
        buf = chunk;
        if buf.iter().filter(|&&b| b == b'\n').count() > n {
            break;
        }
    }

    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    if lines.len() > n {
        lines = lines.split_off(lines.len() - n);
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn user(name: &str, role: UserRole, active: bool, password: &str) -> StoredUser {
        StoredUser {
            username: name.into(),
            role,
            active,
            password_hash: hash_password_argon2(password).unwrap(),
            must_change_password: false,
        }
    }

    fn reload(dir: &Path) -> AuthStore {
        serde_json::from_str(&std::fs::read_to_string(auth_path(dir)).unwrap()).unwrap()
    }

    /// An existing administrator plus any extra legacy accounts.
    fn store_with(dir: &Path, extra: Vec<StoredUser>) {
        let mut users = vec![user("admin", UserRole::Admin, true, "admin-pass-1")];
        users.extend(extra);
        save_store(dir, &AuthStore { users }).unwrap();
    }

    fn unauthorized_msg(err: AppError) -> String {
        match err {
            AppError::Unauthorized(m) => m,
            other => panic!("expected Unauthorized, got {other:?}"),
        }
    }

    #[test]
    fn missing_store_returns_not_found_without_seeding() {
        let dir = tempdir().unwrap();
        for config_dir in [dir.path().to_path_buf(), dir.path().join("missing")] {
            let err = authenticate(&config_dir, "admin", "admin").unwrap_err();
            assert!(matches!(err, AppError::NotFound(_)), "got {err:?}");
            assert!(!auth_path(&config_dir).exists());
        }
        assert!(!dir.path().join("missing").exists());
    }

    #[test]
    fn username_and_password_must_be_explicit() {
        let dir = tempdir().unwrap();
        for (username, password) in [("", "admin"), ("   ", "admin"), ("admin", "")] {
            let err = authenticate(dir.path(), username, password).unwrap_err();
            assert_eq!(unauthorized_msg(err), "username and password are required");
        }
        assert!(!auth_path(dir.path()).exists());
    }

    #[test]
    fn existing_argon2_account_authenticates_case_insensitively() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        let before = reload(dir.path());
        let out = authenticate(dir.path(), "  AdMiN  ", "admin-pass-1").unwrap();
        assert_eq!(out.session.username, "admin");
        assert_eq!(out.session.role, UserRole::Admin);
        assert!(!out.must_change_password);
        assert_eq!(reload(dir.path()), before);
    }

    #[test]
    fn wrong_password_is_unauthorized() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        let before = reload(dir.path());
        let err = authenticate(dir.path(), "admin", "wrong").unwrap_err();
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
        assert_eq!(reload(dir.path()), before);
    }

    #[test]
    fn unknown_user_gets_the_generic_message() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        let before = reload(dir.path());
        let err = authenticate(dir.path(), "nobody", "whatever").unwrap_err();
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
        assert_eq!(reload(dir.path()), before);
        // The timing-equalizer hash has real Argon2 parameters.
        assert!(PasswordHash::new(dummy_hash()).is_ok());
        assert!(dummy_hash().starts_with("$argon2id$"));
    }

    #[test]
    fn disabled_accounts_cannot_authenticate_or_upgrade_their_hash() {
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("bob", UserRole::User, false, "bob-pass-1")],
        );
        let mut store = reload(dir.path());
        let legacy = format!(
            "{:x}",
            Sha256::digest(b"bob:bob-pass-1:naiteh-local-auth-v1")
        );
        for hash in [store.users[1].password_hash.clone(), legacy] {
            store.users[1].password_hash = hash;
            save_store(dir.path(), &store).unwrap();
            let err = authenticate(dir.path(), "bob", "nope-nope").unwrap_err();
            assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
            let err = authenticate(dir.path(), "bob", "bob-pass-1").unwrap_err();
            assert_eq!(unauthorized_msg(err), "account is disabled");
            assert_eq!(reload(dir.path()), store);
        }
    }

    #[test]
    fn legacy_store_without_flag_gets_flag_when_password_equals_username() {
        let dir = tempdir().unwrap();
        // An older auth.json: no mustChangePassword field at all.
        let hash = hash_password_argon2("admin").unwrap();
        let json = format!(
            r#"{{"users":[{{"username":"admin","role":"Admin","active":true,"passwordHash":"{hash}"}}]}}"#
        );
        std::fs::write(auth_path(dir.path()), json).unwrap();
        let out = authenticate(dir.path(), "admin", "admin").unwrap();
        assert!(out.must_change_password);
        assert!(reload(dir.path()).users[0].must_change_password);
    }

    #[test]
    fn removed_admin_is_not_resurrected() {
        let dir = tempdir().unwrap();
        // A second admin exists; `admin` itself was removed.
        save_store(
            dir.path(),
            &AuthStore {
                users: vec![user("root", UserRole::Admin, true, "root-pass-1")],
            },
        )
        .unwrap();
        let err = authenticate(dir.path(), "admin", "admin").unwrap_err();
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
        let names: Vec<_> = reload(dir.path())
            .users
            .into_iter()
            .map(|u| u.username)
            .collect();
        assert_eq!(names, vec!["root"]);
    }

    #[test]
    fn malformed_store_or_missing_account_fields_are_not_defaulted() {
        let dir = tempdir().unwrap();
        let hash = hash_password_argon2("admin").unwrap();
        let missing_active = format!(
            r#"{{"users":[{{"username":"admin","role":"Admin","passwordHash":"{hash}"}}]}}"#
        );
        for json in ["{not json", "{}", &missing_active] {
            std::fs::write(auth_path(dir.path()), json).unwrap();
            let err = authenticate(dir.path(), "admin", "admin").unwrap_err();
            assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
            assert_eq!(
                std::fs::read_to_string(auth_path(dir.path())).unwrap(),
                json
            );
        }
    }

    #[test]
    fn empty_or_adminless_store_errors_instead_of_seeding() {
        let dir = tempdir().unwrap();
        let bob = user("bob", UserRole::User, true, "bob-pass-1");
        let disabled_admin = user("admin", UserRole::Admin, false, "admin-pass-1");
        for users in [vec![], vec![bob.clone()], vec![disabled_admin, bob]] {
            let store = AuthStore { users };
            save_store(dir.path(), &store).unwrap();
            let err = authenticate(dir.path(), "bob", "bob-pass-1").unwrap_err();
            assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
            assert_eq!(reload(dir.path()), store);
        }
    }

    #[test]
    fn legacy_sha256_hash_authenticates_and_is_upgraded_to_argon2() {
        let dir = tempdir().unwrap();
        // Hand-craft an auth.json with a SHA-256 hash matching the
        // legacy formula for username="mgkyung", password="mgkyung".
        let legacy: String = {
            let input = format!("mgkyung:mgkyung:{LEGACY_PASSWORD_PEPPER}");
            let digest = Sha256::digest(input.as_bytes());
            digest.iter().map(|b| format!("{b:02x}")).collect()
        };
        let legacy_user = StoredUser {
            username: "mgkyung".into(),
            role: UserRole::User,
            active: true,
            password_hash: legacy.clone(),
            must_change_password: false,
        };
        store_with(dir.path(), vec![legacy_user]);
        append_audit(dir.path(), "admin", "user_created", Some("mgkyung".into())).unwrap();
        let audit_before = std::fs::read(audit_path(dir.path())).unwrap();

        let before = reload(dir.path());
        let err = authenticate(dir.path(), "mgkyung", "wrong").unwrap_err();
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
        assert_eq!(reload(dir.path()), before);

        let out = authenticate(dir.path(), "  MGKYUNG  ", "mgkyung").unwrap();
        assert_eq!(out.session.username, "mgkyung");
        assert_eq!(out.session.role, UserRole::User);
        assert!(out.must_change_password);

        // Now on disk the hash has been re-written as argon2.
        let reloaded = reload(dir.path());
        let upgraded = &reloaded
            .users
            .iter()
            .find(|u| u.username == "mgkyung")
            .unwrap()
            .password_hash;
        assert!(upgraded.starts_with("$argon2id$"));
        assert_ne!(upgraded, &legacy);

        // And login still works after the upgrade.
        authenticate(dir.path(), "mgkyung", "mgkyung").unwrap();
        assert_eq!(std::fs::read(audit_path(dir.path())).unwrap(), audit_before);
    }

    #[test]
    fn password_length_is_bounded_before_verification_or_hashing() {
        let dir = tempdir().unwrap();
        for password in [
            "x".repeat(MAX_PASSWORD_CHARS + 1),
            "\u{1f512}".repeat(MAX_PASSWORD_CHARS + 1),
        ] {
            let err = authenticate(dir.path(), "admin", &password).unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
            let err = hash_password_argon2(&password).unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "got {err:?}");
        }
        assert!(!auth_path(dir.path()).exists());

        let password = "\u{1f512}".repeat(MAX_PASSWORD_CHARS);
        save_store(
            dir.path(),
            &AuthStore {
                users: vec![user("admin", UserRole::Admin, true, &password)],
            },
        )
        .unwrap();
        authenticate(dir.path(), "admin", &password).unwrap();
    }

    // ── audit ───────────────────────────────────────────────────────

    #[test]
    fn audit_is_returned_newest_first() {
        let dir = tempdir().unwrap();
        append_audit(dir.path(), "admin", "first", None).unwrap();
        append_audit(dir.path(), "admin", "second", Some("note".into())).unwrap();
        let entries = read_audit(dir.path(), 10).unwrap();
        assert_eq!(entries[0].action, "second");
        assert_eq!(entries[1].action, "first");
    }

    #[test]
    fn historical_audit_entries_are_preserved() {
        let dir = tempdir().unwrap();
        let historical = concat!(
            "{\"timestamp\":\"2025-01-01T00:00:00Z\",\"username\":\"former-admin\",",
            "\"action\":\"user_created\",\"detail\":\"old account\"}\n"
        );
        std::fs::write(audit_path(dir.path()), historical).unwrap();
        append_audit(dir.path(), "local", "app_unlocked", None).unwrap();

        let entries = read_audit(dir.path(), 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].timestamp, "2025-01-01T00:00:00Z");
        assert_eq!(entries[1].username, "former-admin");
        assert_eq!(entries[1].action, "user_created");
        assert_eq!(entries[1].detail.as_deref(), Some("old account"));
        assert!(std::fs::read_to_string(audit_path(dir.path()))
            .unwrap()
            .starts_with(historical));
        assert!(!auth_path(dir.path()).exists());
    }

    #[test]
    fn client_actions_are_allowlisted() {
        let dir = tempdir().unwrap();
        for action in CLIENT_AUDIT_ACTIONS {
            log_client_action(dir.path(), "alice", action, None).unwrap();
        }
        for forged in ["login_success", "user_created", "password_changed", "x", ""] {
            let err = log_client_action(dir.path(), "alice", forged, None).unwrap_err();
            assert!(
                matches!(err, AppError::Validation(_)),
                "{forged:?}: {err:?}"
            );
        }
    }

    #[test]
    fn client_action_detail_is_truncated() {
        let dir = tempdir().unwrap();
        let long = "x".repeat(5000);
        log_client_action(dir.path(), "alice", "note_open", Some(long)).unwrap();
        let entries = read_audit(dir.path(), 1).unwrap();
        let detail = entries[0].detail.as_ref().unwrap();
        assert_eq!(detail.chars().count(), MAX_AUDIT_DETAIL_CHARS);
        assert!(detail.ends_with('…'));
    }

    #[test]
    fn read_audit_returns_only_the_requested_tail() {
        let dir = tempdir().unwrap();
        for i in 0..50 {
            append_audit(dir.path(), "admin", &format!("action-{i}"), None).unwrap();
        }
        let entries = read_audit(dir.path(), 3).unwrap();
        assert_eq!(entries.len(), 3);
        // Newest first: action-49, -48, -47.
        assert_eq!(entries[0].action, "action-49");
        assert_eq!(entries[1].action, "action-48");
        assert_eq!(entries[2].action, "action-47");
    }

    #[test]
    fn read_last_lines_spans_multiple_chunks() {
        // Write enough lines that the tail crosses the 8 KiB read chunk.
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        let mut content = String::new();
        for i in 0..2000 {
            content.push_str(&format!("line-{i}\n"));
        }
        std::fs::write(&path, content).unwrap();

        let lines = read_last_lines(&path, 1500).unwrap();
        assert_eq!(lines.len(), 1500);
        assert_eq!(lines.first().unwrap(), "line-500");
        assert_eq!(lines.last().unwrap(), "line-1999");
    }

    #[test]
    fn read_last_lines_handles_missing_and_empty_files() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope.jsonl");
        assert!(read_last_lines(&missing, 5).unwrap().is_empty());

        let empty = dir.path().join("empty.jsonl");
        std::fs::write(&empty, b"").unwrap();
        assert!(read_last_lines(&empty, 5).unwrap().is_empty());
    }

    #[test]
    fn append_audit_rotates_when_over_the_cap() {
        let dir = tempdir().unwrap();
        let path = audit_path(dir.path());
        // Seed the active log just over the cap.
        fsx::ensure_dir(dir.path()).unwrap();
        let previous = vec![b'x'; (MAX_AUDIT_BYTES + 1) as usize];
        std::fs::write(&path, &previous).unwrap();

        append_audit(dir.path(), "admin", "after-rotate", None).unwrap();

        // The oversized file moved to the .1 rotation; the active file now
        // holds just the new entry.
        assert_eq!(
            std::fs::read(dir.path().join(AUDIT_FILE_ROTATED)).unwrap(),
            previous
        );
        let active = std::fs::read_to_string(&path).unwrap();
        assert!(active.contains("after-rotate"));
        assert!(
            active.len() < 1024,
            "active log should be small after rotation"
        );
    }
}
