import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("../../lib/api/auth", () => ({
  authLogout: vi.fn().mockResolvedValue(undefined),
  authLogAction: vi.fn().mockResolvedValue(undefined),
  authChangePassword: vi.fn(),
}));
vi.mock("../../lib/api/notes", () => ({
  notesWrite: vi.fn(),
}));
vi.mock("../../lib/api/journal", () => ({
  journalSave: vi.fn(),
}));

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { waitFor } from "@testing-library/react";

import { authChangePassword, authLogout } from "../../lib/api/auth";
import { invoke } from "../../lib/api/invoke";
import { notesWrite } from "../../lib/api/notes";
import {
  notePasswordChangeRequired,
  resetPasswordChangeFlagsForTests,
} from "../../lib/api/passwordChangeFlags";
import type { AuthSession } from "../../lib/types";
import { SESSION_ENDED_MESSAGE, useAuthStore } from "../authStore";
import {
  holdSave,
  isSaveHeld,
  resetAutosaveForTests,
  scheduleSave,
} from "../autosave";
import { beginOpen, isLatestOpen, useEditorStore } from "../editorStore";
import { useUIStore } from "../uiStore";

const mockedWrite = vi.mocked(notesWrite);
const mockedTauriInvoke = vi.mocked(tauriInvoke);
const mockedChange = vi.mocked(authChangePassword);
const BOB: AuthSession = { username: "bob", role: "User" };

describe("authStore sessions", () => {
  beforeEach(() => {
    resetPasswordChangeFlagsForTests();
    vi.mocked(authLogout).mockClear();
    mockedChange.mockReset();
    useAuthStore.setState({
      token: null,
      session: null,
      pendingPasswordChange: null,
      signedOutReason: null,
    });
  });

  it("holds a must-change login as pending instead of signing in", () => {
    useAuthStore.getState().setSession("t1", BOB, true);
    const s = useAuthStore.getState();
    expect(s.session).toBeNull();
    expect(s.token).toBeNull();
    expect(s.pendingPasswordChange).toEqual({ token: "t1", session: BOB });
  });

  it("honours the flag recorded by authLogin/authResume (App's resume path)", () => {
    notePasswordChangeRequired({ token: "t2", session: BOB, mustChangePassword: true });
    useAuthStore.getState().setSession("t2", BOB);
    expect(useAuthStore.getState().pendingPasswordChange?.token).toBe("t2");
    // The flag is consumed: a later plain sign-in with the token works.
    useAuthStore.getState().setSession("t2", BOB);
    expect(useAuthStore.getState().session).toEqual(BOB);
  });

  it("completePasswordChange signs in only after the backend accepts", async () => {
    useAuthStore.getState().setSession("t3", BOB, true);
    mockedChange.mockRejectedValueOnce({ kind: "Validation", message: "nope" });
    await expect(
      useAuthStore.getState().completePasswordChange("old-pass-1", "new-pass-1"),
    ).rejects.toEqual({ kind: "Validation", message: "nope" });
    expect(useAuthStore.getState().session).toBeNull();

    mockedChange.mockResolvedValueOnce(undefined);
    await useAuthStore.getState().completePasswordChange("old-pass-1", "new-pass-1");
    expect(mockedChange).toHaveBeenLastCalledWith("t3", "old-pass-1", "new-pass-1");
    expect(useAuthStore.getState().session).toEqual(BOB);
    expect(useAuthStore.getState().token).toBe("t3");
    expect(useAuthStore.getState().pendingPasswordChange).toBeNull();
  });

  it("changePassword uses the signed-in token", async () => {
    useAuthStore.getState().setSession("t4", BOB);
    mockedChange.mockResolvedValueOnce(undefined);
    await useAuthStore.getState().changePassword("old-pass-1", "new-pass-1");
    expect(mockedChange).toHaveBeenCalledWith("t4", "old-pass-1", "new-pass-1");
  });

  it("concurrent clearSession calls share one logout", async () => {
    useAuthStore.getState().setSession("t5", BOB);
    await Promise.all([
      useAuthStore.getState().clearSession(),
      useAuthStore.getState().clearSession(),
    ]);
    expect(authLogout).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().session).toBeNull();
  });
});

describe("session gate (Unauthorized from a non-auth command)", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedTauriInvoke.mockReset();
    vi.mocked(authLogout).mockClear();
    useEditorStore.setState({ open: null, view: null, saveError: null });
    useAuthStore.setState({
      token: "live",
      session: BOB,
      pendingPasswordChange: null,
      signedOutReason: null,
    });
  });

  it("logs out through the normal logout path and explains why", async () => {
    useEditorStore.getState().openNote("notes/private.md", "secret", "v1");
    mockedTauriInvoke.mockRejectedValue({
      kind: "Unauthorized",
      message: "no active session",
    });

    await expect(invoke("notes_list", { relDir: null })).rejects.toEqual({
      kind: "Unauthorized",
      message: "no active session",
    });

    await waitFor(() => {
      expect(useAuthStore.getState().session).toBeNull();
    });
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().signedOutReason).toBe(SESSION_ENDED_MESSAGE);
    // Same path as an explicit logout: editor cleared, token revoked.
    expect(useEditorStore.getState().open).toBeNull();
    expect(authLogout).toHaveBeenCalledWith("live");
  });

  it("ignores Unauthorized from auth commands (wrong password, not admin)", async () => {
    mockedTauriInvoke.mockRejectedValue({
      kind: "Unauthorized",
      message: "invalid credentials",
    });
    await expect(invoke("auth_change_password", {})).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(useAuthStore.getState().session).toEqual(BOB);
    expect(authLogout).not.toHaveBeenCalled();
  });

  it("ignores other errors", async () => {
    mockedTauriInvoke.mockRejectedValue({ kind: "Io", message: "disk full" });
    await expect(invoke("notes_list", {})).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(useAuthStore.getState().session).toEqual(BOB);
  });
});

describe("authStore.clearSession (logout)", () => {
  beforeEach(() => {
    resetAutosaveForTests();
    mockedWrite.mockReset();
    mockedWrite.mockResolvedValue({
      meta: {
        path: "",
        relPath: "",
        title: "",
        tags: [],
        mtime: 0,
        size: 0,
        pinned: false,
      },
      version: "v2",
    });
    useEditorStore.setState({ open: null, view: null, saveError: null });
    useAuthStore.setState({
      token: "t",
      session: { username: "alice" } as unknown as AuthSession,
      pendingPasswordChange: null,
    });
  });

  it("flushes unsaved edits, then closes the note and clears the view", async () => {
    const order: string[] = [];
    mockedWrite.mockImplementation(async (relPath, content) => {
      order.push(`write:${relPath}:${content}`);
      // The note must still be open while its edits are written.
      order.push(`open:${useEditorStore.getState().open?.key ?? "none"}`);
      return {
        meta: {
          path: "",
          relPath,
          title: "",
          tags: [],
          mtime: 0,
          size: 0,
          pinned: false,
        },
        version: "v2",
      };
    });
    useEditorStore.getState().openNote("notes/private.md", "secret", "v1");
    const parent = document.createElement("div");
    const view = new EditorView({
      state: EditorState.create({ doc: "secret" }),
      parent,
    });
    useEditorStore.setState({ view });
    useEditorStore.getState().setContent("secret + unsaved");
    scheduleSave({ kind: "note", relPath: "notes/private.md" }, "secret + unsaved");
    const pendingOpen = beginOpen();

    await useAuthStore.getState().clearSession();

    expect(order).toEqual([
      "write:notes/private.md:secret + unsaved",
      "open:note:notes/private.md",
    ]);
    expect(useEditorStore.getState().open).toBeNull();
    expect(useEditorStore.getState().view).toBeNull();
    // An open request started before logout can't land afterwards.
    expect(isLatestOpen(pendingOpen)).toBe(false);
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().session).toBeNull();
    expect(authLogout).toHaveBeenCalledWith("t");
    view.destroy();
  });

  it("clears the editor even when nothing is open or dirty", async () => {
    await useAuthStore.getState().clearSession();
    expect(mockedWrite).not.toHaveBeenCalled();
    expect(useEditorStore.getState().open).toBeNull();
  });

  it("keeps a held (conflicting) edit as a .local copy on logout", async () => {
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a + mine");
    holdSave("note:notes/a.md");
    expect(await useAuthStore.getState().clearSession()).toBe(true);
    expect(mockedWrite).toHaveBeenCalledTimes(1);
    const [relPath, content, expected] = mockedWrite.mock.calls[0]!;
    expect(relPath).toMatch(/^notes\/a\.local-\d{8}-\d{6}\.md$/);
    expect(content).toBe("a + mine");
    expect(expected).toBeNull();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("stays signed in when the held edit can't be preserved", async () => {
    vi.mocked(authLogout).mockClear();
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockedWrite.mockRejectedValue({ kind: "Io", message: "read-only" });
    useEditorStore.getState().openNote("notes/a.md", "a", "v1");
    useEditorStore.getState().setContent("a + mine");
    holdSave("note:notes/a.md");
    expect(await useAuthStore.getState().clearSession()).toBe(false);
    expect(useAuthStore.getState().token).toBe("t");
    expect(useEditorStore.getState().open?.content).toBe("a + mine");
    expect(useEditorStore.getState().saveError?.message).toBe("read-only");
    expect(useUIStore.getState().notice).toMatch(/Not signed out/);
    expect(authLogout).not.toHaveBeenCalled();
    expect(isSaveHeld("note:notes/a.md")).toBe(true);
    // A dead session forces the logout regardless.
    expect(await useAuthStore.getState().clearSession({ force: true })).toBe(
      true,
    );
    expect(useAuthStore.getState().token).toBeNull();
    resetAutosaveForTests();
    vi.useRealTimers();
    errorSpy.mockRestore();
  });
});
