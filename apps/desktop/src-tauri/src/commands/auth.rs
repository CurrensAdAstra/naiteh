//! Auth and audit IPC commands — see vault/wiki/ipc-api.md ("Auth &
//! Audit", "Session gate").
//!
//! Two layers:
//!   - The auth commands use a bearer token: `auth_login` verifies the
//!     password and returns a fresh token; every auth command that needs
//!     to know who is asking takes that token and resolves it against
//!     the in-process `SessionStore`. The frontend never sends a plain
//!     username for authorization purposes.
//!   - `auth_login` / `auth_resume` also mark the instance's
//!     `ActiveSession`, which gates every *non*-auth command
//!     (`services::session::require_session`); `auth_logout` clears it.
//!
//! The commands that run Argon2 (`auth_login`, `auth_change_password`,
//! `auth_create_user`) are async and hash on the blocking pool, so the
//! UI never freezes on them.

use std::time::Instant;

use crate::domain::{AppError, AuditLogEntry, AuthUser, LoginResult, UserRole};
use crate::services::auth::{self, SessionStore};
use crate::services::config;
use crate::services::fs as fsx;
use crate::services::session::{ActiveSession, LoginThrottle};

fn app_config_dir() -> Result<std::path::PathBuf, AppError> {
    let dir = config::default_app_config_dir()?;
    fsx::ensure_dir(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub async fn auth_login(
    sessions: tauri::State<'_, SessionStore>,
    active: tauri::State<'_, ActiveSession>,
    throttle: tauri::State<'_, LoginThrottle>,
    username: String,
    password: String,
    remember: bool,
) -> Result<LoginResult, AppError> {
    let dir = app_config_dir()?;
    let canonical = auth::canonical_username(&username);

    // Lockout check (and attempt reservation) before any hashing.
    if let Err(e) = throttle.begin_attempt(&canonical, Instant::now()) {
        let _ = auth::append_audit(&dir, &username, "login_failure", Some("locked out".into()));
        return Err(e);
    }

    let verify_dir = dir.clone();
    let user = username.clone();
    let outcome =
        fsx::run_blocking(move || auth::authenticate(&verify_dir, &user, &password)).await;

    match outcome {
        Ok(outcome) => {
            throttle.succeed(&canonical);
            let session = outcome.session;
            auth::append_audit(&dir, &session.username, "login_success", None)?;
            let token = sessions.issue(session.clone());
            open_gate_unless_change_pending(
                &active,
                &token,
                &session,
                outcome.must_change_password,
            );
            // Opt-in: persist so the next launch can skip the login
            // screen. When not remembering, clear any prior record so it
            // can't outlive this login.
            if remember {
                auth::save_remembered(&dir, &token, &session)?;
            } else {
                auth::clear_remembered(&dir);
            }
            Ok(LoginResult {
                token,
                session,
                must_change_password: outcome.must_change_password,
            })
        }
        Err(e) => {
            let detail = match &e {
                AppError::Unauthorized(message) => Some(message.clone()),
                AppError::ConfigCorrupt(_) => Some("no active admin account".to_string()),
                _ => Some("login error".to_string()),
            };
            let _ = auth::append_audit(&dir, &username, "login_failure", detail);
            Err(e)
        }
    }
}

/// Resume a remembered session on startup without a password. Returns
/// `None` when there is no valid remembered session (missing, expired,
/// or the account was disabled/removed since) — see
/// `auth::load_remembered` for the rules.
#[tauri::command]
pub async fn auth_resume(
    sessions: tauri::State<'_, SessionStore>,
    active: tauri::State<'_, ActiveSession>,
) -> Result<Option<LoginResult>, AppError> {
    let dir = app_config_dir()?;
    // load_remembered may run one Argon2 verify (default-password check).
    let load_dir = dir.clone();
    let remembered = fsx::run_blocking(move || Ok(auth::load_remembered(&load_dir))).await?;
    let Some(remembered) = remembered else {
        return Ok(None);
    };
    let auth::RememberedLogin {
        token,
        session,
        must_change_password,
    } = remembered;
    sessions.install(token.clone(), session.clone());
    open_gate_unless_change_pending(&active, &token, &session, must_change_password);
    auth::append_audit(&dir, &session.username, "session_resume", None)?;
    Ok(Some(LoginResult {
        token,
        session,
        must_change_password,
    }))
}

#[tauri::command]
pub fn auth_logout(
    sessions: tauri::State<'_, SessionStore>,
    active: tauri::State<'_, ActiveSession>,
    token: String,
) {
    sessions.revoke(&token);
    active.clear_if(&token);
    // Signing out must also drop the remembered session, else the next
    // launch would silently sign back in.
    if let Ok(dir) = app_config_dir() {
        auth::clear_remembered(&dir);
    }
}

/// Any signed-in, active user changes their own password. Revokes the
/// user's other in-memory tokens and their remembered session; the
/// calling token stays valid.
/// Open the session gate for a fresh login/resume — unless the account
/// must still replace its default password. Then the token is valid for
/// the auth commands (so `auth_change_password` works) but every gated
/// command stays `Unauthorized` until the change succeeds; the forced
/// change is enforced here, not only by the UI.
fn open_gate_unless_change_pending(
    active: &ActiveSession,
    token: &str,
    session: &crate::domain::AuthSession,
    must_change_password: bool,
) {
    if must_change_password {
        active.clear();
    } else {
        active.set(token, session.clone());
    }
}

#[tauri::command]
pub async fn auth_change_password(
    sessions: tauri::State<'_, SessionStore>,
    active: tauri::State<'_, ActiveSession>,
    token: String,
    current_password: String,
    new_password: String,
) -> Result<(), AppError> {
    let session = sessions.resolve(&token)?;
    let dir = app_config_dir()?;
    let username = session.username.clone();
    let work_dir = dir.clone();
    fsx::run_blocking(move || {
        auth::change_password(&work_dir, &username, &current_password, &new_password)
    })
    .await?;
    sessions.revoke_user(&session.username, Some(&token));
    auth::clear_remembered_for(&dir, &session.username);
    // A login held back by a pending forced change opens the gate now.
    active.set(&token, session);
    Ok(())
}

/// Admin only: add an account. Returns the full user list.
#[tauri::command]
pub async fn auth_create_user(
    sessions: tauri::State<'_, SessionStore>,
    token: String,
    username: String,
    password: String,
    role: UserRole,
) -> Result<Vec<AuthUser>, AppError> {
    let admin = sessions.require_admin(&token)?;
    let dir = app_config_dir()?;
    fsx::run_blocking(move || auth::create_user(&dir, &admin.username, &username, &password, role))
        .await
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
    let users = auth::set_user_active(&dir, &admin.username, &username, active)?;
    if !active {
        // A disabled account loses its live tokens and remembered login.
        sessions.revoke_user(&username, None);
        auth::clear_remembered_for(&dir, &username);
    }
    Ok(users)
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

/// Record a renderer-originated work event. Only the allowlisted
/// actions in `auth::CLIENT_AUDIT_ACTIONS` are accepted; `detail` is
/// truncated to 512 characters.
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
    auth::log_client_action(&dir, &session.username, &action, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AuthSession;
    use crate::services::session::require_session;

    fn admin() -> AuthSession {
        AuthSession {
            username: "admin".into(),
            role: UserRole::Admin,
        }
    }

    #[test]
    fn pending_password_change_keeps_the_gate_closed() {
        let active = ActiveSession::default();
        open_gate_unless_change_pending(&active, "tok", &admin(), true);
        assert!(matches!(
            require_session(&active),
            Err(AppError::Unauthorized(_))
        ));
    }

    #[test]
    fn pending_change_replaces_an_earlier_open_session() {
        let active = ActiveSession::default();
        active.set("old", admin());
        open_gate_unless_change_pending(&active, "new", &admin(), true);
        assert!(require_session(&active).is_err());
    }

    #[test]
    fn normal_login_opens_the_gate() {
        let active = ActiveSession::default();
        open_gate_unless_change_pending(&active, "tok", &admin(), false);
        assert_eq!(require_session(&active).unwrap().username, "admin");
    }
}
