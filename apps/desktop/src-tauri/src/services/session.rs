//! Backend app-access gate and password-attempt throttle. Access is local,
//! memory-only and ends on manual lock or process exit, not a hidden timer.
//! See vault/wiki/ipc-api.md ("Session gate").

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use crate::domain::{AppError, AuthSession, LoginResult, UserRole};

/// Consecutive failed sign-ins (per username) before a lockout.
pub const MAX_FAILED_ATTEMPTS: u32 = 5;
/// How long a username stays locked after too many failures.
pub const LOCKOUT: Duration = Duration::from_secs(5 * 60);
/// Soft cap on throttle entries so a flood of distinct usernames can't
/// grow the map without bound; unlocked entries are dropped past it.
const THROTTLE_MAX_ENTRIES: usize = 1024;

// ── ActiveSession (the gate) ─────────────────────────────────────────

#[derive(Debug, Clone)]
struct ActiveEntry {
    token: String,
    session: AuthSession,
}

/// Who is signed in to this app instance. `None` = logged out; every
/// gated command then fails with `AppError::Unauthorized`.
#[derive(Default)]
pub struct ActiveSession {
    inner: StdMutex<Option<ActiveEntry>>,
}

impl ActiveSession {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ActiveEntry>> {
        // A poisoned lock only means another thread panicked mid-update
        // of a plain Option; the data is still coherent.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Return the existing access rather than rotating a token on repeated
    /// bootstrap calls (including React StrictMode startup).
    pub fn current(&self) -> Option<LoginResult> {
        self.lock().as_ref().map(Self::result)
    }

    pub fn open_local(&self) -> Result<LoginResult, AppError> {
        let mut guard = self.lock();
        if let Some(entry) = guard.as_ref() {
            return Ok(Self::result(entry));
        }
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|_| AppError::Io("Cannot create app access token".into()))?;
        let entry = ActiveEntry {
            token: bytes.iter().map(|b| format!("{b:02x}")).collect(),
            session: AuthSession {
                username: "local".into(),
                role: UserRole::Admin,
            },
        };
        let result = Self::result(&entry);
        *guard = Some(entry);
        Ok(result)
    }

    fn result(entry: &ActiveEntry) -> LoginResult {
        LoginResult {
            token: entry.token.clone(),
            session: entry.session.clone(),
            must_change_password: false,
        }
    }

    pub fn clear(&self) {
        *self.lock() = None;
    }

    pub fn close(&self, token: &str) -> Result<(), AppError> {
        let mut guard = self.lock();
        if !guard.as_ref().is_some_and(|e| e.token == token) {
            return Err(AppError::Unauthorized("App access ended".into()));
        }
        *guard = None;
        Ok(())
    }

    pub fn is_signed_in(&self) -> bool {
        self.lock().is_some()
    }

    pub fn require(&self) -> Result<AuthSession, AppError> {
        self.lock()
            .as_ref()
            .map(|e| e.session.clone())
            .ok_or_else(|| AppError::Unauthorized("App is locked".into()))
    }

    pub fn require_token(&self, token: &str) -> Result<AuthSession, AppError> {
        self.lock()
            .as_ref()
            .filter(|e| e.token == token)
            .map(|e| e.session.clone())
            .ok_or_else(|| AppError::Unauthorized("App access ended".into()))
    }
}

/// The session gate. Every non-auth IPC command calls this **first**
/// (`require_session(&active)?;`); a unit test in `lib.rs` enforces that
/// for every registered command.
pub fn require_session(active: &ActiveSession) -> Result<AuthSession, AppError> {
    active.require()
}

// ── LoginThrottle ────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
struct Attempts {
    failures: u32,
    locked_until: Option<Instant>,
}

/// Per-username failed-login counter with a temporary lockout. Keyed by
/// the canonical (trimmed, lowercased) username whether or not the
/// account exists, so lockout behaviour doesn't reveal which names are
/// real.
#[derive(Default)]
pub struct LoginThrottle {
    inner: StdMutex<HashMap<String, Attempts>>,
}

impl LoginThrottle {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Attempts>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reserve one sign-in attempt for `username`. Fails (generic
    /// message + retry-after seconds) while the name is locked.
    ///
    /// The attempt is counted *before* the password is checked, so
    /// parallel guesses can't race past the limit; [`Self::succeed`]
    /// wipes the counter. The attempt that reaches the limit arms the
    /// lock — if that very attempt succeeds, the lock is lifted again.
    pub fn begin_attempt(&self, username: &str, now: Instant) -> Result<(), AppError> {
        let mut map = self.lock();
        if map.len() > THROTTLE_MAX_ENTRIES {
            map.retain(|_, a| a.locked_until.is_some_and(|t| t > now));
        }
        let entry = map.entry(username.to_string()).or_default();
        if let Some(until) = entry.locked_until {
            if until > now {
                let secs = until.saturating_duration_since(now).as_secs().max(1);
                return Err(AppError::Unauthorized(format!(
                    "too many failed sign-in attempts; try again in {secs} seconds"
                )));
            }
            entry.locked_until = None;
        }
        entry.failures += 1;
        if entry.failures >= MAX_FAILED_ATTEMPTS {
            entry.failures = 0;
            entry.locked_until = Some(now + LOCKOUT);
        }
        Ok(())
    }

    /// A successful sign-in clears the username's counter and lock.
    pub fn succeed(&self, username: &str) {
        self.lock().remove(username);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gate_rejects_when_no_one_is_signed_in() {
        let active = ActiveSession::default();
        let err = require_session(&active).unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    }

    #[test]
    fn gate_accepts_after_set_and_rejects_after_clear() {
        let active = ActiveSession::default();
        let login = active.open_local().unwrap();
        assert_eq!(require_session(&active).unwrap().username, "local");
        assert!(active.close("other-token").is_err());
        assert!(
            require_session(&active).is_ok(),
            "foreign token must not log out"
        );
        active.close(&login.token).unwrap();
        assert!(require_session(&active).is_err());
    }

    #[test]
    fn repeated_bootstrap_retains_token_but_lock_invalidates_it() {
        let active = ActiveSession::default();
        let first = active.open_local().unwrap();
        assert_eq!(first, active.open_local().unwrap());
        active.close(&first.token).unwrap();
        assert!(active.require_token(&first.token).is_err());
        let next = active.open_local().unwrap();
        assert_ne!(first.token, next.token);
        assert!(active.require_token(&first.token).is_err());
        assert!(active.require_token(&next.token).is_ok());
    }

    #[test]
    fn throttle_locks_after_five_failures_and_unlocks_after_lockout() {
        let throttle = LoginThrottle::default();
        let t0 = Instant::now();
        for _ in 0..MAX_FAILED_ATTEMPTS {
            throttle.begin_attempt("bob", t0).unwrap();
        }
        let err = throttle.begin_attempt("bob", t0).unwrap_err();
        match err {
            AppError::Unauthorized(msg) => assert!(msg.contains("try again in"), "{msg}"),
            other => panic!("expected Unauthorized, got {other:?}"),
        }
        // Other usernames are unaffected.
        throttle.begin_attempt("carol", t0).unwrap();
        // After the lockout window, attempts are allowed again.
        throttle.begin_attempt("bob", t0 + LOCKOUT).unwrap();
    }

    #[test]
    fn throttle_success_resets_the_counter() {
        let throttle = LoginThrottle::default();
        let t0 = Instant::now();
        for _ in 0..MAX_FAILED_ATTEMPTS - 1 {
            throttle.begin_attempt("bob", t0).unwrap();
        }
        throttle.succeed("bob");
        for _ in 0..MAX_FAILED_ATTEMPTS {
            throttle.begin_attempt("bob", t0).unwrap();
        }
        assert!(throttle.begin_attempt("bob", t0).is_err());
    }
}
