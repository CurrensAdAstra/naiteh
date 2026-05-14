import { invoke } from "@tauri-apps/api/core";

import type { AuditLogEntry, AuthSession, AuthUser } from "../types";

const WEB_USERS_KEY = "naiteh.webAuth.users";
const WEB_AUDIT_KEY = "naiteh.webAuth.audit";

const SEEDED_USERS: AuthUser[] = [
  { username: "admin", role: "Admin", active: true },
  { username: "mgkyung", role: "User", active: true },
];

function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return true;
  const maybeWindow = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

function webUsers(): AuthUser[] {
  if (typeof localStorage === "undefined") return SEEDED_USERS;
  const raw = localStorage.getItem(WEB_USERS_KEY);
  if (raw === null) {
    localStorage.setItem(WEB_USERS_KEY, JSON.stringify(SEEDED_USERS));
    return SEEDED_USERS;
  }
  try {
    const parsed = JSON.parse(raw) as AuthUser[];
    const merged = [...parsed];
    for (const seeded of SEEDED_USERS) {
      if (!merged.some((user) => user.username === seeded.username)) {
        merged.push(seeded);
      }
    }
    return merged;
  } catch {
    localStorage.setItem(WEB_USERS_KEY, JSON.stringify(SEEDED_USERS));
    return SEEDED_USERS;
  }
}

function saveWebUsers(users: AuthUser[]) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(WEB_USERS_KEY, JSON.stringify(users));
}

function webAuditLogs(): AuditLogEntry[] {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(WEB_AUDIT_KEY);
  if (raw === null) return [];
  try {
    return JSON.parse(raw) as AuditLogEntry[];
  } catch {
    return [];
  }
}

function appendWebAudit(
  username: string,
  action: string,
  detail: string | null,
) {
  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    username: username.trim().toLowerCase(),
    action,
    detail,
  };
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(
    WEB_AUDIT_KEY,
    JSON.stringify([entry, ...webAuditLogs()].slice(0, 500)),
  );
}

function webUnauthorized(message: string): never {
  throw { kind: "Unauthorized", message };
}

function requireWebAdmin(actor: string) {
  const admin = webUsers().find(
    (user) => user.username === actor.trim().toLowerCase(),
  );
  if (admin?.role !== "Admin" || !admin.active) {
    webUnauthorized("admin account required");
  }
}

export function authLogin(
  username: string,
  password: string,
): Promise<AuthSession> {
  if (!hasTauriRuntime()) {
    const canonical = username.trim().toLowerCase();
    const user = webUsers().find((candidate) => candidate.username === canonical);
    if (user === undefined || password !== canonical) {
      appendWebAudit(canonical, "login_failure", "invalid username or password");
      return Promise.reject({
        kind: "Unauthorized",
        message: "invalid username or password",
      });
    }
    if (!user.active) {
      appendWebAudit(canonical, "login_failure", "account is disabled");
      return Promise.reject({
        kind: "Unauthorized",
        message: "account is disabled",
      });
    }
    appendWebAudit(canonical, "login_success", null);
    return Promise.resolve({ username: user.username, role: user.role });
  }
  return invoke<AuthSession>("auth_login", { username, password });
}

export function authListUsers(actor: string): Promise<AuthUser[]> {
  if (!hasTauriRuntime()) {
    requireWebAdmin(actor);
    return Promise.resolve(webUsers());
  }
  return invoke<AuthUser[]>("auth_list_users", { actor });
}

export function authSetUserActive(
  actor: string,
  username: string,
  active: boolean,
): Promise<AuthUser[]> {
  if (!hasTauriRuntime()) {
    requireWebAdmin(actor);
    const canonical = username.trim().toLowerCase();
    if (canonical === "admin" && !active) {
      return Promise.reject({
        kind: "Conflict",
        message: "admin account cannot be disabled",
      });
    }
    const users = webUsers().map((user) =>
      user.username === canonical ? { ...user, active } : user,
    );
    saveWebUsers(users);
    appendWebAudit(
      actor,
      active ? "user_enabled" : "user_disabled",
      canonical,
    );
    return Promise.resolve(users);
  }
  return invoke<AuthUser[]>("auth_set_user_active", {
    actor,
    username,
    active,
  });
}

export function authListAuditLogs(
  actor: string,
  limit = 100,
): Promise<AuditLogEntry[]> {
  if (!hasTauriRuntime()) {
    requireWebAdmin(actor);
    return Promise.resolve(webAuditLogs().slice(0, Math.max(1, limit)));
  }
  return invoke<AuditLogEntry[]>("auth_list_audit_logs", { actor, limit });
}

export function authLogAction(
  username: string,
  action: string,
  detail: string | null = null,
): Promise<void> {
  if (!hasTauriRuntime()) {
    appendWebAudit(username, action, detail);
    return Promise.resolve();
  }
  return invoke<void>("auth_log_action", { username, action, detail });
}
