//! Auth and audit IPC commands — see architecture.md §7.9.

use crate::domain::{AppError, AuditLogEntry, AuthSession, AuthUser};
use crate::services::{auth, config};

fn app_config_dir() -> Result<std::path::PathBuf, AppError> {
    let dir = config::default_app_config_dir()?;
    crate::services::fs::ensure_dir(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn auth_login(username: String, password: String) -> Result<AuthSession, AppError> {
    let dir = app_config_dir()?;
    match auth::authenticate(&dir, &username, &password) {
        Ok(session) => {
            auth::append_audit(&dir, &session.username, "login_success", None)?;
            Ok(session)
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
pub fn auth_list_users(actor: String) -> Result<Vec<AuthUser>, AppError> {
    let dir = app_config_dir()?;
    auth::list_users(&dir, &actor)
}

#[tauri::command]
pub fn auth_set_user_active(
    actor: String,
    username: String,
    active: bool,
) -> Result<Vec<AuthUser>, AppError> {
    let dir = app_config_dir()?;
    auth::set_user_active(&dir, &actor, &username, active)
}

#[tauri::command]
pub fn auth_list_audit_logs(actor: String, limit: u32) -> Result<Vec<AuditLogEntry>, AppError> {
    let dir = app_config_dir()?;
    auth::read_audit(&dir, &actor, limit)
}

#[tauri::command]
pub fn auth_log_action(
    username: String,
    action: String,
    detail: Option<String>,
) -> Result<(), AppError> {
    let dir = app_config_dir()?;
    auth::append_audit(&dir, &username, &action, detail)
}
