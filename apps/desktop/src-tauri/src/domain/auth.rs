//! Auth & audit types — see vault/wiki/domain-model.md ("Auth & Audit").

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum UserRole {
    Admin,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub username: String,
    pub role: UserRole,
}

/// In-memory access for the single local actor. Never persisted or used
/// for account isolation; manual locking/restart invalidates the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub token: String,
    pub session: AuthSession,
    pub must_change_password: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccess {
    pub lock_enabled: bool,
    pub migration_required: bool,
    pub login: Option<LoginResult>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub timestamp: String,
    pub username: String,
    pub action: String,
    pub detail: Option<String>,
}
