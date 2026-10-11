//! Payloads of the `vault:changed` / `vault:watch-error` events the vault
//! watcher emits — see vault/wiki/ipc-api.md ("Events") and
//! vault/wiki/concurrency-safety.md ("External change detection").

use serde::{Deserialize, Serialize};

/// What happened to one path, after a batch has been coalesced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Created,
    Modified,
    Removed,
}

/// One coalesced change inside a `vault:changed` batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChange {
    /// Vault-relative path in normal form (forward slashes). Directories
    /// appear with their own path.
    pub rel_path: String,
    pub kind: ChangeKind,
    /// True when naiteh itself caused the change (it was recorded by
    /// `services::fs` / `services::own_changes` within the TTL).
    pub own: bool,
}

/// Payload of `vault:changed`: one debounced batch of filesystem changes
/// under the active vault. At most one entry per `rel_path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChanged {
    pub vault_root: String,
    pub changes: Vec<VaultChange>,
    /// The OS watcher lost events (buffer overflow / rescan requested);
    /// `changes` may be empty. Treat as "refresh everything".
    pub overflow: bool,
}

/// Payload of `vault:watch-error`: live updates are unavailable for this
/// vault (neither the native nor the polling watcher could run).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultWatchError {
    pub vault_root: String,
    pub message: String,
}
