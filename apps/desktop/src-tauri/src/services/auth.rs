//! Local auth and audit-log storage — see architecture.md §6.8 and §7.9.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::domain::{AppError, AuditLogEntry, AuthSession, AuthUser, UserRole};
use crate::services::fs as fsx;

const AUTH_FILE: &str = "auth.json";
const AUDIT_FILE: &str = "audit-log.jsonl";
const PASSWORD_PEPPER: &str = "naiteh-local-auth-v1";
const ADMIN_USERNAME: &str = "admin";
const USER_USERNAME: &str = "mgkyung";

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
    password_hash: String,
}

impl Default for AuthStore {
    fn default() -> Self {
        Self {
            users: vec![
                StoredUser::seed(ADMIN_USERNAME, UserRole::Admin),
                StoredUser::seed(USER_USERNAME, UserRole::User),
            ],
        }
    }
}

impl StoredUser {
    fn seed(username: &str, role: UserRole) -> Self {
        Self {
            username: username.to_string(),
            role,
            active: true,
            password_hash: hash_password(username, username),
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

fn auth_path(config_dir: &Path) -> PathBuf {
    config_dir.join(AUTH_FILE)
}

fn audit_path(config_dir: &Path) -> PathBuf {
    config_dir.join(AUDIT_FILE)
}

fn canonical_username(username: &str) -> String {
    username.trim().to_ascii_lowercase()
}

fn hash_password(username: &str, password: &str) -> String {
    let canonical = canonical_username(username);
    let input = format!("{canonical}:{password}:{PASSWORD_PEPPER}");
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn ensure_seed_users(store: &mut AuthStore) {
    if !store
        .users
        .iter()
        .any(|u| canonical_username(&u.username) == ADMIN_USERNAME)
    {
        store
            .users
            .insert(0, StoredUser::seed(ADMIN_USERNAME, UserRole::Admin));
    }
    if !store
        .users
        .iter()
        .any(|u| canonical_username(&u.username) == USER_USERNAME)
    {
        store
            .users
            .push(StoredUser::seed(USER_USERNAME, UserRole::User));
    }
}

fn load_store(config_dir: &Path) -> Result<AuthStore, AppError> {
    match fsx::read_json::<AuthStore>(&auth_path(config_dir)) {
        Ok(mut store) => {
            ensure_seed_users(&mut store);
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

fn persist_seeded_store_if_needed(config_dir: &Path, store: &AuthStore) -> Result<(), AppError> {
    if !auth_path(config_dir).exists() {
        save_store(config_dir, store)?;
    }
    Ok(())
}

fn require_admin(store: &AuthStore, actor: &str) -> Result<(), AppError> {
    let actor = canonical_username(actor);
    let Some(user) = store
        .users
        .iter()
        .find(|u| canonical_username(&u.username) == actor)
    else {
        return Err(AppError::Unauthorized("admin account required".into()));
    };
    if !user.active || user.role != UserRole::Admin {
        return Err(AppError::Unauthorized("admin account required".into()));
    }
    Ok(())
}

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
    let store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    let Some(user) = store
        .users
        .iter()
        .find(|u| canonical_username(&u.username) == username)
    else {
        return Err(AppError::Unauthorized(
            "invalid username or password".into(),
        ));
    };
    if !user.active {
        return Err(AppError::Unauthorized("account is disabled".into()));
    }
    let attempted = hash_password(&username, password);
    if attempted != user.password_hash {
        return Err(AppError::Unauthorized(
            "invalid username or password".into(),
        ));
    }
    Ok(AuthSession {
        username: user.username.clone(),
        role: user.role.clone(),
    })
}

pub fn list_users(config_dir: &Path, actor: &str) -> Result<Vec<AuthUser>, AppError> {
    let store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    require_admin(&store, actor)?;
    Ok(store.users.iter().map(StoredUser::public).collect())
}

pub fn set_user_active(
    config_dir: &Path,
    actor: &str,
    username: &str,
    active: bool,
) -> Result<Vec<AuthUser>, AppError> {
    let mut store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    require_admin(&store, actor)?;

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
        actor,
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
        return Err(AppError::InvalidPath(
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
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path(config_dir))?;
    writeln!(file, "{json}")?;
    Ok(())
}

pub fn read_audit(
    config_dir: &Path,
    actor: &str,
    limit: u32,
) -> Result<Vec<AuditLogEntry>, AppError> {
    let store = load_store(config_dir)?;
    persist_seeded_store_if_needed(config_dir, &store)?;
    require_admin(&store, actor)?;

    let path = audit_path(config_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(AppError::Io(e.to_string())),
    };

    let limit = limit.clamp(1, 500) as usize;
    let mut entries = Vec::new();
    for line in text.lines().rev() {
        if entries.len() >= limit {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<AuditLogEntry>(line) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_admin_can_login() {
        let dir = tempdir().unwrap();
        let session = authenticate(dir.path(), "admin", "admin").unwrap();
        assert_eq!(session.username, "admin");
        assert_eq!(session.role, UserRole::Admin);
    }

    #[test]
    fn wrong_password_is_unauthorized() {
        let dir = tempdir().unwrap();
        let err = authenticate(dir.path(), "admin", "wrong").unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    }

    #[test]
    fn admin_can_toggle_standard_user() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        let users = set_user_active(dir.path(), "admin", "mgkyung", false).unwrap();
        let mgkyung = users.iter().find(|u| u.username == "mgkyung").unwrap();
        assert!(!mgkyung.active);
    }

    #[test]
    fn non_admin_cannot_list_users() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "mgkyung", "mgkyung").unwrap();
        let err = list_users(dir.path(), "mgkyung").unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    }

    #[test]
    fn audit_is_returned_newest_first() {
        let dir = tempdir().unwrap();
        authenticate(dir.path(), "admin", "admin").unwrap();
        append_audit(dir.path(), "admin", "first", None).unwrap();
        append_audit(dir.path(), "admin", "second", Some("note".into())).unwrap();
        let entries = read_audit(dir.path(), "admin", 10).unwrap();
        assert_eq!(entries[0].action, "second");
        assert_eq!(entries[1].action, "first");
    }
}
