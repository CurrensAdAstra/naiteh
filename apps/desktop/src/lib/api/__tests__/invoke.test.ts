import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import {
  hasTauriRuntime,
  invoke,
  isUnauthorizedError,
  setUnauthorizedHandler,
} from "../invoke";

const mockedTauriInvoke = vi.mocked(tauriInvoke);

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
}

describe("lib/api/invoke", () => {
  let unregister: () => void = () => {};
  const handler = vi.fn();

  beforeEach(() => {
    mockedTauriInvoke.mockReset();
    handler.mockReset();
    unregister = setUnauthorizedHandler(handler);
  });

  afterEach(() => {
    unregister();
  });

  it("passes the command and args through and returns the result", async () => {
    mockedTauriInvoke.mockResolvedValue(["a"]);
    await expect(invoke("tags_list", { x: 1 })).resolves.toEqual(["a"]);
    expect(mockedTauriInvoke).toHaveBeenCalledWith("tags_list", { x: 1 });
  });

  it("notifies the handler and rethrows when a gated command is refused", async () => {
    const err = { kind: "Unauthorized", message: "no active session" };
    mockedTauriInvoke.mockRejectedValue(err);
    await expect(invoke("notes_list")).rejects.toBe(err);
    await settle();
    expect(handler).toHaveBeenCalledWith("notes_list");
  });

  it("tolerates a lower-case kind", async () => {
    mockedTauriInvoke.mockRejectedValue({ kind: "unauthorized", message: "x" });
    await expect(invoke("sync_status")).rejects.toBeDefined();
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not treat a wrong password as a lost session", async () => {
    mockedTauriInvoke.mockRejectedValue({ kind: "Unauthorized", message: "bad password" });
    await expect(invoke("auth_unlock")).rejects.toBeDefined();
    await settle();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["auth_log_action", "auth_list_audit_logs", "auth_migrate_secrets", "auth_lock"])("treats an invalid session token on %s as lost access", async (command) => {
    mockedTauriInvoke.mockRejectedValue({ kind: "Unauthorized", message: "invalid session token" });
    await expect(invoke(command)).rejects.toBeDefined();
    await settle();
    expect(handler).toHaveBeenCalledWith(command);
  });

  it("ignores other error kinds", async () => {
    mockedTauriInvoke.mockRejectedValue({ kind: "NotFound", message: "x" });
    await expect(invoke("notes_read")).rejects.toBeDefined();
    await settle();
    expect(handler).not.toHaveBeenCalled();
  });

  it("isUnauthorizedError only matches the Unauthorized kind", () => {
    expect(isUnauthorizedError({ kind: "Unauthorized", message: "" })).toBe(true);
    expect(isUnauthorizedError({ kind: "Io", message: "" })).toBe(false);
    expect(isUnauthorizedError(new Error("Unauthorized"))).toBe(false);
  });

  it("hasTauriRuntime is false in plain jsdom (web fallbacks apply)", () => {
    expect(hasTauriRuntime()).toBe(false);
  });
});
