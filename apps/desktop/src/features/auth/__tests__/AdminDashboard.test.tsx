import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api/auth", () => ({
  authListUsers: vi.fn(),
  authListAuditLogs: vi.fn(),
  authSetUserActive: vi.fn(),
  authCreateUser: vi.fn(),
  authChangePassword: vi.fn(),
  authLogAction: vi.fn().mockResolvedValue(undefined),
  authLogout: vi.fn().mockResolvedValue(undefined),
}));

import {
  authCreateUser,
  authListAuditLogs,
  authListUsers,
  authSetUserActive,
} from "../../../lib/api/auth";
import { useAuthStore } from "../../../state/authStore";
import { AdminDashboard } from "../AdminDashboard";

const mockedListUsers = vi.mocked(authListUsers);
const mockedListLogs = vi.mocked(authListAuditLogs);
const mockedSetActive = vi.mocked(authSetUserActive);
const mockedCreate = vi.mocked(authCreateUser);

describe("AdminDashboard", () => {
  beforeEach(() => {
    mockedListUsers.mockReset();
    mockedListLogs.mockReset();
    mockedSetActive.mockReset();
    mockedCreate.mockReset();
    mockedListUsers.mockResolvedValue([
      { username: "admin", role: "Admin", active: true },
      { username: "mgkyung", role: "User", active: true },
    ]);
    mockedListLogs.mockResolvedValue([
      {
        timestamp: "2026-05-15T01:00:00Z",
        username: "admin",
        action: "login_success",
        detail: null,
      },
    ]);
    useAuthStore.setState({
      token: "deadbeef",
      session: { username: "admin", role: "Admin" },
      pendingPasswordChange: null,
    });
  });

  it("lists accounts and the audit log", async () => {
    render(<AdminDashboard />);
    expect(
      await screen.findByTestId("admin-account-toggle-mgkyung"),
    ).toHaveTextContent("Disable");
    expect(screen.getByTestId("admin-account-toggle-admin")).toBeDisabled();
    expect(screen.getByRole("list", { name: "Audit log" })).toHaveTextContent(
      "login_success",
    );
  });

  it("toggles an account and refreshes the log", async () => {
    mockedSetActive.mockResolvedValue([
      { username: "admin", role: "Admin", active: true },
      { username: "mgkyung", role: "User", active: false },
    ]);
    const user = userEvent.setup();
    render(<AdminDashboard />);
    await user.click(await screen.findByTestId("admin-account-toggle-mgkyung"));
    await waitFor(() =>
      expect(screen.getByTestId("admin-account-toggle-mgkyung")).toHaveTextContent(
        "Enable",
      ),
    );
    expect(mockedSetActive).toHaveBeenCalledWith("deadbeef", "mgkyung", false);
    expect(mockedListLogs).toHaveBeenCalledTimes(2);
  });

  it("creates a user and shows the new list", async () => {
    mockedCreate.mockResolvedValue([
      { username: "admin", role: "Admin", active: true },
      { username: "mgkyung", role: "User", active: true },
      { username: "dana", role: "User", active: true },
    ]);
    const user = userEvent.setup();
    render(<AdminDashboard />);
    const form = await screen.findByTestId("admin-create-user-form");
    await user.type(within(form).getByLabelText("Username"), "dana");
    await user.type(within(form).getByLabelText("Password"), "dana-password");
    await user.type(within(form).getByLabelText("Confirm password"), "dana-password");
    await user.click(within(form).getByTestId("admin-create-user-submit"));

    expect(await screen.findByTestId("admin-account-toggle-dana")).toBeInTheDocument();
    expect(mockedCreate).toHaveBeenCalledWith(
      "deadbeef",
      "dana",
      "dana-password",
      "User",
    );
  });

  it("refuses a password equal to the username", async () => {
    const user = userEvent.setup();
    render(<AdminDashboard />);
    const form = await screen.findByTestId("admin-create-user-form");
    await user.type(within(form).getByLabelText("Username"), "longusername");
    await user.type(within(form).getByLabelText("Password"), "longusername");
    await user.type(within(form).getByLabelText("Confirm password"), "longusername");
    await user.click(within(form).getByTestId("admin-create-user-submit"));
    expect(
      await within(form).findByTestId("admin-create-user-error"),
    ).toHaveTextContent(/same as the username/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
