use serde::Serialize;
use thiserror::Error;

/// Application error that crosses the IPC boundary.
///
/// Serializes as a tagged union (`{ "kind": "...", "message": "..." }`) so the
/// frontend can pattern-match on `kind`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("I/O: {0}")]
    Io(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid path: {0}")]
    InvalidPath(String),

    #[error("Vault already initialized: {0}")]
    AlreadyInitialized(String),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Config corrupt: {0}")]
    ConfigCorrupt(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Cancelled")]
    Cancelled,
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}
