//! Auth & audit types — see vault/wiki/domain-model.md ("Auth & Audit").

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

/// Returned by `auth_login` and `auth_resume`. The `token` is an opaque
/// bearer string the frontend keeps in memory and passes to the auth
/// IPCs that need to know who is asking; the backend resolves it via
/// `services::auth::SessionStore` (12 h idle / 7-day absolute expiry).
/// Tokens live in process memory, except that with "keep me signed in"
/// (`remember: true`) the token is also persisted to
/// `remembered-session.json` (30-day TTL) so `auth_resume` can restore
/// it after a restart; without it, a restart signs the user out.
///
/// `must_change_password` is true while the account still has the
/// seeded default password; the UI must route to a change-password
/// screen (`auth_change_password`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub token: String,
    pub session: AuthSession,
    pub must_change_password: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub timestamp: String,
    pub username: String,
    pub action: String,
    pub detail: Option<String>,
}
