import type { AuditLogEntry, AuthUser, LoginResult, UserRole } from "../types";
import { hasTauriRuntime, invoke } from "./invoke";
import { notePasswordChangeRequired } from "./passwordChangeFlags";

/**
 * Authenticates and returns an opaque bearer token + session record.
 * The token must be passed to every subsequent auth IPC; the backend
 * resolves it against an in-memory session map. When `remember` is set,
 * the backend persists the session so `authResume` can restore it on the
 * next launch without a password.
 *
 * `mustChangePassword` on the result means the account has to set a new
 * password before it may use the app (see authStore).
 */
export async function authLogin(
  username: string,
  password: string,
  remember: boolean,
): Promise<LoginResult> {
  const result = await invoke<LoginResult>("auth_login", {
    username,
    password,
    remember,
  });
  notePasswordChangeRequired(result);
  return result;
}

/**
 * Attempts to restore a remembered session on startup. Resolves to the
 * session when one is valid, or `null` when there's nothing to resume
 * (no remembered session, expired, or the account was disabled). Also
 * `null` outside the desktop runtime, where there's no backend to ask.
 */
export async function authResume(): Promise<LoginResult | null> {
  if (!hasTauriRuntime()) return null;
  const result = await invoke<LoginResult | null>("auth_resume");
  if (result !== null) notePasswordChangeRequired(result);
  return result;
}

/** Revokes the token on the backend. Safe to call with stale tokens. */
export function authLogout(token: string): Promise<void> {
  return invoke<void>("auth_logout", { token });
}

/**
 * Change the signed-in user's own password. Backend rules: the new
 * password is at least 8 characters, differs from the current one, and
 * is not the username. Clears the session's must-change flag.
 */
export function authChangePassword(
  token: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  return invoke<void>("auth_change_password", {
    token,
    currentPassword,
    newPassword,
  });
}

/** Admin only. Returns the full user list after creation. */
export function authCreateUser(
  token: string,
  username: string,
  password: string,
  role: UserRole,
): Promise<AuthUser[]> {
  return invoke<AuthUser[]>("auth_create_user", {
    token,
    username,
    password,
    role,
  });
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

/**
 * Append a work event to the audit log. The backend only accepts a fixed
 * allowlist of action names (login/logout, vault_switch, evernote_import,
 * note/journal events…) — never pass user-provided text as `action`.
 */
export function authLogAction(
  token: string,
  action: string,
  detail: string | null = null,
): Promise<void> {
  return invoke<void>("auth_log_action", { token, action, detail });
}
