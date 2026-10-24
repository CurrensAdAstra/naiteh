import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api/auth", () => ({
  authBootstrap: vi.fn(), authUnlock: vi.fn(), authMigrate: vi.fn(),
  authSetLock: vi.fn(), authLock: vi.fn(), authLogAction: vi.fn(), authMigrateSecrets: vi.fn(),
}));

import { authMigrateSecrets, authSetLock } from "../../../lib/api/auth";
import { useAuthStore } from "../../../state/authStore";
import { resetAutosaveForTests } from "../../../state/autosave";
import { useEditorStore } from "../../../state/editorStore";
import { SecuritySection } from "../sections/SecuritySection";

const LOGIN = { token: "local-token", session: { username: "local", role: "Admin" as const }, mustChangePassword: false };
const ENABLED = { lockEnabled: true, migrationRequired: false, login: LOGIN };
const DISABLED = { ...ENABLED, lockEnabled: false };

beforeEach(() => {
  vi.resetAllMocks();
  resetAutosaveForTests();
  useEditorStore.setState({ open: null });
  useAuthStore.setState({ token: LOGIN.token, session: LOGIN.session, lockEnabled: false, migrationRequired: false, ready: true, busy: null, error: null, accessNotice: null });
});
afterEach(() => resetAutosaveForTests());

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("Security app lock", () => {
  it("enables the optional lock with a new password and stays unlocked", async () => {
    vi.mocked(authSetLock).mockResolvedValue(ENABLED);
    const user = userEvent.setup();
    render(<SecuritySection />);
    expect(screen.queryByRole("button", { name: "Lock now" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "Enable app lock" }));
    change("New app-lock password", "fresh-lock-password");
    change("Confirm new password", "fresh-lock-password");
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(authSetLock).toHaveBeenCalledWith(LOGIN.token, true, null, "fresh-lock-password");
    expect(await screen.findByRole("status")).toHaveTextContent(/remains unlocked/);
    expect(useAuthStore.getState()).toMatchObject({ lockEnabled: true, session: LOGIN.session });
    expect(screen.getByLabelText("New app-lock password")).toHaveValue("");
    expect(screen.queryByText("local")).toBeNull();
  });

  it("requires the current password to disable the lock", async () => {
    useAuthStore.setState({ lockEnabled: true });
    vi.mocked(authSetLock).mockResolvedValue(DISABLED);
    const user = userEvent.setup();
    render(<SecuritySection />);
    await user.click(screen.getByRole("checkbox", { name: "Enable app lock" }));
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/current app-lock password/);
    expect(authSetLock).not.toHaveBeenCalled();
    change("Current app-lock password", "existing-password");
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(authSetLock).toHaveBeenCalledWith(LOGIN.token, false, "existing-password", null);
    expect(await screen.findByRole("status")).toHaveTextContent(/future launches open without a password/);
    expect(screen.queryByRole("button", { name: "Lock now" })).toBeNull();
  });

  it("changes the password or explicitly keeps the existing one", async () => {
    useAuthStore.setState({ lockEnabled: true });
    vi.mocked(authSetLock).mockResolvedValue(ENABLED);
    const user = userEvent.setup();
    render(<SecuritySection />);
    change("Current app-lock password", "existing-password");
    change("New app-lock password", "new-password");
    change("Confirm new password", "new-password");
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(authSetLock).toHaveBeenLastCalledWith(LOGIN.token, true, "existing-password", "new-password");
    change("Current app-lock password", "new-password");
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(authSetLock).toHaveBeenLastCalledWith(LOGIN.token, true, "new-password", null);
  });

  it("validates new passwords and displays backend configuration errors without losing access", async () => {
    useAuthStore.setState({ lockEnabled: true });
    vi.mocked(authSetLock).mockRejectedValue({ kind: "Unauthorized", message: "Incorrect current password" });
    const user = userEvent.setup();
    render(<SecuritySection />);
    change("Current app-lock password", "existing-password");
    change("New app-lock password", "short");
    change("Confirm new password", "short");
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/8 to 1024/);
    expect(authSetLock).not.toHaveBeenCalled();
    change("New app-lock password", "new-password");
    change("Confirm new password", "new-password");
    await user.click(screen.getByRole("button", { name: "Save app lock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Incorrect current password/);
    expect(useAuthStore.getState()).toMatchObject({ lockEnabled: true, session: LOGIN.session });
  });
});

describe("security boundaries and secret migration", () => {
  it("explains plaintext, remote copies, unlocked malware, and OS storage without suggesting vault encryption", () => {
    render(<SecuritySection />);
    expect(screen.getByText(/Markdown notes and attachments remain unencrypted/)).toHaveTextContent(/Disk encryption does not protect remote copies or against malware while the device is unlocked/);
    expect(screen.getByText(/Markdown notes and attachments remain unencrypted/)).toHaveTextContent(/not content encryption/);
    expect(screen.getByText(/API keys and SFTP passwords belong in OS credential storage/)).toHaveTextContent(/instead of falling back to plaintext/);
  });

  it("retries secure storage migration with the active token and clears old messages on each attempt", async () => {
    vi.mocked(authMigrateSecrets).mockRejectedValueOnce(new Error("keyring locked")).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("keyring unavailable"));
    const user = userEvent.setup();
    render(<SecuritySection />);
    const button = screen.getByRole("button", { name: "Retry secure storage migration" });
    await user.click(button);
    expect(authMigrateSecrets).toHaveBeenCalledWith(LOGIN.token);
    expect(await screen.findByRole("alert")).toHaveTextContent(/keyring locked.*No plaintext fallback/);
    await user.click(button);
    expect(await screen.findByRole("status")).toHaveTextContent(/Secure storage migration completed/);
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/keyring unavailable/);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
