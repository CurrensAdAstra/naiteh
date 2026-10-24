import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { authBootstrap, authListAuditLogs, authLock, authLogAction, authMigrate, authMigrateSecrets, authSetLock, authUnlock } from "../auth";

describe("local access IPC contract", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("uses the exact new command names and camelCase arguments", async () => {
    await authBootstrap();
    await authUnlock("password");
    await authMigrate("legacy", "old", "new-password");
    await authSetLock("token", true, null, "new-password");
    await authSetLock("token", false, "new-password", null);
    await authLock("token");
    await authMigrateSecrets("token");
    await authListAuditLogs("token", 25);
    await authLogAction("token", "note_open", "notes/a.md");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["auth_bootstrap", undefined],
      ["auth_unlock", { password: "password" }],
      ["auth_migrate", { username: "legacy", password: "old", newPassword: "new-password" }],
      ["auth_set_lock", { token: "token", enabled: true, currentPassword: null, newPassword: "new-password" }],
      ["auth_set_lock", { token: "token", enabled: false, currentPassword: "new-password", newPassword: null }],
      ["auth_lock", { token: "token" }],
      ["auth_migrate_secrets", { token: "token" }],
      ["auth_list_audit_logs", { token: "token", limit: 25 }],
      ["auth_log_action", { token: "token", action: "note_open", detail: "notes/a.md" }],
    ]);
  });
});
