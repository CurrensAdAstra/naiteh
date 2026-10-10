//! In-memory session state: the backend **session gate** and the login
//! throttle. See vault/wiki/ipc-api.md ("Session gate").
//!
//!   - [`ActiveSession`] is the Tauri-managed record of who is signed in
//!     to *this* app instance. `auth_login` / `auth_resume` set it,
//!     `auth_logout` clears it, and every non-auth IPC command calls
//!     [`require_session`] as its first statement — so hiding the UI is
//!     no longer the only thing standing between a logged-out renderer
//!     and the vault. The frontend passes no token to gated commands.
//!   - [`LoginThrottle`] locks a username for [`LOCKOUT`] after
//!     [`MAX_FAILED_ATTEMPTS`] consecutive failed sign-ins.
//!   - [`SessionTimes`] is the shared expiry policy (idle + absolute) for
//!     both the active session and the bearer-token map in
//!     `services::auth::SessionStore`.

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use crate::domain::{AppError, AuthSession};

/// A session not used for this long expires.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(12 * 60 * 60);
/// A session expires this long after sign-in regardless of activity.
pub const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Consecutive failed sign-ins (per username) before a lockout.
pub const MAX_FAILED_ATTEMPTS: u32 = 5;
/// How long a username stays locked after too many failures.
pub const LOCKOUT: Duration = Duration::from_secs(5 * 60);
/// Soft cap on throttle entries so a flood of distinct usernames can't
/// grow the map without bound; unlocked entries are dropped past it.
const THROTTLE_MAX_ENTRIES: usize = 1024;

// ── expiry policy ────────────────────────────────────────────────────

/// Creation + last-use instants for a session, with the shared expiry
/// rule (idle [`IDLE_TIMEOUT`] / absolute [`ABSOLUTE_TIMEOUT`]).
#[derive(Debug, Clone, Copy)]
pub struct SessionTimes {
    created: Instant,
    last_seen: Instant,
}

impl SessionTimes {
    pub fn new(now: Instant) -> Self {
        Self {
            created: now,
            last_seen: now,
        }
    }

    pub fn is_expired(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.created) >= ABSOLUTE_TIMEOUT
            || now.saturating_duration_since(self.last_seen) >= IDLE_TIMEOUT
    }

    pub fn touch(&mut self, now: Instant) {
        if now > self.last_seen {
            self.last_seen = now;
        }
    }
}

// ── ActiveSession (the gate) ─────────────────────────────────────────

#[derive(Debug, Clone)]
struct ActiveEntry {
    token: String,
    session: AuthSession,
    times: SessionTimes,
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

    /// Mark `session` (holding `token`) as the signed-in user.
    pub fn set(&self, token: &str, session: AuthSession) {
        self.set_at(token, session, Instant::now());
    }

    pub fn set_at(&self, token: &str, session: AuthSession, now: Instant) {
        *self.lock() = Some(ActiveEntry {
            token: token.to_string(),
            session,
            times: SessionTimes::new(now),
        });
    }

    /// Close the gate unconditionally (a new login that may not use the
    /// app yet replaces whoever was signed in before).
    pub fn clear(&self) {
        *self.lock() = None;
    }

    /// Sign out — but only if `token` is the active one, so a stale
    /// token from elsewhere can't end the current user's session.
    pub fn clear_if(&self, token: &str) {
        let mut guard = self.lock();
        if guard.as_ref().is_some_and(|e| e.token == token) {
            *guard = None;
        }
    }

    /// The signed-in session, or `Unauthorized`. Expired sessions are
    /// cleared; a live one has its idle timer refreshed.
    pub fn require(&self) -> Result<AuthSession, AppError> {
        self.require_at(Instant::now())
    }

    pub fn require_at(&self, now: Instant) -> Result<AuthSession, AppError> {
        let mut guard = self.lock();
        match guard.as_mut() {
            None => Err(AppError::Unauthorized("not signed in".into())),
            Some(entry) if entry.times.is_expired(now) => {
                *guard = None;
                Err(AppError::Unauthorized(
                    "session expired; sign in again".into(),
                ))
            }
            Some(entry) => {
                entry.times.touch(now);
                Ok(entry.session.clone())
            }
        }
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
    use crate::domain::UserRole;

    fn sess(name: &str) -> AuthSession {
        AuthSession {
            username: name.into(),
            role: UserRole::User,
        }
    }

    #[test]
    fn gate_rejects_when_no_one_is_signed_in() {
        let active = ActiveSession::default();
        let err = require_session(&active).unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)), "got {err:?}");
    }

    #[test]
    fn gate_accepts_after_set_and_rejects_after_clear() {
        let active = ActiveSession::default();
        active.set("tok", sess("alice"));
        assert_eq!(require_session(&active).unwrap().username, "alice");
        active.clear_if("other-token");
        assert!(
            require_session(&active).is_ok(),
            "foreign token must not log out"
        );
        active.clear_if("tok");
        assert!(require_session(&active).is_err());
    }

    #[test]
    fn gate_expires_after_idle_timeout() {
        let active = ActiveSession::default();
        let t0 = Instant::now();
        active.set_at("tok", sess("alice"), t0);
        // Activity within the idle window keeps it alive…
        let t1 = t0 + IDLE_TIMEOUT - Duration::from_secs(60);
        assert!(active.require_at(t1).is_ok());
        let t2 = t1 + IDLE_TIMEOUT - Duration::from_secs(60);
        assert!(active.require_at(t2).is_ok());
        // …but a full idle period expires it, and it stays cleared.
        let t3 = t2 + IDLE_TIMEOUT;
        assert!(active.require_at(t3).is_err());
        assert!(active.require_at(t2).is_err());
    }

    #[test]
    fn gate_expires_at_absolute_timeout_even_when_active() {
        let active = ActiveSession::default();
        let t0 = Instant::now();
        active.set_at("tok", sess("alice"), t0);
        let mut t = t0;
        while t < t0 + ABSOLUTE_TIMEOUT - IDLE_TIMEOUT {
            t += IDLE_TIMEOUT / 2;
            assert!(active.require_at(t).is_ok());
        }
        assert!(active.require_at(t0 + ABSOLUTE_TIMEOUT).is_err());
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
