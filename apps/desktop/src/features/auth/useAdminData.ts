import { useCallback, useEffect, useState } from "react";

import {
  authCreateUser,
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../lib/api/auth";
import {
  formatAppError,
  type AuditLogEntry,
  type AuthUser,
  type UserRole,
} from "../../lib/types";

const AUDIT_LIMIT = 100;

export interface AdminData {
  users: AuthUser[];
  logs: AuditLogEntry[];
  /** Load / toggle failure (create errors reject to the form instead). */
  error: string | null;
  busy: boolean;
  refresh: () => Promise<void>;
  toggleUser: (user: AuthUser) => Promise<void>;
  /** Rejects with the AppError so the form can show it inline. */
  createUser: (username: string, password: string, role: UserRole) => Promise<void>;
}

/**
 * Users + audit log for the admin views (Settings ▸ Accounts / Audit Log
 * and the /admin dashboard). Inert when `token` is null (not an admin).
 */
export function useAdminData(token: string | null): AdminData {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (token === null) {
      setUsers([]);
      setLogs([]);
      return;
    }
    try {
      const [nextUsers, nextLogs] = await Promise.all([
        authListUsers(token),
        authListAuditLogs(token, AUDIT_LIMIT),
      ]);
      setUsers(nextUsers);
      setLogs(nextLogs);
      setError(null);
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshLogs = useCallback(async () => {
    if (token === null) return;
    try {
      setLogs(await authListAuditLogs(token, AUDIT_LIMIT));
    } catch (e) {
      setError(formatAppError(e));
    }
  }, [token]);

  const toggleUser = useCallback(
    async (user: AuthUser) => {
      if (token === null) return;
      setBusy(true);
      setError(null);
      try {
        setUsers(await authSetUserActive(token, user.username, !user.active));
        await refreshLogs();
      } catch (e) {
        setError(formatAppError(e));
      } finally {
        setBusy(false);
      }
    },
    [token, refreshLogs],
  );

  const createUser = useCallback(
    async (username: string, password: string, role: UserRole) => {
      if (token === null) {
        throw { kind: "Unauthorized", message: "Not signed in as an admin." };
      }
      setBusy(true);
      try {
        setUsers(await authCreateUser(token, username, password, role));
      } finally {
        setBusy(false);
      }
      await refreshLogs();
    },
    [token, refreshLogs],
  );

  return { users, logs, error, busy, refresh, toggleUser, createUser };
}
