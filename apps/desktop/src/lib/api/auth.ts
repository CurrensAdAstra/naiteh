import { invoke } from "@tauri-apps/api/core";

import type { AuditLogEntry, AuthUser, LoginResult } from "../types";

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return true;
  const maybeWindow = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

/**
 * Authenticates and returns an opaque bearer token + session record.
 * The token must be passed to every subsequent auth IPC; the backend
 * resolves it against an in-memory session map. When `remember` is set,
 * the backend persists the session so `authResume` can restore it on the
 * next launch without a password.
 */
export function authLogin(
  username: string,
  password: string,
  remember: boolean,
): Promise<LoginResult> {
  return invoke<LoginResult>("auth_login", { username, password, remember });
}

/**
 * Attempts to restore a remembered session on startup. Resolves to the
 * session when one is valid, or `null` when there's nothing to resume
 * (no remembered session, expired, or the account was disabled). Also
 * `null` outside the desktop runtime, where there's no backend to ask.
 */
export function authResume(): Promise<LoginResult | null> {
  if (!hasTauriRuntime()) return Promise.resolve(null);
  return invoke<LoginResult | null>("auth_resume");
}

/** Revokes the token on the backend. Safe to call with stale tokens. */
export function authLogout(token: string): Promise<void> {
  return invoke<void>("auth_logout", { token });
}

export function authListUsers(token: string): Promise<AuthUser[]> {
  return invoke<AuthUser[]>("auth_list_users", { token });
}

export function authSetUserActive(
  token: string,
  username: string,
  active: boolean,
): Promise<AuthUser[]> {
  return invoke<AuthUser[]>("auth_set_user_active", {
    token,
    username,
    active,
  });
}

export function authListAuditLogs(
  token: string,
  limit = 100,
): Promise<AuditLogEntry[]> {
  return invoke<AuditLogEntry[]>("auth_list_audit_logs", { token, limit });
}

export function authLogAction(
  token: string,
  action: string,
  detail: string | null = null,
): Promise<void> {
  return invoke<void>("auth_log_action", { token, action, detail });
}
