//! Local auth + audit-log storage — see architecture.md ("UI
//! Architecture" → "Authentication gate") and vault/wiki/ipc-api.md
//! ("Auth & Audit", "Session gate").
//!
//! Collaborating pieces:
//!
//!   - **AuthStore** persists local accounts (`auth.json` under the OS
//!     app-config directory). Passwords are hashed with Argon2id; the
//!     PHC string format embeds a per-user random salt. The default
//!     `admin`/`admin` account is seeded **only** when `auth.json` does
//!     not exist at all (first run) and is flagged `mustChangePassword`.
//!   - **SessionStore** is a Tauri-managed in-memory
//!     `HashMap<token, AuthSession>`. `auth_login` mints a fresh 256-bit
//!     hex token; every auth IPC takes that token and resolves it back to
//!     an `AuthSession`. Tokens expire after 12 h idle / 7 days absolute
//!     (`services::session`). With "keep me signed in", the token is also
//!     persisted to `remembered-session.json` (30-day TTL) and
//!     re-installed by `auth_resume` on the next launch.
//!   - The **session gate** for every non-auth command lives in
//!     `services::session::ActiveSession`.
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
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Instant;

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{AppError, AuditLogEntry, AuthSession, AuthUser, UserRole};
use crate::services::fs as fsx;
use crate::services::session::SessionTimes;

const AUTH_FILE: &str = "auth.json";
const AUDIT_FILE: &str = "audit-log.jsonl";
const AUDIT_FILE_ROTATED: &str = "audit-log.1.jsonl";
/// Opt-in "remember me" session, stored in the app-config dir (same
/// trust boundary as `auth.json` and the API key — only the local OS
/// user account can read it). Lets the app skip the login screen on
/// restart until the token expires or the user signs out.
const REMEMBERED_FILE: &str = "remembered-session.json";
/// How long a remembered session stays valid without re-entering the
/// password.
const REMEMBER_TTL_DAYS: i64 = 30;
/// Rotate the audit log once it crosses this size. Single-level
/// rotation bounds total audit history to ~2× this.
const MAX_AUDIT_BYTES: u64 = 5 * 1024 * 1024;
const ADMIN_USERNAME: &str = "admin";
/// Legacy hash pepper, retained only for migrating older `auth.json`
/// files to Argon2. New hashes ignore it entirely.
const LEGACY_PASSWORD_PEPPER: &str = "naiteh-local-auth-v1";

/// The one message for every credential failure (unknown user, wrong
/// password, wrong password on a disabled account) so the response
/// never reveals which part was wrong.
pub const INVALID_CREDENTIALS: &str = "invalid username or password";
pub const MIN_PASSWORD_CHARS: usize = 8;
/// Upper bound so a multi-megabyte "password" can't pin a CPU in Argon2.
pub const MAX_PASSWORD_CHARS: usize = 1024;
pub const MAX_USERNAME_CHARS: usize = 32;
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
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
    /// True while the password is still the seeded default (password ==
    /// username). Absent in older files → false, then recomputed on the
    /// next successful login.
    #[serde(default)]
    must_change_password: bool,
}

impl AuthStore {
    /// First-run store: the lone `admin` account.
    fn seeded() -> Self {
        Self {
            users: vec![StoredUser::seed_admin()],
        }
    }
}

impl StoredUser {
    /// Seed the default account. Password equals the username (`admin`)
    /// so first run works out of the box; `must_change_password` makes
    /// the UI demand a new password right after the first login.
    fn seed_admin() -> Self {
        Self {
            username: ADMIN_USERNAME.to_string(),
            role: UserRole::Admin,
            active: true,
            password_hash: hash_password_argon2(ADMIN_USERNAME)
                .expect("argon2 hash of static seed cannot fail"),
            must_change_password: true,
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

/// A successful password check.
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

pub fn canonical_username(username: &str) -> String {
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

/// Whether `password` is the username itself (the seeded-default shape).
fn password_is_username(password: &str, username_canonical: &str) -> bool {
    canonical_username(password) == username_canonical
}

// ── validation ───────────────────────────────────────────────────────

/// 1–32 chars of `[A-Za-z0-9._-]`. Returns the trimmed spelling.
fn validate_username(username: &str) -> Result<String, AppError> {
    let name = username.trim();
    if name.is_empty() {
        return Err(AppError::Validation("username is required".into()));
    }
    if name.chars().count() > MAX_USERNAME_CHARS {
        return Err(AppError::Validation(format!(
            "username must be at most {MAX_USERNAME_CHARS} characters"
        )));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(AppError::Validation(
            "username may contain only letters, digits, '.', '_' and '-'".into(),
        ));
    }
    Ok(name.to_string())
}

/// Password policy for new passwords: ≥ 8 chars, ≠ username, ≠ the
/// current password (when given).
fn validate_new_password(
    username_canonical: &str,
    password: &str,
    current: Option<&str>,
) -> Result<(), AppError> {
    let len = password.chars().count();
    if len < MIN_PASSWORD_CHARS {
        return Err(AppError::Validation(format!(
            "password must be at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    if len > MAX_PASSWORD_CHARS {
        return Err(AppError::Validation(format!(
            "password must be at most {MAX_PASSWORD_CHARS} characters"
        )));
    }
    if password_is_username(password, username_canonical) {
        return Err(AppError::Validation(
            "password must not be the same as the username".into(),
        ));
    }
    if current == Some(password) {
        return Err(AppError::Validation(
            "new password must differ from the current password".into(),
        ));
    }
    Ok(())
}

// ── store IO ─────────────────────────────────────────────────────────

/// Load `auth.json`. Only a *missing* file yields the seeded first-run
/// store — an existing file is taken as-is, so deleting `admin` (or
/// emptying the list) never resurrects `admin`/`admin`.
fn load_store(config_dir: &Path) -> Result<AuthStore, AppError> {
    match fsx::read_json::<AuthStore>(&auth_path(config_dir)) {
        Ok(store) => Ok(store),
        Err(AppError::NotFound(_)) => Ok(AuthStore::seeded()),
        Err(e) => Err(e),
    }
}

fn save_store(config_dir: &Path, store: &AuthStore) -> Result<(), AppError> {
    fsx::ensure_dir(config_dir)?;
    fsx::write_json(&auth_path(config_dir), store)
}

fn persist_seeded_store_if_needed(config_dir: &Path, store: &AuthStore) -> Result<(), AppError> {
    if !auth_path(config_dir).exists() {
        save_store(config_dir, store)?;
    }
    Ok(())
}

fn find_user(store: &AuthStore, username_canonical: &str) -> Option<usize> {
    store
        .users
        .iter()
        .position(|u| canonical_username(&u.username) == username_canonical)
}

fn active_admin_count(store: &AuthStore) -> usize {
    store
        .users
        .iter()
        .filter(|u| u.active && u.role == UserRole::Admin)
        .count()
}

// ── Remembered ("keep me signed in") session ─────────────────────────

/// On-disk record of an opt-in remembered session. The token is the
/// same opaque bearer string `SessionStore::issue` minted at login; on
/// restart `resume` re-installs it so it keeps validating.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RememberedSession {
    token: String,
    username: String,
    /// RFC3339 UTC instant after which the remembered session is stale.
    expires_at: String,
}

fn remembered_path(config_dir: &Path) -> PathBuf {
    config_dir.join(REMEMBERED_FILE)
}

/// Persist `token`/`session` so the next launch can skip the login
/// screen for the next [`REMEMBER_TTL_DAYS`] days.
pub fn save_remembered(
    config_dir: &Path,
    token: &str,
    session: &AuthSession,
) -> Result<(), AppError> {
    fsx::ensure_dir(config_dir)?;
    let expires_at = (Utc::now() + chrono::Duration::days(REMEMBER_TTL_DAYS))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    let record = RememberedSession {
        token: token.to_string(),
        username: session.username.clone(),
        expires_at,
    };
    fsx::write_json(&remembered_path(config_dir), &record)
}

/// Delete any remembered session. Best-effort: a missing file is fine.
pub fn clear_remembered(config_dir: &Path) {
    let _ = std::fs::remove_file(remembered_path(config_dir));
}

/// Delete the remembered session only if it belongs to `username`
/// (e.g. after that user changed their password or was disabled). An
/// unreadable record is removed too.
pub fn clear_remembered_for(config_dir: &Path, username: &str) {
    let path = remembered_path(config_dir);
    if !path.exists() {
        return;
    }
    let wanted = canonical_username(username);
    match fsx::read_json::<RememberedSession>(&path) {
        Ok(record) if canonical_username(&record.username) != wanted => {}
        _ => clear_remembered(config_dir),
    }
}

/// A remembered session that is still valid: the persisted token, the
/// freshly resolved session, and the account's must-change flag.
#[derive(Debug, Clone)]
pub struct RememberedLogin {
    pub token: String,
    pub session: AuthSession,
    pub must_change_password: bool,
}

/// Load a valid remembered session, if one exists. Returns the persisted
/// token paired with a *freshly resolved* session (current username +
/// role from `auth.json`), so a role change or deactivation between runs
/// is honoured. Any of {missing, corrupt, expired, unknown user,
/// deactivated user} yields `None` — and prunes the file so a stale
/// record doesn't linger.
pub fn load_remembered(config_dir: &Path) -> Option<RememberedLogin> {
    let record: RememberedSession = fsx::read_json(&remembered_path(config_dir)).ok()?;

    let expired = chrono::DateTime::parse_from_rfc3339(&record.expires_at)
        .map(|exp| Utc::now() >= exp)
        .unwrap_or(true); // unparseable expiry → treat as expired
    if expired {
        clear_remembered(config_dir);
        return None;
    }

    // Re-derive the session from the live account so a disabled or
    // role-changed account can't ride a stale token back in.
    let mut store = load_store(config_dir).ok()?;
    let wanted = canonical_username(&record.username);
    // Installs that remembered a session before the must-change flag
    // existed never hit the password-login path that sets it, so check
    // here too: a still-default password must not skip the forced change.
    // Slow (Argon2) — callers run this off the main thread.
    if let Some(i) = find_user(&store, &wanted) {
        let u = &store.users[i];
        if u.active
            && !u.must_change_password
            && verify_password(&u.username, &u.password_hash, &wanted)
        {
            store.users[i].must_change_password = true;
            // Best effort: the flag is still returned for this resume.
            let _ = save_store(config_dir, &store);
        }
    }
    let user = find_user(&store, &wanted).map(|i| &store.users[i]);
    match user {
        Some(u) if u.active => Some(RememberedLogin {
            token: record.token,
            session: AuthSession {
                username: u.username.clone(),
                role: u.role.clone(),
            },
            must_change_password: u.must_change_password,
        }),
        _ => {
            clear_remembered(config_dir);
            None
        }
    }
}

// ── public API ───────────────────────────────────────────────────────

/// Verify a username/password pair. Slow (Argon2) — call it off the
/// main thread. Every credential failure returns the same
/// [`INVALID_CREDENTIALS`] message and costs one Argon2 verification,
/// whether or not the user exists. "account is disabled" is reported
/// only once the password has checked out.
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
    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;

    if active_admin_count(&store) == 0 {
        return Err(AppError::ConfigCorrupt(
            "auth.json has no active administrator account; restore it from a backup \
             or remove the file to re-run first-time setup"
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
    if !store.users[user_idx].must_change_password && password_is_username(password, &username) {
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

/// Change `username`'s own password. Verifies `current_password`,
/// enforces the password policy, re-hashes with Argon2id, and clears
/// the must-change flag. Slow (two Argon2 ops) — call off the main
/// thread. Revoking the user's other sessions is the caller's job.
pub fn change_password(
    config_dir: &Path,
    username: &str,
    current_password: &str,
    new_password: &str,
) -> Result<(), AppError> {
    let username = canonical_username(username);
    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    let Some(idx) = find_user(&store, &username) else {
        return Err(AppError::Unauthorized("invalid or expired session".into()));
    };
    if !store.users[idx].active {
        return Err(AppError::Unauthorized("account is disabled".into()));
    }
    if !verify_password(current_password, &store.users[idx].password_hash, &username) {
        return Err(AppError::Unauthorized(
            "current password is incorrect".into(),
        ));
    }
    validate_new_password(&username, new_password, Some(current_password))?;
    store.users[idx].password_hash = hash_password_argon2(new_password)?;
    store.users[idx].must_change_password = false;
    save_store(config_dir, &store)?;
    append_audit(config_dir, &username, "password_changed", None)
}

/// Admin-only (the caller checks the token): add a new account.
/// Returns the full user list.
pub fn create_user(
    config_dir: &Path,
    actor_username: &str,
    username: &str,
    password: &str,
    role: UserRole,
) -> Result<Vec<AuthUser>, AppError> {
    let name = validate_username(username)?;
    let canonical = canonical_username(&name);
    validate_new_password(&canonical, password, None)?;

    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    if find_user(&store, &canonical).is_some() {
        return Err(AppError::Conflict(format!("user already exists: {name}")));
    }
    store.users.push(StoredUser {
        username: name.clone(),
        role: role.clone(),
        active: true,
        password_hash: hash_password_argon2(password)?,
        must_change_password: false,
    });
    save_store(config_dir, &store)?;
    let role_label = match role {
        UserRole::Admin => "Admin",
        UserRole::User => "User",
    };
    append_audit(
        config_dir,
        actor_username,
        "user_created",
        Some(format!("{name} ({role_label})")),
    )?;
    Ok(store.users.iter().map(StoredUser::public).collect())
}

pub fn list_users(config_dir: &Path) -> Result<Vec<AuthUser>, AppError> {
    let store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    Ok(store.users.iter().map(StoredUser::public).collect())
}

/// Enable / disable an account. Refuses to disable the acting admin
/// themselves or the last active admin (either would lock everyone out
/// of account management).
pub fn set_user_active(
    config_dir: &Path,
    actor_username: &str,
    username: &str,
    active: bool,
) -> Result<Vec<AuthUser>, AppError> {
    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;

    let username = canonical_username(username);
    let Some(idx) = find_user(&store, &username) else {
        return Err(AppError::NotFound(format!("unknown user: {username}")));
    };
    if !active {
        if canonical_username(actor_username) == username {
            return Err(AppError::Conflict(
                "you cannot disable your own account".into(),
            ));
        }
        let user = &store.users[idx];
        if user.active && user.role == UserRole::Admin && active_admin_count(&store) <= 1 {
            return Err(AppError::Conflict(
                "the last active admin account cannot be disabled".into(),
            ));
        }
    }
    store.users[idx].active = active;
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

// ── SessionStore ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct TokenEntry {
    session: AuthSession,
    times: SessionTimes,
}

/// Tauri-managed in-memory map from opaque bearer token → AuthSession.
/// Tokens are 256 bits of OS randomness, lower-hex encoded (64 chars),
/// and expire per `services::session` (12 h idle / 7 days absolute).
#[derive(Default)]
pub struct SessionStore {
    inner: StdMutex<HashMap<String, TokenEntry>>,
}

impl SessionStore {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, TokenEntry>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Mint a fresh token for `session` and remember the mapping.
    pub fn issue(&self, session: AuthSession) -> String {
        let token = new_token();
        self.install(token.clone(), session);
        token
    }

    /// Re-register a pre-existing token → session mapping. Used to resume
    /// a remembered session on startup, where the token was minted in a
    /// previous run and persisted to disk. Also prunes expired tokens.
    pub fn install(&self, token: String, session: AuthSession) {
        let now = Instant::now();
        let mut map = self.map();
        map.retain(|_, e| !e.times.is_expired(now));
        map.insert(
            token,
            TokenEntry {
                session,
                times: SessionTimes::new(now),
            },
        );
    }

    /// Resolve a token to a (live) session. Returns
    /// `AppError::Unauthorized` for unknown / forged / expired tokens.
    pub fn resolve(&self, token: &str) -> Result<AuthSession, AppError> {
        self.resolve_at(token, Instant::now())
    }

    pub fn resolve_at(&self, token: &str, now: Instant) -> Result<AuthSession, AppError> {
        let mut map = self.map();
        let unauthorized = || AppError::Unauthorized("invalid or expired session".into());
        let entry = map.get_mut(token).ok_or_else(unauthorized)?;
        if entry.times.is_expired(now) {
            map.remove(token);
            return Err(unauthorized());
        }
        entry.times.touch(now);
        Ok(entry.session.clone())
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
        self.map().remove(token);
    }

    /// Drop every token belonging to `username`, except `keep` (the
    /// caller's own token, e.g. after a password change).
    pub fn revoke_user(&self, username: &str, keep: Option<&str>) {
        let wanted = canonical_username(username);
        self.map().retain(|token, e| {
            Some(token.as_str()) == keep || canonical_username(&e.session.username) != wanted
        });
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
    use crate::services::session::{ABSOLUTE_TIMEOUT, IDLE_TIMEOUT};
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

    /// Seeded admin (password changed to `admin-pass-1`) + extra users.
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
    fn default_admin_can_login_with_seeded_password() {
        let dir = tempdir().unwrap();
        let out = authenticate(dir.path(), "admin", "admin").unwrap();
        assert_eq!(out.session.username, "admin");
        assert_eq!(out.session.role, UserRole::Admin);
    }

    #[test]
    fn seeded_admin_must_change_password() {
        let dir = tempdir().unwrap();
        let out = authenticate(dir.path(), "admin", "admin").unwrap();
        assert!(out.must_change_password);
        assert!(reload(dir.path()).users[0].must_change_password);
    }

    #[test]
    fn seeded_admin_hash_is_argon2_not_sha256() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        let store = reload(dir.path());
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
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
    }

    #[test]
    fn unknown_user_gets_the_generic_message() {
        let dir = tempdir().unwrap();
        let err = authenticate(dir.path(), "nobody", "whatever").unwrap_err();
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
        // The timing-equalizer hash has real Argon2 parameters.
        assert!(PasswordHash::new(dummy_hash()).is_ok());
        assert!(dummy_hash().starts_with("$argon2id$"));
    }

    #[test]
    fn disabled_account_with_wrong_password_is_generic() {
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("bob", UserRole::User, false, "bob-pass-1")],
        );
        let err = authenticate(dir.path(), "bob", "nope-nope").unwrap_err();
        assert_eq!(unauthorized_msg(err), INVALID_CREDENTIALS);
        let err = authenticate(dir.path(), "bob", "bob-pass-1").unwrap_err();
        assert_eq!(unauthorized_msg(err), "account is disabled");
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
    fn legacy_store_with_changed_password_needs_no_change() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        let out = authenticate(dir.path(), "admin", "admin-pass-1").unwrap();
        assert!(!out.must_change_password);
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
        let names: Vec<_> = list_users(dir.path())
            .unwrap()
            .into_iter()
            .map(|u| u.username)
            .collect();
        assert_eq!(names, vec!["root"]);
    }

    #[test]
    fn empty_or_adminless_store_errors_instead_of_seeding() {
        let dir = tempdir().unwrap();
        std::fs::write(auth_path(dir.path()), "{}").unwrap();
        let err = authenticate(dir.path(), "admin", "admin").unwrap_err();
        assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
        assert!(list_users(dir.path()).unwrap().is_empty());

        let dir = tempdir().unwrap();
        save_store(
            dir.path(),
            &AuthStore {
                users: vec![
                    user("admin", UserRole::Admin, false, "admin-pass-1"),
                    user("bob", UserRole::User, true, "bob-pass-1"),
                ],
            },
        )
        .unwrap();
        let err = authenticate(dir.path(), "bob", "bob-pass-1").unwrap_err();
        assert!(matches!(err, AppError::ConfigCorrupt(_)), "got {err:?}");
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
        let mut legacy_user = user("mgkyung", UserRole::User, true, "x");
        legacy_user.password_hash = legacy.clone();
        store_with(dir.path(), vec![legacy_user]);

        // Login succeeds against the legacy hash.
        authenticate(dir.path(), "mgkyung", "mgkyung").unwrap();

        // Now on disk the hash has been re-written as argon2.
        let reloaded = reload(dir.path());
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

    // ── change_password ─────────────────────────────────────────────

    #[test]
    fn change_password_rehashes_and_clears_must_change() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        change_password(dir.path(), "admin", "admin", "s3cure-pass").unwrap();
        let out = authenticate(dir.path(), "admin", "s3cure-pass").unwrap();
        assert!(!out.must_change_password);
        assert!(authenticate(dir.path(), "admin", "admin").is_err());
        let audit = read_audit(dir.path(), 10).unwrap();
        assert!(audit.iter().any(|e| e.action == "password_changed"));
    }

    #[test]
    fn change_password_requires_the_current_password() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        let err = change_password(dir.path(), "admin", "wrong", "s3cure-pass").unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    }

    #[test]
    fn change_password_enforces_policy() {
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("carolina1", UserRole::User, true, "carol-pass")],
        );
        // too short / same as current / equal to the username (any case)
        for bad in [
            "short",
            "carol-pass",
            "carolina1",
            "CAROLINA1",
            " Carolina1 ",
        ] {
            let err = change_password(dir.path(), "carolina1", "carol-pass", bad).unwrap_err();
            assert!(
                matches!(err, AppError::Validation(_)),
                "{bad:?} should be rejected, got {err:?}"
            );
        }
        // Exactly 8 chars is fine.
        change_password(dir.path(), "carolina1", "carol-pass", "12345678").unwrap();
    }

    #[test]
    fn clear_remembered_for_only_touches_that_user() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        save_remembered(dir.path(), "tok", &session("admin", UserRole::Admin)).unwrap();
        clear_remembered_for(dir.path(), "bob");
        assert!(remembered_path(dir.path()).exists());
        clear_remembered_for(dir.path(), "ADMIN");
        assert!(!remembered_path(dir.path()).exists());
    }

    // ── create_user ─────────────────────────────────────────────────

    #[test]
    fn create_user_adds_an_account_that_can_log_in() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        let users = create_user(
            dir.path(),
            "admin",
            "Alice.B-1",
            "alice-pass",
            UserRole::User,
        )
        .unwrap();
        let alice = users.iter().find(|u| u.username == "Alice.B-1").unwrap();
        assert!(alice.active);
        assert_eq!(alice.role, UserRole::User);
        let out = authenticate(dir.path(), "alice.b-1", "alice-pass").unwrap();
        assert!(!out.must_change_password);
        let audit = read_audit(dir.path(), 10).unwrap();
        assert_eq!(audit[0].action, "user_created");
    }

    #[test]
    fn create_user_validates_username_and_password() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        let long = "a".repeat(MAX_USERNAME_CHARS + 1);
        for bad in ["", "   ", "has space", "slash/name", "üser", long.as_str()] {
            let err =
                create_user(dir.path(), "admin", bad, "good-pass-1", UserRole::User).unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{bad:?}: {err:?}");
        }
        let exact = "a".repeat(MAX_USERNAME_CHARS);
        create_user(dir.path(), "admin", &exact, "good-pass-1", UserRole::User).unwrap();
        for bad_pw in ["short", "carol123", "CAROL123"] {
            let err =
                create_user(dir.path(), "admin", "carol123", bad_pw, UserRole::User).unwrap_err();
            assert!(
                matches!(err, AppError::Validation(_)),
                "{bad_pw:?}: {err:?}"
            );
        }
    }

    #[test]
    fn create_user_rejects_case_insensitive_duplicates() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        create_user(dir.path(), "admin", "dave", "dave-pass-1", UserRole::User).unwrap();
        let err =
            create_user(dir.path(), "admin", "DAVE", "dave-pass-2", UserRole::Admin).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
        let err =
            create_user(dir.path(), "admin", "Admin", "dave-pass-2", UserRole::Admin).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
    }

    // ── set_user_active ─────────────────────────────────────────────

    #[test]
    fn set_user_active_refuses_to_disable_self_or_last_admin() {
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("alice", UserRole::User, true, "alice-pass")],
        );
        let err = set_user_active(dir.path(), "admin", "admin", false).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");

        // A second admin can't disable the last *active* admin either.
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("root", UserRole::Admin, false, "root-pass-1")],
        );
        let err = set_user_active(dir.path(), "root", "admin", false).unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)), "got {err:?}");
    }

    #[test]
    fn set_user_active_allows_disabling_one_of_two_admins() {
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("root", UserRole::Admin, true, "root-pass-1")],
        );
        let users = set_user_active(dir.path(), "root", "admin", false).unwrap();
        assert!(!users.iter().find(|u| u.username == "admin").unwrap().active);
    }

    #[test]
    fn set_user_active_disables_a_standard_user() {
        let dir = tempdir().unwrap();
        store_with(
            dir.path(),
            vec![user("alice", UserRole::User, true, "alice-pass")],
        );
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

        let lines = read_last_lines(&path, 2).unwrap();
        assert_eq!(
            lines,
            vec!["line-1998".to_string(), "line-1999".to_string()]
        );
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
        assert!(
            active.len() < 1024,
            "active log should be small after rotation"
        );
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
    fn session_store_tokens_expire_idle_and_absolute() {
        let store = SessionStore::default();
        let t = store.issue(session("alice", UserRole::User));
        let now = Instant::now();
        assert!(store.resolve_at(&t, now + IDLE_TIMEOUT * 2).is_err());
        // Expired tokens are removed, not just rejected.
        assert!(store.resolve_at(&t, now).is_err());

        let t = store.issue(session("alice", UserRole::User));
        assert!(store.resolve_at(&t, now + ABSOLUTE_TIMEOUT).is_err());
    }

    #[test]
    fn revoke_user_keeps_only_the_named_token() {
        let store = SessionStore::default();
        let a1 = store.issue(session("alice", UserRole::User));
        let a2 = store.issue(session("alice", UserRole::User));
        let b = store.issue(session("bob", UserRole::User));
        store.revoke_user("ALICE", Some(&a1));
        assert!(store.resolve(&a1).is_ok());
        assert!(store.resolve(&a2).is_err());
        assert!(store.resolve(&b).is_ok());
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

    #[test]
    fn install_reregisters_a_persisted_token() {
        let store = SessionStore::default();
        store.install("deadbeef".into(), session("admin", UserRole::Admin));
        assert_eq!(store.resolve("deadbeef").unwrap().username, "admin");
    }

    // ── remembered session ──────────────────────────────────────────

    #[test]
    fn remembered_round_trips_and_resolves_live_role() {
        let dir = tempdir().unwrap();
        // Seed the admin account so load_store finds it.
        authenticate(dir.path(), "admin", "admin").unwrap();
        save_remembered(dir.path(), "tok-123", &session("admin", UserRole::Admin)).unwrap();

        let resumed = load_remembered(dir.path()).unwrap();
        assert_eq!(resumed.token, "tok-123");
        assert_eq!(resumed.session.username, "admin");
        assert_eq!(resumed.session.role, UserRole::Admin);
        assert!(resumed.must_change_password);
    }

    #[test]
    fn resume_flags_legacy_default_password_without_the_flag() {
        // An install from before the must-change flag: admin/admin, flag
        // false on disk, and a remembered session. Resume must still force
        // the change, and persist the flag.
        let dir = tempdir().unwrap();
        save_store(
            dir.path(),
            &AuthStore {
                users: vec![user("admin", UserRole::Admin, true, "admin")],
            },
        )
        .unwrap();
        save_remembered(dir.path(), "tok", &session("admin", UserRole::Admin)).unwrap();

        let resumed = load_remembered(dir.path()).unwrap();
        assert!(resumed.must_change_password);
        assert!(reload(dir.path()).users[0].must_change_password);
    }

    #[test]
    fn resume_keeps_flag_clear_for_a_changed_password() {
        let dir = tempdir().unwrap();
        store_with(dir.path(), vec![]);
        save_remembered(dir.path(), "tok", &session("admin", UserRole::Admin)).unwrap();

        let resumed = load_remembered(dir.path()).unwrap();
        assert!(!resumed.must_change_password);
        assert!(!reload(dir.path()).users[0].must_change_password);
    }

    #[test]
    fn missing_remembered_is_none() {
        let dir = tempdir().unwrap();
        assert!(load_remembered(dir.path()).is_none());
    }

    #[test]
    fn expired_remembered_is_pruned() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        // Hand-write a record dated in the past.
        let record = RememberedSession {
            token: "old".into(),
            username: "admin".into(),
            expires_at: "2000-01-01T00:00:00Z".into(),
        };
        fsx::write_json(&remembered_path(dir.path()), &record).unwrap();

        assert!(load_remembered(dir.path()).is_none());
        // ...and the stale file is gone.
        assert!(!remembered_path(dir.path()).exists());
    }

    #[test]
    fn deactivated_account_cannot_resume() {
        let dir = tempdir().unwrap();
        // Seed a disabled standard user directly, then try to resume as them.
        store_with(dir.path(), vec![user("bob", UserRole::User, false, "pw")]);
        save_remembered(dir.path(), "tok", &session("bob", UserRole::User)).unwrap();

        assert!(load_remembered(dir.path()).is_none());
        assert!(!remembered_path(dir.path()).exists());
    }

    #[test]
    fn clear_remembered_removes_the_file() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        save_remembered(dir.path(), "tok", &session("admin", UserRole::Admin)).unwrap();
        assert!(remembered_path(dir.path()).exists());
        clear_remembered(dir.path());
        assert!(!remembered_path(dir.path()).exists());
    }
}
