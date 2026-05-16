import { invoke } from "@tauri-apps/api/core";

import type { AuditLogEntry, AuthUser, LoginResult } from "../types";

/**
 * Authenticates and returns an opaque bearer token + session record.
 * The token must be passed to every subsequent auth IPC; the backend
 * resolves it against an in-memory session map.
 */
export function authLogin(
  username: string,
  password: string,
): Promise<LoginResult> {
  return invoke<LoginResult>("auth_login", { username, password });
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
