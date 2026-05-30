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

    /// Input failed a semantic check (empty field, bad shape) that isn't
    /// about a filesystem path. Distinct from `InvalidPath` so the UI can
    /// phrase it as a form-validation message.
    #[error("Validation: {0}")]
    Validation(String),

    /// A network request couldn't be completed (connection refused,
    /// timeout, DNS, TLS). The remote was never reached or didn't reply.
    #[error("Network: {0}")]
    Network(String),

    /// A reached upstream service replied with an error status or an
    /// unparseable body (e.g. the AI provider returned 401/429/500).
    #[error("Upstream: {0}")]
    Upstream(String),

    #[error("Cancelled")]
    Cancelled,
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_variants_serialize_as_kind_plus_message() {
        let json = serde_json::to_string(&AppError::Network("timeout".into())).unwrap();
        assert_eq!(json, r#"{"kind":"Network","message":"timeout"}"#);

        let json = serde_json::to_string(&AppError::Upstream("429".into())).unwrap();
        assert_eq!(json, r#"{"kind":"Upstream","message":"429"}"#);

        let json =
            serde_json::to_string(&AppError::Validation("empty field".into())).unwrap();
        assert_eq!(json, r#"{"kind":"Validation","message":"empty field"}"#);
    }

    #[test]
    fn unit_variant_serializes_as_kind_only() {
        let json = serde_json::to_string(&AppError::Cancelled).unwrap();
        assert_eq!(json, r#"{"kind":"Cancelled"}"#);
    }
}
