//! Single-user app lock. This protects IPC access, not plaintext vault files.
//! Legacy accounts are read only for explicit one-time conversion.

use std::path::Path;

use argon2::password_hash::{PasswordHash, PasswordVerifier};
use argon2::Argon2;
use serde::{Deserialize, Serialize};

use crate::domain::{AppError, AuthAccess};
use crate::services::{auth, fs as fsx, session::ActiveSession};

#[derive(Default)]
pub struct AccessOperations(pub tokio::sync::Mutex<()>);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockConfig {
    pub enabled: bool,
    pub password_hash: Option<String>,
}

/// None means an existing legacy account store requires explicit conversion.
pub fn load(config_dir: &Path) -> Result<Option<LockConfig>, AppError> {
    let path = config_dir.join("app-lock.json");
    match fsx::read_json::<LockConfig>(&path) {
        Ok(config) => {
            if config.enabled {
                let hash = config.password_hash.as_deref().ok_or_else(corrupt)?;
                let parsed = PasswordHash::new(hash).map_err(|_| corrupt())?;
                if parsed.algorithm.as_str() != "argon2id" {
                    return Err(corrupt());
                }
            } else if config.password_hash.is_some() {
                return Err(corrupt());
            }
            Ok(Some(config))
        }
        Err(AppError::NotFound(_)) => {
            if config_dir.join("auth.json").try_exists()? {
                return Ok(None);
            }
            let config = LockConfig::default();
            save(config_dir, &config)?;
            Ok(Some(config))
        }
        Err(AppError::ConfigCorrupt(_)) => Err(corrupt()),
        Err(error) => Err(error),
    }
}

fn corrupt() -> AppError {
    AppError::ConfigCorrupt("Invalid app-lock.json; restore a valid configuration and retry".into())
}

fn save(config_dir: &Path, config: &LockConfig) -> Result<(), AppError> {
    fsx::ensure_dir(config_dir)?;
    fsx::write_json(&config_dir.join("app-lock.json"), config)
}

pub fn remove_remembered_session(config_dir: &Path) -> Result<(), AppError> {
    match fsx::remove_file(&config_dir.join("remembered-session.json")) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn access(config: Option<&LockConfig>, active: &ActiveSession) -> Result<AuthAccess, AppError> {
    match config {
        None => {
            active.clear();
            Ok(AuthAccess {
                lock_enabled: true,
                migration_required: true,
                login: None,
            })
        }
        Some(config) => Ok(AuthAccess {
            lock_enabled: config.enabled,
            migration_required: false,
            login: if config.enabled {
                active.current()
            } else {
                Some(active.open_local()?)
            },
        }),
    }
}

pub fn verify(config: &LockConfig, password: &str) -> Result<(), AppError> {
    if !config.enabled {
        return Err(AppError::Validation("App lock is not enabled".into()));
    }
    if password.chars().take(auth::MAX_PASSWORD_CHARS + 1).count() > auth::MAX_PASSWORD_CHARS {
        return Err(AppError::Validation("Password is too long".into()));
    }
    let hash = config.password_hash.as_deref().ok_or_else(corrupt)?;
    let parsed = PasswordHash::new(hash).map_err(|_| corrupt())?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| AppError::Unauthorized("Incorrect app-lock password".into()))
}

fn validate_new(password: &str, current: Option<&str>) -> Result<(), AppError> {
    let count = password.chars().take(auth::MAX_PASSWORD_CHARS + 1).count();
    if !(auth::MIN_PASSWORD_CHARS..=auth::MAX_PASSWORD_CHARS).contains(&count) {
        return Err(AppError::Validation(format!(
            "App-lock password must be {}-{} characters",
            auth::MIN_PASSWORD_CHARS,
            auth::MAX_PASSWORD_CHARS
        )));
    }
    if current == Some(password) {
        return Err(AppError::Validation(
            "New password must differ from the current password".into(),
        ));
    }
    Ok(())
}

pub fn migrate(
    config_dir: &Path,
    username: &str,
    password: &str,
    new_password: &str,
) -> Result<LockConfig, AppError> {
    if load(config_dir)?.is_some() {
        return Err(AppError::Validation(
            "Legacy account conversion is not required".into(),
        ));
    }
    auth::authenticate(config_dir, username, password)?;
    validate_new(new_password, Some(password))?;
    if new_password.trim().eq_ignore_ascii_case(username.trim()) {
        return Err(AppError::Validation(
            "New password must not be the legacy username".into(),
        ));
    }
    let config = LockConfig {
        enabled: true,
        password_hash: Some(auth::hash_password_argon2(new_password)?),
    };
    remove_remembered_session(config_dir)?;
    save(config_dir, &config)?;
    Ok(config)
}

pub fn configure(
    config_dir: &Path,
    config: &LockConfig,
    enabled: bool,
    current_password: Option<&str>,
    new_password: Option<&str>,
) -> Result<LockConfig, AppError> {
    if config.enabled {
        verify(config, current_password.unwrap_or(""))?;
    }
    let next = if enabled {
        let hash = match new_password {
            Some(password) => {
                validate_new(password, current_password)?;
                auth::hash_password_argon2(password)?
            }
            None if config.enabled => config.password_hash.clone().ok_or_else(corrupt)?,
            None => {
                return Err(AppError::Validation(
                    "A new app-lock password is required".into(),
                ))
            }
        };
        LockConfig {
            enabled: true,
            password_hash: Some(hash),
        }
    } else {
        LockConfig::default()
    };
    save(config_dir, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_install_is_unlocked_but_never_uses_legacy_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(dir.path()).unwrap().unwrap();
        let active = ActiveSession::default();
        let state = access(Some(&config), &active).unwrap();
        assert!(!state.lock_enabled);
        assert!(state.login.is_some());
        assert!(!dir.path().join("auth.json").exists());
    }

    #[test]
    fn enabling_lock_persists_only_hash_and_restart_is_locked() {
        let dir = tempfile::tempdir().unwrap();
        let original = load(dir.path()).unwrap().unwrap();
        let config = configure(dir.path(), &original, true, None, Some("new-password")).unwrap();
        let bytes = std::fs::read_to_string(dir.path().join("app-lock.json")).unwrap();
        assert!(!bytes.contains("new-password"));
        assert!(bytes.contains("$argon2id$"));
        let active = ActiveSession::default();
        assert!(access(Some(&config), &active).unwrap().login.is_none());
        assert!(verify(&config, "wrong").is_err());
        verify(&config, "new-password").unwrap();
        active.open_local().unwrap();
        assert!(access(Some(&config), &active).unwrap().login.is_some());
    }

    #[test]
    fn disabling_or_changing_lock_requires_current_password() {
        let dir = tempfile::tempdir().unwrap();
        let config = configure(
            dir.path(),
            &LockConfig::default(),
            true,
            None,
            Some("old-password"),
        )
        .unwrap();
        assert!(configure(dir.path(), &config, false, Some("wrong"), None).is_err());
        assert!(configure(dir.path(), &config, true, None, Some("new-password")).is_err());
        assert!(configure(
            dir.path(),
            &config,
            true,
            Some("old-password"),
            Some("old-password")
        )
        .is_err());
        let next = configure(
            dir.path(),
            &config,
            true,
            Some("old-password"),
            Some("new-password"),
        )
        .unwrap();
        assert!(verify(&next, "old-password").is_err());
        let disabled = configure(dir.path(), &next, false, Some("new-password"), None).unwrap();
        assert!(!disabled.enabled);
        assert!(disabled.password_hash.is_none());
    }

    fn legacy(dir: &Path) {
        fsx::write_json(
            &dir.join("auth.json"),
            &serde_json::json!({
                "users": [{"username":"chosen", "role":"Admin", "active":true,
                    "passwordHash": auth::hash_password_argon2("old-password").unwrap()}]
            }),
        )
        .unwrap();
        fsx::atomic_write(&dir.join("remembered-session.json"), b"legacy-token").unwrap();
    }

    #[test]
    fn legacy_requires_explicit_conversion_with_new_password() {
        let dir = tempfile::tempdir().unwrap();
        legacy(dir.path());
        assert!(load(dir.path()).unwrap().is_none());
        let active = ActiveSession::default();
        let status = access(None, &active).unwrap();
        assert!(status.migration_required && status.login.is_none());
        assert!(migrate(dir.path(), "wrong-user", "old-password", "new-password").is_err());
        assert!(migrate(dir.path(), "chosen", "old-password", "old-password").is_err());
        assert!(!dir.path().join("app-lock.json").exists());
        let next = migrate(dir.path(), "chosen", "old-password", "new-password").unwrap();
        assert!(next.enabled);
        assert!(!dir.path().join("remembered-session.json").exists());
        assert!(dir.path().join("auth.json").exists());
        assert!(migrate(dir.path(), "chosen", "old-password", "another-password").is_err());
        verify(&load(dir.path()).unwrap().unwrap(), "new-password").unwrap();
    }

    #[test]
    fn corrupt_config_does_not_disable_protection() {
        let dir = tempfile::tempdir().unwrap();
        for content in [
            r#"{"enabled":true}"#,
            r#"{"enabled":true,"passwordHash":"bad"}"#,
            "{",
        ] {
            fsx::atomic_write(&dir.path().join("app-lock.json"), content.as_bytes()).unwrap();
            assert!(matches!(load(dir.path()), Err(AppError::ConfigCorrupt(_))));
        }
    }

    #[test]
    fn passwords_are_bounded_by_characters_not_bytes() {
        assert!(validate_new("1234567", None).is_err());
        assert!(validate_new(&"a".repeat(1025), None).is_err());
        assert!(validate_new(&"a".repeat(1024), None).is_ok());
    }
}
