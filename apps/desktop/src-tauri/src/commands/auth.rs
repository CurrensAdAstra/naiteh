//! Single-user app access and local activity IPC. Password work and credential
//! migration run on the blocking pool; access transitions are serialized.

use std::path::PathBuf;
use std::time::Instant;

use crate::domain::{AppError, AuditLogEntry, AuthAccess};
use crate::services::app_lock::{self, AccessOperations};
use crate::services::session::{ActiveSession, LoginThrottle};
use crate::services::{auth, config, credentials, fs as fsx};

fn app_config_dir() -> Result<PathBuf, AppError> {
    config::default_app_config_dir()
}

#[tauri::command]
pub async fn auth_bootstrap(
    active: tauri::State<'_, ActiveSession>,
    operations: tauri::State<'_, AccessOperations>,
) -> Result<AuthAccess, AppError> {
    let _guard = operations.0.lock().await;
    let dir = app_config_dir()?;
    let config = fsx::run_blocking(move || {
        app_lock::remove_remembered_session(&dir)?;
        app_lock::load(&dir)
    })
    .await?;
    app_lock::access(config.as_ref(), &active)
}

#[tauri::command]
pub async fn auth_unlock(
    active: tauri::State<'_, ActiveSession>,
    operations: tauri::State<'_, AccessOperations>,
    throttle: tauri::State<'_, LoginThrottle>,
    password: String,
) -> Result<AuthAccess, AppError> {
    let _guard = operations.0.lock().await;
    throttle.begin_attempt("app-lock", Instant::now())?;
    let dir = app_config_dir()?;
    let config = fsx::run_blocking(move || {
        let config = app_lock::load(&dir)?
            .ok_or_else(|| AppError::Validation("Convert legacy accounts first".into()))?;
        app_lock::verify(&config, &password)?;
        let _ = auth::append_audit(&dir, "local", "app_unlock", None);
        Ok(config)
    })
    .await?;
    throttle.succeed("app-lock");
    active.open_local()?;
    app_lock::access(Some(&config), &active)
}

#[tauri::command]
pub async fn auth_migrate(
    active: tauri::State<'_, ActiveSession>,
    operations: tauri::State<'_, AccessOperations>,
    throttle: tauri::State<'_, LoginThrottle>,
    username: String,
    password: String,
    new_password: String,
) -> Result<AuthAccess, AppError> {
    let _guard = operations.0.lock().await;
    throttle.begin_attempt("app-lock", Instant::now())?;
    let dir = app_config_dir()?;
    let config = fsx::run_blocking(move || {
        let config = app_lock::migrate(&dir, &username, &password, &new_password)?;
        let _ = auth::append_audit(&dir, "local", "single_user_migration", None);
        Ok(config)
    })
    .await?;
    throttle.succeed("app-lock");
    active.open_local()?;
    app_lock::access(Some(&config), &active)
}

#[tauri::command]
pub async fn auth_set_lock(
    active: tauri::State<'_, ActiveSession>,
    operations: tauri::State<'_, AccessOperations>,
    throttle: tauri::State<'_, LoginThrottle>,
    token: String,
    enabled: bool,
    current_password: Option<String>,
    new_password: Option<String>,
) -> Result<AuthAccess, AppError> {
    active.require_token(&token)?;
    let _guard = operations.0.lock().await;
    active.require_token(&token)?;
    throttle.begin_attempt("app-lock", Instant::now())?;
    let dir = app_config_dir()?;
    let config = fsx::run_blocking(move || {
        let config = app_lock::load(&dir)?
            .ok_or_else(|| AppError::Validation("Convert legacy accounts first".into()))?;
        let next = app_lock::configure(
            &dir,
            &config,
            enabled,
            current_password.as_deref(),
            new_password.as_deref(),
        )?;
        let _ = auth::append_audit(
            &dir,
            "local",
            "app_lock_configured",
            Some(if enabled { "enabled" } else { "disabled" }.into()),
        );
        Ok(next)
    })
    .await?;
    throttle.succeed("app-lock");
    app_lock::access(Some(&config), &active)
}

#[tauri::command]
pub async fn auth_lock(
    active: tauri::State<'_, ActiveSession>,
    operations: tauri::State<'_, AccessOperations>,
    token: String,
) -> Result<(), AppError> {
    active.require_token(&token)?;
    let _guard = operations.0.lock().await;
    active.require_token(&token)?;
    let dir = app_config_dir()?;
    let work_dir = dir.clone();
    fsx::run_blocking(move || {
        if !app_lock::load(&work_dir)?.is_some_and(|config| config.enabled) {
            return Err(AppError::Validation(
                "Enable app lock in Security settings first".into(),
            ));
        }
        Ok(())
    })
    .await?;
    active.close(&token)?;
    // Activity-log failures must not undo or misreport a completed lock.
    let _ = fsx::run_blocking(move || auth::append_audit(&dir, "local", "app_lock", None)).await;
    Ok(())
}

#[tauri::command]
pub async fn auth_migrate_secrets(
    active: tauri::State<'_, ActiveSession>,
    token: String,
) -> Result<(), AppError> {
    active.require_token(&token)?;
    let dir = app_config_dir()?;
    fsx::run_blocking(move || credentials::migrate_legacy(&dir).map(|_| ())).await
}

#[tauri::command]
pub async fn auth_list_audit_logs(
    active: tauri::State<'_, ActiveSession>,
    token: String,
    limit: u32,
) -> Result<Vec<AuditLogEntry>, AppError> {
    active.require_token(&token)?;
    let dir = app_config_dir()?;
    fsx::run_blocking(move || auth::read_audit(&dir, limit)).await
}

#[tauri::command]
pub async fn auth_log_action(
    active: tauri::State<'_, ActiveSession>,
    token: String,
    action: String,
    detail: Option<String>,
) -> Result<(), AppError> {
    active.require_token(&token)?;
    let dir = app_config_dir()?;
    fsx::run_blocking(move || auth::log_client_action(&dir, "local", &action, detail)).await
}
