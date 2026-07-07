//! Per-vault mutual exclusion for write + sync paths.
//!
//! architecture.md §9 promises "sync_now takes a vault-level lock" so
//! autosave can't land between `git add_all` and `git commit`, and so a
//! force-checkout from `git pull` can't race a `notes_write`. This
//! module is that lock.
//!
//! The lock is keyed on the **canonical vault root** so that different
//! string spellings of the same path (e.g. `/Users/me/v` vs
//! `/Users/me/./v`) share one mutex. Each vault gets its own
//! `tokio::sync::Mutex` so commands stay async-friendly and don't
//! block the IPC threadpool while waiting.
//!
//! Usage from an IPC command:
//! ```ignore
//! #[tauri::command]
//! pub async fn notes_write(
//!     locks: tauri::State<'_, VaultLocks>,
//!     rel_path: String,
//!     content: String,
//! ) -> Result<NoteMeta, AppError> {
//!     let vault_root = config::current_vault_root()?;
//!     let lock = locks.for_vault(&vault_root);
//!     let _guard = lock.lock().await;
//!     notes_write_impl(&vault_root, &rel_path, &content)
//! }
//! ```
//!
//! Read-only IPC commands deliberately do **not** acquire the lock —
//! they may observe an in-flight sync's intermediate state, but the
//! files they touch are atomically renamed, so the worst case is
//! reading the previous version (never a torn write).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex as AsyncMutex;

#[derive(Default)]
pub struct VaultLocks {
    inner: StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>,
}

impl VaultLocks {
    /// Returns the shared async mutex for `root`. Callers should hold
    /// the returned `Arc<Mutex>` only briefly — long enough to acquire
    /// and complete one write or sync operation.
    pub fn for_vault(&self, root: &Path) -> Arc<AsyncMutex<()>> {
        let key = canonical_or_owned(root);
        let mut map = self.inner.lock().expect("vault-lock map poisoned");
        map.entry(key)
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

fn canonical_or_owned(path: &Path) -> PathBuf {
    // canonicalize fails if the path doesn't exist (e.g. mid-vault-init).
    // Fall back to the raw path in that case — the lock is still useful
    // even if two callers happen to spell it differently, because the
    // most common caller (`config::current_vault_root`) returns a
    // canonical-ish path already.
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn same_vault_returns_same_mutex_instance() {
        let dir = tempdir().unwrap();
        let locks = VaultLocks::default();
        let a = locks.for_vault(dir.path());
        let b = locks.for_vault(dir.path());
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn different_vaults_get_independent_mutexes() {
        let v1 = tempdir().unwrap();
        let v2 = tempdir().unwrap();
        let locks = VaultLocks::default();
        let a = locks.for_vault(v1.path());
        let b = locks.for_vault(v2.path());
        assert!(!Arc::ptr_eq(&a, &b));

        // Both should be acquirable independently.
        let _guard_a = a.lock().await;
        let _guard_b = b.lock().await;
    }

    #[tokio::test]
    async fn lock_serializes_concurrent_holders() {
        let dir = tempdir().unwrap();
        let locks = VaultLocks::default();
        let lock = locks.for_vault(dir.path());
        let guard = lock.clone().lock_owned().await;

        // A second acquire must block until the first is released.
        let try_now = lock.try_lock();
        assert!(try_now.is_err(), "expected contention");

        drop(guard);
        let _g2 = lock.try_lock().expect("lock should be free");
    }
}
