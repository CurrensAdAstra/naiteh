import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api/auth", () => ({
  authBootstrap: vi.fn(), authUnlock: vi.fn(), authMigrate: vi.fn(),
  authSetLock: vi.fn(), authLock: vi.fn(), authLogAction: vi.fn(),
}));

import { authBootstrap, authMigrate, authUnlock } from "../../../lib/api/auth";
import { useAuthStore } from "../../../state/authStore";
import { resetAutosaveForTests } from "../../../state/autosave";
import { useEditorStore } from "../../../state/editorStore";
import { LoginScreen } from "../LoginScreen";
import { validateLockPassword } from "../passwordRules";

const ACCESS = { lockEnabled: true, migrationRequired: false, login: { token: "token", session: { username: "local", role: "Admin" as const }, mustChangePassword: false } };

beforeEach(() => {
  vi.resetAllMocks();
  resetAutosaveForTests();
  useEditorStore.setState({ open: null });
  useAuthStore.setState({ token: null, session: null, lockEnabled: true, migrationRequired: false, ready: true, busy: null, error: null, accessNotice: null, draftRecovery: null });
});
afterEach(() => resetAutosaveForTests());

describe("app unlock", () => {
  it("submits only the password, with no username, role, or remembered-login controls", async () => {
    vi.mocked(authUnlock).mockResolvedValue(ACCESS);
    const user = userEvent.setup();
    render(<LoginScreen />);
    expect(screen.queryByLabelText(/user|remember|keep me/i)).toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
    await user.type(screen.getByLabelText("Password"), "lock-password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(authUnlock).toHaveBeenCalledWith("lock-password");
    expect(useAuthStore.getState().session).toEqual(ACCESS.login.session);
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("keeps an unlock error visible and lets the user retry", async () => {
    vi.mocked(authUnlock).mockRejectedValueOnce({ kind: "Unauthorized", message: "Incorrect app-lock password" }).mockResolvedValueOnce(ACCESS);
    const user = userEvent.setup();
    render(<LoginScreen />);
    await user.type(screen.getByLabelText("Password"), "password");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect app-lock password");
    expect(useAuthStore.getState().session).toBeNull();
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    expect(authUnlock).toHaveBeenCalledTimes(2);
  });

  it("shows bootstrap errors with an explicit retry, never an unlocked shell", async () => {
    useAuthStore.setState({ ready: false, lockEnabled: null, error: "Access file unreadable" });
    vi.mocked(authBootstrap).mockResolvedValue({ ...ACCESS, login: null });
    const user = userEvent.setup();
    render(<LoginScreen />);
    expect(screen.getByRole("alert")).toHaveTextContent("Access file unreadable");
    expect(screen.queryByLabelText("Password")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry access" }));
    expect(authBootstrap).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  });

  it("disables duplicate submissions during backend throttling or unlock", () => {
    useAuthStore.setState({ busy: "unlock" });
    render(<LoginScreen />);
    expect(screen.getByLabelText("Password")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Please wait..." })).toBeDisabled();
  });

});

describe("one-time legacy conversion", () => {
  beforeEach(() => useAuthStore.setState({ migrationRequired: true, lockEnabled: false }));

  it("explains the conversion and plaintext boundary and submits explicit legacy credentials", async () => {
    vi.mocked(authMigrate).mockResolvedValue(ACCESS);
    const user = userEvent.setup();
    render(<LoginScreen />);
    expect(screen.getByText(/removes legacy remembered sign-ins/)).toBeInTheDocument();
    expect(screen.getByText(/Markdown files remain unencrypted plaintext/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    await user.type(screen.getByLabelText("Legacy username"), "old-user");
    await user.type(screen.getByLabelText("Legacy password"), "old-password");
    await user.type(screen.getByLabelText("New app-lock password"), "new-lock-password");
    await user.type(screen.getByLabelText("Confirm new password"), "new-lock-password");
    await user.click(screen.getByRole("button", { name: "Convert and enable app lock" }));
    expect(authMigrate).toHaveBeenCalledWith("old-user", "old-password", "new-lock-password");
    expect(useAuthStore.getState()).toMatchObject({ migrationRequired: false, lockEnabled: true });
  });

  it("rejects unchanged or mismatched new passwords before IPC and surfaces backend conversion failures", async () => {
    vi.mocked(authMigrate).mockRejectedValue(new Error("Legacy account is inactive"));
    const user = userEvent.setup();
    render(<LoginScreen />);
    fireEvent.change(screen.getByLabelText("Legacy username"), { target: { value: "legacy" } });
    fireEvent.change(screen.getByLabelText("Legacy password"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText("New app-lock password"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "old-password" } });
    await user.click(screen.getByRole("button", { name: "Convert and enable app lock" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/different/);
    expect(authMigrate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("New app-lock password"), { target: { value: "new-password" } });
    await user.click(screen.getByRole("button", { name: "Convert and enable app lock" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/don't match/);
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password" } });
    await user.click(screen.getByRole("button", { name: "Convert and enable app lock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/inactive/);
    expect(useAuthStore.getState()).toMatchObject({ session: null, migrationRequired: true });
  });

  it("counts Unicode scalar characters, with both length bounds", () => {
    const scalar = String.fromCodePoint(0x1f510);
    expect(validateLockPassword(scalar.repeat(4), scalar.repeat(4))).toMatch(/8 to 1024/);
    expect(validateLockPassword(scalar.repeat(8), scalar.repeat(8))).toBeNull();
    expect(validateLockPassword(scalar.repeat(1024), scalar.repeat(1024))).toBeNull();
    expect(validateLockPassword("x".repeat(1025), "x".repeat(1025))).toMatch(/8 to 1024/);
  });
});
