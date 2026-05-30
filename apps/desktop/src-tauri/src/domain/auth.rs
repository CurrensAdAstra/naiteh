//! Auth & audit types — see architecture.md §6.8.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum UserRole {
    Admin,
    User,
}

/// Public account shape returned to the frontend. Password hashes stay
/// backend-only in the auth service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub username: String,
    pub role: UserRole,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub username: String,
    pub role: UserRole,
}

/// Returned by `auth_login`. The `token` is an opaque bearer string the
/// frontend stores in memory and passes to every subsequent IPC that
/// needs to know who is asking; the backend resolves it via
/// `services::auth::SessionStore`. Tokens are not persisted — restart
/// invalidates all sessions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub token: String,
    pub session: AuthSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub timestamp: String,
    pub username: String,
    pub action: String,
    pub detail: Option<String>,
}
