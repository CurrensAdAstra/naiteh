import type { AuditLogEntry, AuthAccess } from "../types";
import { invoke } from "./invoke";

export function authBootstrap(): Promise<AuthAccess> {
  return invoke<AuthAccess>("auth_bootstrap");
}

export function authUnlock(password: string): Promise<AuthAccess> {
  return invoke<AuthAccess>("auth_unlock", { password });
}

export function authMigrate(
  username: string,
  password: string,
  newPassword: string,
): Promise<AuthAccess> {
  return invoke<AuthAccess>("auth_migrate", { username, password, newPassword });
}

export function authSetLock(
  token: string,
  enabled: boolean,
  currentPassword: string | null,
  newPassword: string | null,
): Promise<AuthAccess> {
  return invoke<AuthAccess>("auth_set_lock", {
    token, enabled, currentPassword, newPassword,
  });
}

export function authLock(token: string): Promise<void> {
  return invoke<void>("auth_lock", { token });
}

export function authMigrateSecrets(token: string): Promise<void> {
  return invoke<void>("auth_migrate_secrets", { token });
}

export function authListAuditLogs(
  token: string,
  limit = 100,
): Promise<AuditLogEntry[]> {
  return invoke<AuditLogEntry[]>("auth_list_audit_logs", { token, limit });
}

/** Action names are backend-allowlisted; never use user input as an action. */
export function authLogAction(
  token: string,
  action: string,
  detail: string | null = null,
): Promise<void> {
  return invoke<void>("auth_log_action", { token, action, detail });
}
