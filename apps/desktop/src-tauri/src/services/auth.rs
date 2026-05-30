//! Local auth + audit-log storage — see architecture.md §6.8 and §7.9.
//!
//! Two collaborating pieces:
//!
//!   - **AuthStore** persists local accounts (`auth.json` under the OS
//!     app-config directory). Passwords are hashed with Argon2id; the
//!     PHC string format embeds a per-user random salt.
//!   - **SessionStore** is a Tauri-managed in-memory `HashMap<token, AuthSession>`.
//!     `authenticate` returns a fresh 256-bit hex token; every admin
//!     IPC takes that token and resolves it back to an `AuthSession`
//!     before touching state. Tokens are not persisted, so app restart
//!     logs everyone out.
//!
//! ## Migration from the legacy SHA-256 hash
//!
//! Earlier versions of naiteh stored passwords as
//! `sha256(username:password:static_pepper)` — 64 hex chars, no salt,
//! no key stretching. On login we detect that shape, verify against
//! the old algorithm, and on success re-hash with Argon2 and persist.
//! The user sees no difference; the on-disk format upgrades silently.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{AppError, AuditLogEntry, AuthSession, AuthUser, UserRole};
use crate::services::fs as fsx;

const AUTH_FILE: &str = "auth.json";
const AUDIT_FILE: &str = "audit-log.jsonl";
const AUDIT_FILE_ROTATED: &str = "audit-log.1.jsonl";
/// Rotate the audit log once it crosses this size. Single-level
/// rotation bounds total audit history to ~2× this.
const MAX_AUDIT_BYTES: u64 = 5 * 1024 * 1024;
const ADMIN_USERNAME: &str = "admin";
/// Legacy hash pepper, retained only for migrating older `auth.json`
/// files to Argon2. New hashes ignore it entirely.
const LEGACY_PASSWORD_PEPPER: &str = "naiteh-local-auth-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
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
    /// or — on installs that pre-date the migration — a 64-char SHA-256
    /// hex digest, which `authenticate` rewrites on the next successful
    /// login.
    password_hash: String,
}

impl Default for AuthStore {
    fn default() -> Self {
        Self {
            users: vec![StoredUser::seed_admin()],
        }
    }
}

impl StoredUser {
    /// Seed the lone default account. Password equals the username
    /// (`admin`) so first-run works out of the box; the user is
    /// expected to change it from Settings after first login.
    fn seed_admin() -> Self {
        Self {
            username: ADMIN_USERNAME.to_string(),
            role: UserRole::Admin,
            active: true,
            password_hash: hash_password_argon2(ADMIN_USERNAME)
                .expect("argon2 hash of static seed cannot fail"),
        }
    }

    fn public(&self) -> AuthUser {
        AuthUser {
            username: self.username.clone(),
            role: self.role.clone(),
            active: self.active,
        }
    }
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

fn hash_password_argon2(password: &str) -> Result<String, AppError> {
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

// ── store IO ─────────────────────────────────────────────────────────

fn load_store(config_dir: &Path) -> Result<AuthStore, AppError> {
    match fsx::read_json::<AuthStore>(&auth_path(config_dir)) {
        Ok(mut store) => {
            ensure_admin_seed(&mut store);
            Ok(store)
        }
        Err(AppError::NotFound(_)) => Ok(AuthStore::default()),
        Err(e) => Err(e),
    }
}

fn save_store(config_dir: &Path, store: &AuthStore) -> Result<(), AppError> {
    fsx::ensure_dir(config_dir)?;
    fsx::write_json(&auth_path(config_dir), store)
}

fn persist_seeded_store_if_needed(
    config_dir: &Path,
    store: &AuthStore,
) -> Result<(), AppError> {
    if !auth_path(config_dir).exists() {
        save_store(config_dir, store)?;
    }
    Ok(())
}

fn ensure_admin_seed(store: &mut AuthStore) {
    if !store
        .users
        .iter()
        .any(|u| canonical_username(&u.username) == ADMIN_USERNAME)
    {
        store.users.insert(0, StoredUser::seed_admin());
    }
}

// ── public API ───────────────────────────────────────────────────────

pub fn authenticate(
    config_dir: &Path,
    username: &str,
    password: &str,
) -> Result<AuthSession, AppError> {
    let username = canonical_username(username);
    if username.is_empty() || password.is_empty() {
        return Err(AppError::Unauthorized(
            "username and password are required".into(),
        ));
    }
    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;

    let Some(user_idx) = store
        .users
        .iter()
        .position(|u| canonical_username(&u.username) == username)
    else {
        return Err(AppError::Unauthorized(
            "invalid username or password".into(),
        ));
    };

    {
        let user = &store.users[user_idx];
        if !user.active {
            return Err(AppError::Unauthorized("account is disabled".into()));
        }
        if !verify_password(password, &user.password_hash, &username) {
            return Err(AppError::Unauthorized(
                "invalid username or password".into(),
            ));
        }
    }

    // Transparent upgrade from legacy SHA-256 to Argon2.
    let needs_rehash = is_legacy_sha256(&store.users[user_idx].password_hash);
    if needs_rehash {
        let new_hash = hash_password_argon2(password)?;
        store.users[user_idx].password_hash = new_hash;
        save_store(config_dir, &store)?;
    }

    let user = &store.users[user_idx];
    Ok(AuthSession {
        username: user.username.clone(),
        role: user.role.clone(),
    })
}

pub fn list_users(config_dir: &Path) -> Result<Vec<AuthUser>, AppError> {
    let store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    Ok(store.users.iter().map(StoredUser::public).collect())
}

pub fn set_user_active(
    config_dir: &Path,
    actor_username: &str,
    username: &str,
    active: bool,
) -> Result<Vec<AuthUser>, AppError> {
    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;

    let username = canonical_username(username);
    if username == ADMIN_USERNAME && !active {
        return Err(AppError::Conflict(
            "admin account cannot be disabled".into(),
        ));
    }

    let Some(user) = store
        .users
        .iter_mut()
        .find(|u| canonical_username(&u.username) == username)
    else {
        return Err(AppError::NotFound(format!("unknown user: {username}")));
    };
    user.active = active;
    save_store(config_dir, &store)?;

    append_audit(
        config_dir,
        actor_username,
        if active {
            "user_enabled"
        } else {
            "user_disabled"
        },
        Some(username),
    )?;

    Ok(store.users.iter().map(StoredUser::public).collect())
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

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
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

pub fn read_audit(
    config_dir: &Path,
    limit: u32,
) -> Result<Vec<AuditLogEntry>, AppError> {
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

// ── SessionStore ─────────────────────────────────────────────────────

/// Tauri-managed in-memory map from opaque bearer token → AuthSession.
/// Tokens are 256 bits of OS randomness, lower-hex encoded (64 chars).
#[derive(Default)]
pub struct SessionStore {
    inner: StdMutex<HashMap<String, AuthSession>>,
}

impl SessionStore {
    /// Mint a fresh token for `session` and remember the mapping.
    pub fn issue(&self, session: AuthSession) -> String {
        let token = new_token();
        let mut map = self.inner.lock().expect("session map poisoned");
        map.insert(token.clone(), session);
        token
    }

    /// Resolve a token to a (live) session. Returns
    /// `AppError::Unauthorized` for unknown / forged tokens.
    pub fn resolve(&self, token: &str) -> Result<AuthSession, AppError> {
        let map = self.inner.lock().expect("session map poisoned");
        map.get(token).cloned().ok_or_else(|| {
            AppError::Unauthorized("invalid or expired session".into())
        })
    }

    /// Resolve and additionally require the role to be Admin.
    pub fn require_admin(&self, token: &str) -> Result<AuthSession, AppError> {
        let session = self.resolve(token)?;
        if session.role != UserRole::Admin {
            return Err(AppError::Unauthorized("admin account required".into()));
        }
        Ok(session)
    }

    /// Drop a token. No-op if the token isn't known.
    pub fn revoke(&self, token: &str) {
        self.inner
            .lock()
            .expect("session map poisoned")
            .remove(token);
    }
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS rng failure while minting session token");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_admin_can_login_with_seeded_password() {
        let dir = tempdir().unwrap();
        let session = authenticate(dir.path(), "admin", "admin").unwrap();
        assert_eq!(session.username, "admin");
        assert_eq!(session.role, UserRole::Admin);
    }

    #[test]
    fn seeded_admin_hash_is_argon2_not_sha256() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        let store: AuthStore =
            serde_json::from_str(&std::fs::read_to_string(auth_path(dir.path())).unwrap())
                .unwrap();
        assert!(
            store.users[0].password_hash.starts_with("$argon2"),
            "seed hash should be argon2, got {}",
            store.users[0].password_hash
        );
    }

    #[test]
    fn wrong_password_is_unauthorized() {
        let dir = tempdir().unwrap();
        let err = authenticate(dir.path(), "admin", "wrong").unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
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
        let legacy_store = AuthStore {
            users: vec![
                StoredUser {
                    username: "admin".into(),
                    role: UserRole::Admin,
                    active: true,
                    password_hash: hash_password_argon2("admin").unwrap(),
                },
                StoredUser {
                    username: "mgkyung".into(),
                    role: UserRole::User,
                    active: true,
                    password_hash: legacy.clone(),
                },
            ],
        };
        save_store(dir.path(), &legacy_store).unwrap();

        // Login succeeds against the legacy hash.
        authenticate(dir.path(), "mgkyung", "mgkyung").unwrap();

        // Now on disk the hash has been re-written as argon2.
        let reloaded: AuthStore =
            serde_json::from_str(&std::fs::read_to_string(auth_path(dir.path())).unwrap())
                .unwrap();
        let upgraded = &reloaded
            .users
            .iter()
            .find(|u| u.username == "mgkyung")
            .unwrap()
            .password_hash;
        assert!(upgraded.starts_with("$argon2"));
        assert_ne!(upgraded, &legacy);

        // And login still works after the upgrade.
        authenticate(dir.path(), "mgkyung", "mgkyung").unwrap();
    }

    #[test]
    fn set_user_active_refuses_to_disable_admin() {
        let dir = tempdir().unwrap();
        // Seed a non-admin user first.
        let mut store = load_store(dir.path()).unwrap();
        store.users.push(StoredUser {
            username: "alice".into(),
            role: UserRole::User,
            active: true,
            password_hash: hash_password_argon2("alice").unwrap(),
        });
        save_store(dir.path(), &store).unwrap();

        let err = set_user_active(dir.path(), "admin", "admin", false).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
    }

    #[test]
    fn set_user_active_disables_a_standard_user() {
        let dir = tempdir().unwrap();
        let mut store = load_store(dir.path()).unwrap();
        store.users.push(StoredUser {
            username: "alice".into(),
            role: UserRole::User,
            active: true,
            password_hash: hash_password_argon2("alice").unwrap(),
        });
        save_store(dir.path(), &store).unwrap();

        let users = set_user_active(dir.path(), "admin", "alice", false).unwrap();
        let alice = users.iter().find(|u| u.username == "alice").unwrap();
        assert!(!alice.active);
    }

    #[test]
    fn fresh_install_seeds_only_admin() {
        let dir = tempdir().unwrap();
        let users = list_users(dir.path()).unwrap();
        let names: Vec<_> = users.iter().map(|u| u.username.as_str()).collect();
        assert_eq!(names, vec!["admin"]);
    }

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

        let lines = read_last_lines(&path, 2).unwrap();
        assert_eq!(lines, vec!["line-1998".to_string(), "line-1999".to_string()]);
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
        std::fs::write(&path, vec![b'x'; (MAX_AUDIT_BYTES + 1) as usize]).unwrap();

        append_audit(dir.path(), "admin", "after-rotate", None).unwrap();

        // The oversized file moved to the .1 rotation; the active file now
        // holds just the new entry.
        assert!(dir.path().join(AUDIT_FILE_ROTATED).exists());
        let active = std::fs::read_to_string(&path).unwrap();
        assert!(active.contains("after-rotate"));
        assert!(active.len() < 1024, "active log should be small after rotation");
    }

    // ── SessionStore ─────────────────────────────────────────────────

    fn session(username: &str, role: UserRole) -> AuthSession {
        AuthSession {
            username: username.into(),
            role,
        }
    }

    #[test]
    fn session_store_issues_unique_tokens() {
        let store = SessionStore::default();
        let a = store.issue(session("admin", UserRole::Admin));
        let b = store.issue(session("admin", UserRole::Admin));
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn session_store_resolves_known_tokens() {
        let store = SessionStore::default();
        let t = store.issue(session("alice", UserRole::User));
        let resolved = store.resolve(&t).unwrap();
        assert_eq!(resolved.username, "alice");
    }

    #[test]
    fn session_store_rejects_unknown_tokens() {
        let store = SessionStore::default();
        let err = store.resolve("ffff").unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)));
    }

    #[test]
    fn require_admin_rejects_standard_users() {
        let store = SessionStore::default();
        let t = store.issue(session("alice", UserRole::User));
        let err = store.require_admin(&t).unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)));
    }

    #[test]
    fn require_admin_accepts_admin_tokens() {
        let store = SessionStore::default();
        let t = store.issue(session("admin", UserRole::Admin));
        store.require_admin(&t).unwrap();
    }

    #[test]
    fn revoke_invalidates_token() {
        let store = SessionStore::default();
        let t = store.issue(session("admin", UserRole::Admin));
        store.revoke(&t);
        assert!(store.resolve(&t).is_err());
    }
}
