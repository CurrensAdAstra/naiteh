//! Auth and audit IPC commands — see architecture.md §7.9.
//!
//! The authentication boundary is a single bearer token: `auth_login`
//! authenticates the password and returns a fresh token; every command
//! that needs to know who is asking takes that token and resolves it
//! against the in-process `SessionStore`. The frontend never sends a
//! plain username for authorization purposes.

use crate::domain::{AppError, AuditLogEntry, AuthUser, LoginResult};
use crate::services::auth::{self, SessionStore};
use crate::services::config;

fn app_config_dir() -> Result<std::path::PathBuf, AppError> {
    let dir = config::default_app_config_dir()?;
    crate::services::fs::ensure_dir(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn auth_login(
    sessions: tauri::State<'_, SessionStore>,
    username: String,
    password: String,
) -> Result<LoginResult, AppError> {
    let dir = app_config_dir()?;
    match auth::authenticate(&dir, &username, &password) {
        Ok(session) => {
            auth::append_audit(&dir, &session.username, "login_success", None)?;
            let token = sessions.issue(session.clone());
            Ok(LoginResult { token, session })
        }
        Err(e) => {
            let detail = match &e {
                AppError::Unauthorized(message) => Some(message.clone()),
                _ => Some("login error".to_string()),
            };
            let _ = auth::append_audit(&dir, &username, "login_failure", detail);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn auth_logout(sessions: tauri::State<'_, SessionStore>, token: String) {
    sessions.revoke(&token);
}

#[tauri::command]
pub fn auth_list_users(
    sessions: tauri::State<'_, SessionStore>,
    token: String,
) -> Result<Vec<AuthUser>, AppError> {
    sessions.require_admin(&token)?;
    let dir = app_config_dir()?;
    auth::list_users(&dir)
}

#[tauri::command]
pub fn auth_set_user_active(
    sessions: tauri::State<'_, SessionStore>,
    token: String,
    username: String,
    active: bool,
) -> Result<Vec<AuthUser>, AppError> {
    let admin = sessions.require_admin(&token)?;
    let dir = app_config_dir()?;
    auth::set_user_active(&dir, &admin.username, &username, active)
}

#[tauri::command]
pub fn auth_list_audit_logs(
    sessions: tauri::State<'_, SessionStore>,
    token: String,
    limit: u32,
) -> Result<Vec<AuditLogEntry>, AppError> {
    sessions.require_admin(&token)?;
    let dir = app_config_dir()?;
    auth::read_audit(&dir, limit)
}

#[tauri::command]
pub fn auth_log_action(
    sessions: tauri::State<'_, SessionStore>,
    token: String,
    action: String,
    detail: Option<String>,
) -> Result<(), AppError> {
    // Any live session — admin or user — may log work events for itself.
    let session = sessions.resolve(&token)?;
    let dir = app_config_dir()?;
    auth::append_audit(&dir, &session.username, &action, detail)
}
