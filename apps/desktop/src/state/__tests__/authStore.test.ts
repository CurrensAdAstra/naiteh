import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/api/auth", () => ({
  authBootstrap: vi.fn(), authUnlock: vi.fn(), authMigrate: vi.fn(),
  authSetLock: vi.fn(), authLock: vi.fn(), authLogAction: vi.fn(),
}));
vi.mock("../../lib/api/notes", () => ({ notesWrite: vi.fn() }));
vi.mock("../../lib/api/journal", () => ({ journalSave: vi.fn() }));
vi.mock("../../lib/api/vault", () => ({ vaultCurrent: vi.fn(), vaultSetActive: vi.fn() }));

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  authBootstrap, authLock, authLogAction, authMigrate, authSetLock, authUnlock,
} from "../../lib/api/auth";
import { invoke } from "../../lib/api/invoke";
import { notesWrite } from "../../lib/api/notes";
import { journalSave } from "../../lib/api/journal";
import { vaultCurrent, vaultSetActive } from "../../lib/api/vault";
import type { AuthAccess } from "../../lib/types";
import { ACCESS_ENDED_MESSAGE, handleUnauthorized, useAuthStore } from "../authStore";
import { flushPendingSave, hasPendingSave, holdSave, isSaveHeld, resetAutosaveForTests, scheduleSave } from "../autosave";
import { beginOpen, isLatestOpen, useEditorStore } from "../editorStore";
import { useVaultStore } from "../vaultStore";

const LOCAL = { username: "local", role: "Admin" as const };
const LOGIN = { token: "local-token", session: LOCAL, mustChangePassword: false };
const OPEN: AuthAccess = { lockEnabled: false, migrationRequired: false, login: LOGIN };
const UNLOCKED: AuthAccess = { ...OPEN, lockEnabled: true };
const LOCKED: AuthAccess = { ...UNLOCKED, login: null };
const LEGACY: AuthAccess = { lockEnabled: false, migrationRequired: true, login: null };
const WRITE = { meta: { path: "", relPath: "", title: "", tags: [], mtime: 0, size: 0, pinned: false }, version: "v2" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function signedIn(lockEnabled = true) {
  useAuthStore.setState({ token: LOGIN.token, session: LOCAL, lockEnabled, ready: true });
}

function edit(path = "notes/private.md", content = "unsaved private edits") {
  useEditorStore.getState().openNote(path, "original", "v1");
  useEditorStore.getState().setContent(content);
  scheduleSave({ kind: "note", relPath: path }, content);
}

beforeEach(() => {
  vi.resetAllMocks();
  resetAutosaveForTests();
  useAuthStore.setState({ token: null, session: null, lockEnabled: null, migrationRequired: false, ready: false, busy: null, error: null, accessNotice: null, draftRecovery: null });
  useEditorStore.setState({ open: null, view: null, saveError: null, externalChange: null });
  useVaultStore.setState({ active: { root: "/vault", name: "vault", initialized: true } });
  vi.mocked(notesWrite).mockResolvedValue(WRITE);
  vi.mocked(authLock).mockResolvedValue(undefined);
  vi.mocked(vaultCurrent).mockImplementation(async () => useVaultStore.getState().active);
  vi.mocked(journalSave).mockResolvedValue({ path: "", mtime: 0, version: "v2" });
});

afterEach(() => {
  resetAutosaveForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("local access bootstrap", () => {
  it.each([OPEN, LOCKED, LEGACY])("uses the backend's access state: %j", async (access) => {
    vi.mocked(authBootstrap).mockResolvedValue(access);
    expect(await useAuthStore.getState().bootstrap()).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({ ready: true, busy: null, error: null, lockEnabled: access.lockEnabled, migrationRequired: access.migrationRequired, session: access.login?.session ?? null });
  });

  it("deduplicates bootstrap, including StrictMode remounts", async () => {
    const pending = deferred<AuthAccess>();
    vi.mocked(authBootstrap).mockReturnValue(pending.promise);
    const first = useAuthStore.getState().bootstrap();
    const second = useAuthStore.getState().bootstrap();
    expect(first).toBe(second);
    expect(authBootstrap).toHaveBeenCalledTimes(1);
    pending.resolve(OPEN);
    await first;
    await useAuthStore.getState().bootstrap();
    expect(authBootstrap).toHaveBeenCalledTimes(1);
  });

  it("keeps access unknown on errors and allows an explicit retry", async () => {
    vi.mocked(authBootstrap).mockRejectedValueOnce(new Error("keyring unavailable")).mockResolvedValueOnce(OPEN);
    expect(await useAuthStore.getState().bootstrap()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ ready: false, lockEnabled: null, session: null, error: "keyring unavailable" });
    expect(await useAuthStore.getState().bootstrap()).toBe(true);
  });

  it.each([null, undefined, {}, { ...OPEN, login: null }, { ...OPEN, login: { ...LOGIN, mustChangePassword: true } }])("does not infer disabled access from a malformed response: %j", async (response) => {
    vi.mocked(authBootstrap).mockResolvedValue(response as AuthAccess);
    expect(await useAuthStore.getState().bootstrap()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session: null, lockEnabled: null, ready: false });
    expect(useAuthStore.getState().error).toMatch(/Invalid app access response/);
  });
});

describe("unlock, migration, and lock configuration", () => {
  it("unlocks with a password only, showing failures without granting access", async () => {
    useAuthStore.setState({ ready: true, lockEnabled: true });
    vi.mocked(authUnlock).mockRejectedValueOnce({ kind: "Unauthorized", message: "Incorrect password" }).mockResolvedValueOnce(UNLOCKED);
    expect(await useAuthStore.getState().unlock("wrong")).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().error).toBe("Incorrect password");
    expect(await useAuthStore.getState().unlock("password-only")).toBe(true);
    expect(authUnlock).toHaveBeenLastCalledWith("password-only");
    expect(useAuthStore.getState().session).toEqual(LOCAL);
  });

  it("explicitly converts the verified legacy credentials to a new app lock", async () => {
    useAuthStore.setState({ ready: true, migrationRequired: true, lockEnabled: false });
    vi.mocked(authMigrate).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().migrate("old-user", "old-pass", "new-lock-pass")).toBe(true);
    expect(authMigrate).toHaveBeenCalledWith("old-user", "old-pass", "new-lock-pass");
    expect(useAuthStore.getState()).toMatchObject({ migrationRequired: false, lockEnabled: true, session: LOCAL });
  });

  it("requires successful configuration before updating enabled state", async () => {
    signedIn(false);
    vi.mocked(authSetLock).mockRejectedValueOnce(new Error("cannot persist lock")).mockResolvedValueOnce(UNLOCKED).mockResolvedValueOnce(OPEN);
    expect(await useAuthStore.getState().setLock(true, null, "new-password")).toBe(false);
    expect(useAuthStore.getState().lockEnabled).toBe(false);
    expect(await useAuthStore.getState().setLock(true, null, "new-password")).toBe(true);
    expect(await useAuthStore.getState().setLock(false, "new-password", null)).toBe(true);
    expect(authSetLock).toHaveBeenLastCalledWith(LOGIN.token, false, "new-password", null);
    expect(useAuthStore.getState()).toMatchObject({ session: LOCAL, lockEnabled: false });
  });

  it("keeps logging centralized and does nothing without active access", async () => {
    await useAuthStore.getState().logAction("note_open", "notes/a.md");
    expect(authLogAction).not.toHaveBeenCalled();
    signedIn();
    await useAuthStore.getState().logAction("note_open", "notes/a.md");
    expect(authLogAction).toHaveBeenCalledWith(LOGIN.token, "note_open", "notes/a.md");
  });

  it("does not apply a stale configuration response after access loss", async () => {
    signedIn();
    const pending = deferred<AuthAccess>();
    vi.mocked(authSetLock).mockReturnValue(pending.promise);
    const configuring = useAuthStore.getState().setLock(false, "pass", null);
    handleUnauthorized();
    pending.resolve(OPEN);
    expect(await configuring).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session: null, lockEnabled: true });
  });
});

describe("voluntary app lock", () => {
  beforeEach(() => signedIn());

  it("flushes edits and keeps the shell session until the backend acknowledges", async () => {
    edit();
    const pendingOpen = beginOpen();
    const ack = deferred<void>();
    vi.mocked(authLock).mockImplementation(() => {
      expect(notesWrite).toHaveBeenCalledWith("notes/private.md", "unsaved private edits", "v1", "/vault");
      return ack.promise;
    });
    const first = useAuthStore.getState().lock();
    const second = useAuthStore.getState().lock();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(authLock).toHaveBeenCalledTimes(1));
    expect(useAuthStore.getState()).toMatchObject({ session: LOCAL, busy: "lock" });
    expect(useEditorStore.getState().open?.content).toBe("unsaved private edits");
    expect(isLatestOpen(pendingOpen)).toBe(false);
    ack.resolve();
    expect(await first).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({ token: null, session: null, busy: null });
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("does not lock when the lock is disabled", async () => {
    useAuthStore.setState({ lockEnabled: false });
    expect(await useAuthStore.getState().lock()).toBe(false);
    expect(authLock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().session).toEqual(LOCAL);
  });

  it.each([false, true])("refuses to lock after a failed save (held: %s)", async (held) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    edit();
    if (held) holdSave("note:notes/private.md");
    vi.mocked(notesWrite).mockRejectedValue(new Error("disk full"));
    expect(await useAuthStore.getState().lock()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session: LOCAL, busy: null });
    expect(useAuthStore.getState().error).toMatch(/Not locked/);
    expect(useEditorStore.getState().open?.content).toBe("unsaved private edits");
    expect(hasPendingSave()).toBe(true);
    expect(authLock).not.toHaveBeenCalled();
    if (held) expect(isSaveHeld("note:notes/private.md")).toBe(true);
  });

  it("refuses a failed queued save even when it is not the open document", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    scheduleSave({ kind: "note", relPath: "notes/earlier.md" }, "earlier draft");
    useEditorStore.getState().openNote("notes/clean.md", "clean", "v1");
    vi.mocked(notesWrite).mockRejectedValue(new Error("read-only"));
    expect(await useAuthStore.getState().lock()).toBe(false);
    expect(authLock).not.toHaveBeenCalled();
    expect(hasPendingSave()).toBe(true);
  });

  it("preserves held edits as a local copy before acknowledged lock", async () => {
    edit();
    holdSave("note:notes/private.md");
    expect(await useAuthStore.getState().lock()).toBe(true);
    expect(notesWrite).toHaveBeenCalledWith(expect.stringMatching(/notes\/private\.local-/), "unsaved private edits", null, "/vault");
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("keeps the session and editor visible on backend lock failure", async () => {
    edit();
    vi.mocked(authLock).mockRejectedValue(new Error("backend unavailable"));
    expect(await useAuthStore.getState().lock()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session: LOCAL, token: LOGIN.token, error: "backend unavailable", busy: null });
    expect(useEditorStore.getState().open?.content).toBe("unsaved private edits");
  });

  it("retains a late async edit arriving during backend acknowledgement", async () => {
    edit();
    const ack = deferred<void>();
    vi.mocked(authLock).mockReturnValue(ack.promise);
    const locking = useAuthStore.getState().lock();
    await vi.waitFor(() => expect(authLock).toHaveBeenCalled());
    useEditorStore.getState().setContent("late edit");
    ack.resolve();
    expect(await locking).toBe(true);
    expect(useEditorStore.getState().open?.content).toBe("late edit");
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    await useAuthStore.getState().unlock("password");
    expect(notesWrite).toHaveBeenLastCalledWith("notes/private.md", "late edit", "v2", "/vault");
  });
});

describe("central Unauthorized recovery", () => {
  it("resumes failed local-copy retries without dropping them on editor remount", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    signedIn();
    edit();
    holdSave("note:notes/private.md");
    vi.mocked(notesWrite).mockRejectedValueOnce(new Error("disk full"));
    expect(await useAuthStore.getState().lock()).toBe(false);
    handleUnauthorized();
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().unlock("password")).toBe(true);
    // The editor remount schedules the dirty text again.
    scheduleSave({ kind: "note", relPath: "notes/private.md" }, "unsaved private edits");
    await vi.advanceTimersByTimeAsync(800);
    expect(notesWrite).toHaveBeenLastCalledWith(expect.stringMatching(/\.local-/), "unsaved private edits", null, "/vault");
    expect(isSaveHeld("note:notes/private.md")).toBe(false);
  });

  it("keeps failed recovery edits dirty and queued instead of claiming they were saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signedIn();
    edit();
    handleUnauthorized();
    vi.mocked(notesWrite).mockRejectedValue(new Error("still read-only"));
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().unlock("password")).toBe(false);
    expect(useEditorStore.getState().open).toMatchObject({ content: "unsaved private edits", savedContent: "original" });
    expect(hasPendingSave()).toBe(true);
    expect(useEditorStore.getState().saveError?.message).toBe("still read-only");
    expect(useAuthStore.getState()).toMatchObject({ session: null, token: LOGIN.token, draftRecovery: { vaultRoot: "/vault" } });
  });

  it("hides access without losing any drafts, pauses writes, then flushes after unlock", async () => {
    vi.useFakeTimers();
    signedIn();
    scheduleSave({ kind: "note", relPath: "notes/earlier.md" }, "earlier draft");
    edit();
    vi.mocked(tauriInvoke).mockRejectedValue({ kind: "Unauthorized", message: "locked" });
    await expect(invoke("notes_list")).rejects.toMatchObject({ kind: "Unauthorized" });
    await Promise.resolve();
    expect(useAuthStore.getState()).toMatchObject({ session: null, token: null, accessNotice: ACCESS_ENDED_MESSAGE });
    expect(useEditorStore.getState().open?.content).toBe("unsaved private edits");
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPendingSave();
    expect(notesWrite).not.toHaveBeenCalled();
    expect(hasPendingSave()).toBe(true);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().unlock("password")).toBe(true);
    expect(notesWrite).toHaveBeenCalledWith("notes/earlier.md", "earlier draft", null, "/vault");
    expect(notesWrite).toHaveBeenCalledWith("notes/private.md", "unsaved private edits", "v1", "/vault");
    expect(useEditorStore.getState().open?.savedContent).toBe("unsaved private edits");
  });

  it("invalidates an old bootstrap so it cannot reopen access after a manual lock", async () => {
    const old = deferred<AuthAccess>();
    signedIn(false);
    useAuthStore.setState({ ready: false });
    vi.mocked(authBootstrap).mockReturnValueOnce(old.promise).mockResolvedValueOnce(UNLOCKED);
    const booting = useAuthStore.getState().bootstrap();
    handleUnauthorized();
    expect(await useAuthStore.getState().bootstrap()).toBe(true);
    expect(await useAuthStore.getState().lock()).toBe(true);
    old.resolve(UNLOCKED);
    expect(await booting).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it("does not treat a wrong current password as loss of access", async () => {
    signedIn();
    vi.mocked(tauriInvoke).mockRejectedValue({ kind: "Unauthorized", message: "wrong current password" });
    await expect(invoke("auth_set_lock", {})).rejects.toBeDefined();
    await Promise.resolve();
    expect(useAuthStore.getState().session).toEqual(LOCAL);
  });

  it("requires a visible bootstrap retry when access was lost with no lock enabled", () => {
    signedIn(false);
    handleUnauthorized();
    expect(useAuthStore.getState()).toMatchObject({ session: null, ready: false, lockEnabled: false, accessNotice: ACCESS_ENDED_MESSAGE });
  });

  it("ends frontend access when auth_lock rejects an ended token, retaining late drafts", async () => {
    signedIn();
    edit();
    const backend = deferred<void>();
    vi.mocked(tauriInvoke).mockReturnValue(backend.promise);
    vi.mocked(authLock).mockImplementation((token) => invoke("auth_lock", { token }));
    const locking = useAuthStore.getState().lock();
    await vi.waitFor(() => expect(authLock).toHaveBeenCalled());
    useEditorStore.getState().setContent("late unsaved draft");
    backend.reject({ kind: "Unauthorized", message: "session token ended" });
    expect(await locking).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ token: null, session: null, accessNotice: ACCESS_ENDED_MESSAGE });
    expect(useEditorStore.getState().open?.content).toBe("late unsaved draft");
    expect(hasPendingSave()).toBe(true);
  });
});

describe("vault-bound draft recovery", () => {
  it("never writes an A journal draft with null expectedVersion into backend B, then restores A explicitly", async () => {
    vi.useFakeTimers();
    const a = { root: "/A", name: "A", initialized: true };
    const b = { root: "/B", name: "B", initialized: true };
    useVaultStore.setState({ active: a });
    signedIn();
    useEditorStore.getState().openJournal("2026-10-17", "journal/2026/10/2026-10-17.md", "", "");
    useEditorStore.getState().setContent("A journal draft");
    scheduleSave(useEditorStore.getState().open!.source, "A journal draft");
    handleUnauthorized();
    vi.mocked(vaultCurrent).mockResolvedValue(b);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().unlock("password")).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ token: LOGIN.token, session: null, draftRecovery: { vaultRoot: "/A" } });
    expect(useVaultStore.getState().active).toEqual(a);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPendingSave();
    expect(journalSave).not.toHaveBeenCalled();
    expect(notesWrite).not.toHaveBeenCalled();
    expect(hasPendingSave()).toBe(true);
    expect(useEditorStore.getState().open?.content).toBe("A journal draft");
    vi.mocked(vaultSetActive).mockImplementation(async (root) => {
      expect(root).toBe("/A");
      vi.mocked(vaultCurrent).mockResolvedValue(a);
      return a;
    });
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().returnToDraftVault()).toBe(true);
    expect(authUnlock).toHaveBeenCalledTimes(1);
    expect(authBootstrap).toHaveBeenCalledTimes(1);
    expect(journalSave).toHaveBeenCalledWith("2026-10-17", "A journal draft", null, "/A");
    expect(useAuthStore.getState()).toMatchObject({ session: LOCAL, draftRecovery: null });
    expect(hasPendingSave()).toBe(false);
  });

  it("keeps drafts paused on vault-check failure and retries bootstrap without asking for a password again", async () => {
    vi.useFakeTimers();
    signedIn();
    edit();
    handleUnauthorized();
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(vaultCurrent).mockRejectedValueOnce(new Error("vault lookup failed"));
    expect(await useAuthStore.getState().unlock("password")).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session: null, draftRecovery: { vaultRoot: "/vault" }, error: "vault lookup failed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notesWrite).not.toHaveBeenCalled();
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    expect(await useAuthStore.getState().bootstrap()).toBe(true);
    expect(authUnlock).toHaveBeenCalledTimes(1);
    expect(notesWrite).toHaveBeenCalledWith("notes/private.md", "unsaved private edits", "v1", "/vault");
  });

  it("uses the captured root even if the backend switches after the frontend precheck", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signedIn();
    edit();
    handleUnauthorized();
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(notesWrite).mockImplementation(async (_path, _content, _version, root) => {
      expect(root).toBe("/vault");
      throw { kind: "Conflict", message: "Active vault changed to B" };
    });
    expect(await useAuthStore.getState().unlock("password")).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ session: null, draftRecovery: { vaultRoot: "/vault" } });
    expect(hasPendingSave()).toBe(true);
    expect(useEditorStore.getState().open?.savedContent).toBe("original");
  });

  it("keeps failed vault restoration paused and does not discard drafts", async () => {
    signedIn();
    edit();
    handleUnauthorized();
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(vaultCurrent).mockResolvedValue({ root: "/B", name: "B", initialized: true });
    await useAuthStore.getState().unlock("password");
    vi.mocked(vaultSetActive).mockRejectedValue(new Error("draft vault unavailable"));
    expect(await useAuthStore.getState().returnToDraftVault()).toBe(false);
    expect(useAuthStore.getState().error).toBe("draft vault unavailable");
    expect(notesWrite).not.toHaveBeenCalled();
    expect(hasPendingSave()).toBe(true);
    expect(useVaultStore.getState().active?.root).toBe("/vault");
  });
});
