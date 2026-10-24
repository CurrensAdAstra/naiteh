//! OS credential storage. JSON contains opaque references, never new secrets.
//! Native failures are deliberately not formatted: platform errors can contain
//! credential data. Tests use an isolated, failure-injectable memory store.

use std::collections::BTreeSet;
use std::path::Path;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::domain::AppError;
use crate::services::{backup, config, fs as fsx};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CredentialRef(String);

impl CredentialRef {
    fn valid(&self) -> bool {
        self.0.len() == 35
            && self.0.starts_with("v1-")
            && self.0[3..].bytes().all(|b| b.is_ascii_hexdigit())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    Unavailable,
    Missing,
}

impl StoreError {
    fn app_error(self) -> AppError {
        match self {
            Self::Unavailable => AppError::Io(
                "Secure credential store unavailable. Unlock the OS credential store and retry; plaintext storage is not used."
                    .into(),
            ),
            Self::Missing => AppError::NotFound(
                "Saved credential is missing from the OS credential store. Set it again in Settings."
                    .into(),
            ),
        }
    }
}

pub trait CredentialStore {
    fn get(&self, reference: &CredentialRef) -> Result<String, StoreError>;
    fn set(&self, reference: &CredentialRef, secret: &str) -> Result<(), StoreError>;
    fn delete(&self, reference: &CredentialRef) -> Result<(), StoreError>;
}

#[cfg(not(test))]
struct NativeStore;

#[cfg(not(test))]
impl NativeStore {
    fn entry(reference: &CredentialRef) -> Result<keyring::Entry, StoreError> {
        if !reference.valid() {
            return Err(StoreError::Missing);
        }
        keyring::Entry::new("naiteh", &reference.0).map_err(|_| StoreError::Unavailable)
    }
}

#[cfg(not(test))]
impl CredentialStore for NativeStore {
    fn get(&self, reference: &CredentialRef) -> Result<String, StoreError> {
        Self::entry(reference)?.get_password().map_err(|e| match e {
            keyring::Error::NoEntry => StoreError::Missing,
            _ => StoreError::Unavailable,
        })
    }

    fn set(&self, reference: &CredentialRef, secret: &str) -> Result<(), StoreError> {
        Self::entry(reference)?
            .set_password(secret)
            .map_err(|_| StoreError::Unavailable)
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), StoreError> {
        match Self::entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(StoreError::Unavailable),
        }
    }
}

// Never let keyring's unsupported-platform mock become a production backend.
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!("naiteh requires an OS-native credential store on this platform");

pub(crate) fn with_store<T>(f: impl FnOnce(&dyn CredentialStore) -> T) -> T {
    #[cfg(not(test))]
    {
        f(&NativeStore)
    }
    #[cfg(test)]
    {
        TEST_STORE.with(|store| f(store))
    }
}

pub(crate) fn resolve(
    store: &dyn CredentialStore,
    reference: &CredentialRef,
) -> Result<String, AppError> {
    if !reference.valid() {
        return Err(StoreError::Missing.app_error());
    }
    store.get(reference).map_err(StoreError::app_error)
}

/// Fresh entries are staged before the JSON rename. On failure only staged
/// entries are deleted; existing references remain usable. Cleanup is best effort.
pub(crate) struct Transaction<'a> {
    store: &'a dyn CredentialStore,
    staged: Vec<CredentialRef>,
    committed: bool,
}

impl<'a> Transaction<'a> {
    pub(crate) fn new(store: &'a dyn CredentialStore) -> Self {
        Self {
            store,
            staged: Vec::new(),
            committed: false,
        }
    }

    pub(crate) fn stage(&mut self, secret: &str) -> Result<CredentialRef, AppError> {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).map_err(|_| StoreError::Unavailable.app_error())?;
        let reference = CredentialRef(format!(
            "v1-{}",
            bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
        ));
        // A failed native write may already have created the entry.
        self.staged.push(reference.clone());
        self.store
            .set(&reference, secret)
            .map_err(StoreError::app_error)?;
        Ok(reference)
    }

    pub(crate) fn check_reference(&self, reference: &CredentialRef) -> Result<(), AppError> {
        resolve(self.store, reference).map(|_| ())
    }

    pub(crate) fn finish(
        mut self,
        previous: &Value,
        next: &Value,
        commit: impl FnOnce() -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        commit()?;
        self.committed = true;
        let keep = references(next);
        for reference in references(previous).iter().chain(&self.staged) {
            if !keep.contains(reference) {
                let _ = self.store.delete(reference);
            }
        }
        Ok(())
    }
}

impl Drop for Transaction<'_> {
    fn drop(&mut self) {
        if !self.committed {
            for reference in &self.staged {
                let _ = self.store.delete(reference);
            }
        }
    }
}

fn references(value: &Value) -> BTreeSet<CredentialRef> {
    fn visit(value: &Value, out: &mut BTreeSet<CredentialRef>) {
        match value {
            Value::Array(a) => a.iter().for_each(|v| visit(v, out)),
            Value::Object(o) => {
                for (key, value) in o {
                    if matches!(key.as_str(), "apiKeyRef" | "passwordRef" | "passphraseRef") {
                        if let Ok(reference) =
                            serde_json::from_value::<CredentialRef>(value.clone())
                        {
                            if reference.valid() {
                                out.insert(reference);
                            }
                        }
                    } else {
                        visit(value, out);
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = BTreeSet::new();
    visit(value, &mut out);
    out
}

/// Parsing errors must not quote malformed secret values from JSON.
pub(crate) fn read_json<T: DeserializeOwned + Default>(
    path: &Path,
) -> Result<(Value, T), AppError> {
    let raw = match fsx::read_json::<Value>(path) {
        Ok(raw) => raw,
        Err(AppError::NotFound(_)) => Value::Object(Map::new()),
        Err(AppError::ConfigCorrupt(_)) => return Err(corrupt()),
        Err(e) => return Err(e),
    };
    let parsed = serde_json::from_value(raw.clone()).map_err(|_| corrupt())?;
    Ok((raw, parsed))
}

fn corrupt() -> AppError {
    AppError::ConfigCorrupt(
        "Invalid credential configuration JSON. Repair the file and retry.".into(),
    )
}

pub(crate) fn json(value: &impl Serialize) -> Result<Value, AppError> {
    serde_json::to_value(value)
        .map_err(|_| AppError::Io("Could not serialize credential configuration".into()))
}

/// Apply only changed typed fields, preserving untouched legacy secrets and
/// unknown fields. In particular, ordinary vault/settings writes need no keyring.
pub(crate) fn merge_changes(raw: &mut Value, before: &Value, after: &Value) {
    if before == after {
        return;
    }
    if let (Some(before), Some(after)) = (before.as_object(), after.as_object()) {
        if !raw.is_object() {
            *raw = Value::Object(Map::new());
        }
        let raw = raw.as_object_mut().unwrap();
        for key in before.keys().filter(|k| !after.contains_key(*k)) {
            raw.remove(key);
        }
        for (key, value) in after {
            if before.get(key) == Some(value) {
                continue;
            }
            merge_changes(
                raw.entry(key).or_insert(Value::Null),
                before.get(key).unwrap_or(&Value::Null),
                value,
            );
        }
    } else {
        *raw = after.clone();
    }
}

pub(crate) fn set_reference(
    object: &mut Map<String, Value>,
    field: &str,
    reference: Option<&CredentialRef>,
) -> Result<(), AppError> {
    match reference {
        Some(reference) => {
            object.insert(field.into(), json(reference)?);
        }
        None => {
            object.remove(field);
        }
    }
    Ok(())
}

/// Even clearing/replacing a legacy secret first requires a successful secure
/// write. Nothing in the old file changes until the transaction commits.
/// Superseded references need not resolve; retained references remain fail-closed.
pub(crate) fn migrate_slot(
    transaction: &mut Transaction<'_>,
    object: &mut Map<String, Value>,
    legacy: &str,
    reference: &str,
    trim: bool,
    superseded: bool,
) -> Result<usize, AppError> {
    let secret = object.get(legacy).and_then(Value::as_str);
    let secret = secret.map(|s| if trim { s.trim() } else { s });
    let mut count = 0;
    if let Some(secret) = secret.filter(|s| !s.is_empty()) {
        if let Some(existing) = object
            .get(reference)
            .filter(|v| !superseded && !v.is_null())
        {
            let existing = serde_json::from_value(existing.clone()).map_err(|_| corrupt())?;
            // A mixed legacy/reference file must not discard its only usable
            // copy when the referenced entry is missing, nor fall back to it.
            transaction.check_reference(&existing)?;
        }
        let staged = transaction.stage(secret)?;
        count = 1;
        if object.get(reference).is_none_or(Value::is_null) {
            set_reference(object, reference, Some(&staged))?;
        }
    }
    object.remove(legacy);
    Ok(count)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub ai_credentials: usize,
    pub sftp_credentials: usize,
}

/// Retryable and idempotent, with a separate atomic commit per JSON file. A
/// partial success is safe: retry skips the already migrated file/entries.
pub fn migrate_legacy(config_dir: &Path) -> Result<MigrationReport, AppError> {
    Ok(MigrationReport {
        ai_credentials: config::migrate_credentials(config_dir)?,
        sftp_credentials: backup::migrate_credentials(config_dir)?,
    })
}

/// Upstream error bodies may echo submitted API keys. Preserve the error kind,
/// but redact both literal and JSON-escaped forms before returning through IPC.
pub(crate) fn redact_error(error: AppError, secrets: &[&str]) -> AppError {
    let redact = |message| redact_text(message, secrets);
    match error {
        AppError::Io(s) => AppError::Io(redact(s)),
        AppError::NotFound(s) => AppError::NotFound(redact(s)),
        AppError::InvalidPath(s) => AppError::InvalidPath(redact(s)),
        AppError::AlreadyInitialized(s) => AppError::AlreadyInitialized(redact(s)),
        AppError::Conflict(s) => AppError::Conflict(redact(s)),
        AppError::ConfigCorrupt(s) => AppError::ConfigCorrupt(redact(s)),
        AppError::Unauthorized(s) => AppError::Unauthorized(redact(s)),
        AppError::Validation(s) => AppError::Validation(redact(s)),
        AppError::Network(s) => AppError::Network(redact(s)),
        AppError::Upstream(s) => AppError::Upstream(redact(s)),
        AppError::StaleWrite(s) => AppError::StaleWrite(redact(s)),
        AppError::Cancelled => AppError::Cancelled,
    }
}

pub(crate) fn redact_text(mut message: String, secrets: &[&str]) -> String {
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        message = message.replace(secret, "[redacted]");
        if let Ok(encoded) = serde_json::to_string(secret) {
            message = message.replace(&encoded[1..encoded.len() - 1], "[redacted]");
        }
    }
    message
}

#[cfg(test)]
thread_local! {
    static TEST_STORE: MemoryStore = MemoryStore::default();
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryStore {
    state: std::sync::Mutex<MemoryState>,
}

#[cfg(test)]
#[derive(Default)]
struct MemoryState {
    secrets: std::collections::BTreeMap<CredentialRef, String>,
    unavailable: bool,
    writes_until_failure: Option<usize>,
}

#[cfg(test)]
impl MemoryStore {
    pub(crate) fn unavailable(&self, unavailable: bool) {
        self.state.lock().unwrap().unavailable = unavailable;
    }

    pub(crate) fn fail_after_writes(&self, count: usize) {
        self.state.lock().unwrap().writes_until_failure = Some(count);
    }

    pub(crate) fn len(&self) -> usize {
        self.state.lock().unwrap().secrets.len()
    }
}

#[cfg(test)]
impl CredentialStore for MemoryStore {
    fn get(&self, reference: &CredentialRef) -> Result<String, StoreError> {
        let state = self.state.lock().unwrap();
        if state.unavailable {
            return Err(StoreError::Unavailable);
        }
        state
            .secrets
            .get(reference)
            .cloned()
            .ok_or(StoreError::Missing)
    }

    fn set(&self, reference: &CredentialRef, secret: &str) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        if state.unavailable || state.writes_until_failure == Some(0) {
            return Err(StoreError::Unavailable);
        }
        if let Some(count) = &mut state.writes_until_failure {
            *count -= 1;
        }
        state.secrets.insert(reference.clone(), secret.into());
        Ok(())
    }

    fn delete(&self, reference: &CredentialRef) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        if state.unavailable {
            return Err(StoreError::Unavailable);
        }
        state.secrets.remove(reference);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_json_commit_keeps_previous_references_and_cleans_staging() {
        let store = MemoryStore::default();
        let mut initial = Transaction::new(&store);
        let old = initial.stage("old-secret").unwrap();
        let previous = serde_json::json!({"apiKeyRef": old});
        initial.finish(&Value::Null, &previous, || Ok(())).unwrap();
        let mut update = Transaction::new(&store);
        let new = update.stage("new-secret").unwrap();
        assert_ne!(old, new);
        let next = serde_json::json!({"apiKeyRef": new});
        assert!(update
            .finish(&previous, &next, || Err(AppError::Io(
                "commit failed".into()
            )))
            .is_err());
        assert_eq!(resolve(&store, &old).unwrap(), "old-secret");
        assert!(resolve(&store, &new).is_err());
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn successful_commit_removes_superseded_and_unused_staged_entries() {
        let store = MemoryStore::default();
        let mut initial = Transaction::new(&store);
        let old = initial.stage("old").unwrap();
        let previous = serde_json::json!({"passwordRef": old});
        initial.finish(&Value::Null, &previous, || Ok(())).unwrap();
        let mut update = Transaction::new(&store);
        let new = update.stage("new").unwrap();
        update.stage("unused").unwrap();
        let next = serde_json::json!({"passwordRef": new});
        update.finish(&previous, &next, || Ok(())).unwrap();
        assert_eq!(store.len(), 1);
        assert_eq!(resolve(&store, &new).unwrap(), "new");
        assert!(resolve(&store, &old).is_err());
    }

    #[test]
    fn errors_and_debug_are_secret_free() {
        let secret = "key-\"secret\"";
        let encoded = serde_json::to_string(secret).unwrap();
        let error = redact_error(AppError::Upstream(format!("{secret} {encoded}")), &[secret]);
        let serialized = serde_json::to_string(&error).unwrap();
        assert!(!serialized.contains("key-"));
        assert!(matches!(error, AppError::Upstream(_)));
        let dir = tempfile::tempdir().unwrap();
        fsx::atomic_write(
            &dir.path().join("bad.json"),
            br#"{"apiKey":"secret", broken}"#,
        )
        .unwrap();
        let error = read_json::<Value>(&dir.path().join("bad.json")).unwrap_err();
        assert!(!format!("{error:?}").contains("secret"));
    }
}
