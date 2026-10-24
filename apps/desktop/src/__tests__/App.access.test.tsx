import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api/auth", () => ({
  authBootstrap: vi.fn(), authUnlock: vi.fn(), authMigrate: vi.fn(),
  authSetLock: vi.fn(), authLock: vi.fn(), authLogAction: vi.fn(),
}));
vi.mock("../lib/api/vault", () => ({ vaultCurrent: vi.fn(), vaultSetActive: vi.fn() }));
vi.mock("../lib/api/notes", () => ({ notesWrite: vi.fn() }));
vi.mock("../lib/api/journal", () => ({ journalSave: vi.fn() }));
const nativeClose: {
  handler: ((event: { preventDefault: () => void }) => Promise<void>) | null;
  registrations: number;
} = { handler: null, registrations: 0 };
const destroy = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: NonNullable<typeof nativeClose.handler>) => {
      nativeClose.handler = handler;
      nativeClose.registrations += 1;
      return () => { if (nativeClose.handler === handler) nativeClose.handler = null; };
    },
    destroy,
  }),
}));
vi.mock("../shell/useMenuEvents", () => ({ useMenuEvents: vi.fn() }));
vi.mock("../lib/applyAppearance", () => ({ applyAppearance: vi.fn() }));
vi.mock("../features/settings/FirstRunSetup", () => ({ FirstRunSetup: () => <div data-testid="first-run" /> }));
vi.mock("../shell/AppShell", () => ({ AppShell: () => (
  <div data-testid="app-shell"><button onClick={() => void useAuthStore.getState().lock()}>Lock</button></div>
) }));

import { App } from "../App";
import { authBootstrap, authLock, authLogAction, authUnlock } from "../lib/api/auth";
import { notesWrite } from "../lib/api/notes";
import { journalSave } from "../lib/api/journal";
import { vaultCurrent, vaultSetActive } from "../lib/api/vault";
import type { AuthAccess, VaultInfo } from "../lib/types";
import { handleUnauthorized, useAuthStore } from "../state/authStore";
import { hasPendingSave, holdSave, resetAutosaveForTests, scheduleSave } from "../state/autosave";
import { useEditorStore } from "../state/editorStore";
import { useSettingsStore } from "../state/settingsStore";
import { useVaultStore } from "../state/vaultStore";

const LOGIN = { token: "token", session: { username: "local", role: "Admin" as const }, mustChangePassword: false };
const OPEN: AuthAccess = { lockEnabled: false, migrationRequired: false, login: LOGIN };
const UNLOCKED = { ...OPEN, lockEnabled: true };
const LOCKED = { ...UNLOCKED, login: null };
const A = { root: "/A", name: "A", initialized: true };
const B = { root: "/B", name: "B", initialized: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function requestClose() {
  await waitFor(() => expect(nativeClose.handler).not.toBeNull());
  const preventDefault = vi.fn();
  await act(async () => nativeClose.handler!({ preventDefault }));
  expect(preventDefault).toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();
  expect(screen.getByText(/^Not closing:/)).toBeVisible();
}

beforeEach(() => {
  vi.resetAllMocks();
  nativeClose.handler = null;
  nativeClose.registrations = 0;
  resetAutosaveForTests();
  useAuthStore.setState({ token: null, session: null, lockEnabled: null, migrationRequired: false, ready: false, busy: null, error: null, accessNotice: null, draftRecovery: null });
  useEditorStore.setState({ open: null });
  useVaultStore.setState({ active: null });
  useSettingsStore.setState({ config: null, loading: false, refresh: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(vaultCurrent).mockResolvedValue({ root: "/vault", name: "vault", initialized: true });
  vi.mocked(authLock).mockResolvedValue(undefined);
});
afterEach(() => {
  resetAutosaveForTests();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("App local access gate", () => {
  it("opens a fresh installation immediately, deduplicating StrictMode bootstrap", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(OPEN);
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(authBootstrap).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("login-screen")).toBeNull();
  });

  it("shows password-only unlock for an enabled lock before loading the vault", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(LOCKED);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText("Password");
    expect(vaultCurrent).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
  });

  it("requires explicit legacy conversion without loading workspace data", async () => {
    vi.mocked(authBootstrap).mockResolvedValue({ ...OPEN, migrationRequired: true, login: null });
    render(<App />);
    expect(await screen.findByLabelText("Legacy username")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Convert and enable app lock" })).toBeInTheDocument();
    expect(vaultCurrent).not.toHaveBeenCalled();
  });

  it("shows failed bootstrap errors and retries without assuming an unlocked installation", async () => {
    vi.mocked(authBootstrap).mockRejectedValueOnce(new Error("app-lock.json is unreadable")).mockResolvedValueOnce(OPEN);
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/unreadable/);
    expect(vaultCurrent).not.toHaveBeenCalled();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry access" }));
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
  });

  it("does not give /admin any special routing or identity UI", async () => {
    window.history.replaceState({}, "", "/admin");
    vi.mocked(authBootstrap).mockResolvedValue(OPEN);
    render(<App />);
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(vaultCurrent).toHaveBeenCalled();
    expect(screen.queryByText("local")).toBeNull();
  });

  it("does not re-bootstrap on remount after an acknowledged manual lock", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    const first = render(<App />);
    await screen.findByTestId("app-shell");
    await act(async () => { await useAuthStore.getState().lock(); });
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    first.unmount();
    render(<App />);
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(authBootstrap).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("app-shell")).toBeNull();
  });

  it("hides the shell on Unauthorized, then recovers and audits drafts after unlock", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(notesWrite).mockResolvedValue({ meta: { path: "", relPath: "notes/a.md", title: "", tags: [], pinned: false, mtime: 0, size: 0 }, version: "v2" });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    act(() => {
      useEditorStore.getState().openNote("notes/a.md", "original", "v1");
      useEditorStore.getState().setContent("draft only in memory");
      handleUnauthorized();
    });
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/not confirmed saved/);
    expect(useEditorStore.getState().open?.content).toBe("draft only in memory");
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(notesWrite).toHaveBeenCalledWith("notes/a.md", "draft only in memory", "v1", "/vault");
    expect(authLogAction).toHaveBeenCalledWith("token", "note_save", "notes/a.md");
  });

  it("keeps workspace failures visible with retry after access is granted", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(OPEN);
    vi.mocked(vaultCurrent).mockRejectedValueOnce(new Error("vault missing")).mockResolvedValueOnce({ root: "/vault", name: "vault", initialized: true });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("vault missing");
    fireEvent.click(screen.getByRole("button", { name: "Retry workspace" }));
    await waitFor(() => expect(screen.getByTestId("app-shell")).toBeInTheDocument());
  });

  it("offers explicit A-vault recovery after unlocking while backend B is active", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(vaultCurrent).mockResolvedValue(A);
    vi.mocked(journalSave).mockResolvedValue({ path: "", mtime: 0, version: "v2" });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    act(() => {
      useEditorStore.getState().openJournal("2026-10-17", "journal/2026/10/2026-10-17.md", "", "");
      useEditorStore.getState().setContent("A journal draft");
      scheduleSave(useEditorStore.getState().open!.source, "A journal draft");
      handleUnauthorized();
    });
    vi.mocked(vaultCurrent).mockResolvedValue(B);
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("button", { name: "Return to draft vault" })).toBeEnabled();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(useVaultStore.getState().active?.root).toBe("/A");
    expect(journalSave).not.toHaveBeenCalled();
    expect(hasPendingSave()).toBe(true);
    await requestClose();
    vi.mocked(vaultSetActive).mockImplementation(async (root) => {
      expect(root).toBe("/A");
      vi.mocked(vaultCurrent).mockResolvedValue(A);
      return A;
    });
    await user.click(screen.getByRole("button", { name: "Return to draft vault" }));
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(journalSave).toHaveBeenCalledWith("2026-10-17", "A journal draft", null, "/A");
    expect(authUnlock).toHaveBeenCalledTimes(1);
    expect(authBootstrap).toHaveBeenCalledTimes(2);
    expect(nativeClose.registrations).toBe(1);
  });

  it("does not replace the draft vault if the workspace read changes after the recovery precheck", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(vaultCurrent).mockResolvedValue(A);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    act(() => {
      useEditorStore.getState().openNote("notes/a.md", "original", "v1");
      useEditorStore.getState().setContent("held A draft");
      scheduleSave({ kind: "note", relPath: "notes/a.md" }, "held A draft");
      holdSave("note:notes/a.md");
      handleUnauthorized();
    });
    vi.mocked(vaultCurrent).mockResolvedValueOnce(A).mockResolvedValueOnce(B);
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("button", { name: "Return to draft vault" })).toBeInTheDocument();
    expect(useVaultStore.getState().active?.root).toBe("/A");
    expect(screen.queryByTestId("app-shell")).toBeNull();
    expect(notesWrite).not.toHaveBeenCalled();
    expect(useEditorStore.getState().open?.content).toBe("held A draft");
  });

  it("keeps one close guard through failed recovery and a subsequent vault lookup error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    vi.mocked(authUnlock).mockResolvedValue(UNLOCKED);
    vi.mocked(vaultCurrent).mockResolvedValue(A);
    vi.mocked(notesWrite).mockRejectedValue(new Error("disk read-only"));
    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("app-shell");
    act(() => {
      useEditorStore.getState().openNote("notes/a.md", "original", "v1");
      useEditorStore.getState().setContent("failed recovery draft");
      handleUnauthorized();
    });
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/disk read-only/);
    await requestClose();
    vi.mocked(vaultCurrent).mockRejectedValue(new Error("vault lookup failed"));
    await user.click(screen.getByRole("button", { name: "Retry draft recovery" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/vault lookup failed/);
    await requestClose();
    expect(nativeClose.registrations).toBe(1);
    expect(useEditorStore.getState().open?.content).toBe("failed recovery draft");
    expect(hasPendingSave()).toBe(true);
  });

  it("protects drafts during the gap before workspace loading finishes", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    const loading = deferred<VaultInfo | null>();
    vi.mocked(vaultCurrent).mockReturnValue(loading.promise);
    useVaultStore.setState({ active: A });
    render(<App />);
    await screen.findByText("Loading…");
    act(() => {
      useEditorStore.getState().openNote("notes/a.md", "original", "v1");
      useEditorStore.getState().setContent("draft while loading");
    });
    await requestClose();
    expect(notesWrite).not.toHaveBeenCalled();
    await act(async () => loading.resolve(A));
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(nativeClose.registrations).toBe(1);
  });

  it("protects drafts even while a workspace error screen is displayed", async () => {
    vi.mocked(authBootstrap).mockResolvedValue(UNLOCKED);
    vi.mocked(vaultCurrent).mockRejectedValue(new Error("workspace unavailable"));
    useVaultStore.setState({ active: A });
    render(<App />);
    await screen.findByRole("alert");
    act(() => {
      useEditorStore.getState().openNote("notes/a.md", "original", "v1");
      useEditorStore.getState().setContent("retained workspace draft");
    });
    await requestClose();
    expect(screen.getByRole("alert")).toHaveTextContent(/workspace unavailable/);
    expect(useEditorStore.getState().open?.content).toBe("retained workspace draft");
  });
});
