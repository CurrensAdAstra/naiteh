import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authLogin } from "../../../lib/api/auth";
import { LoginScreen } from "../LoginScreen";

vi.mock("../../../lib/api/auth", () => ({
  authLogin: vi.fn(),
}));

const mockedLogin = vi.mocked(authLogin);

describe("LoginScreen", () => {
  beforeEach(() => {
    mockedLogin.mockReset();
    window.history.replaceState({}, "", "/");
  });

  it("submits credentials and returns the token + session", async () => {
    mockedLogin.mockResolvedValue({
      token: "deadbeef",
      session: { username: "admin", role: "Admin" },
    });
    const onLogin = vi.fn();
    const user = userEvent.setup();

    render(<LoginScreen onLogin={onLogin} />);
    await user.type(screen.getByTestId("login-username"), "admin");
    await user.type(screen.getByTestId("login-password"), "admin");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => {
      expect(mockedLogin).toHaveBeenCalledWith("admin", "admin");
      expect(onLogin).toHaveBeenCalledWith("deadbeef", {
        username: "admin",
        role: "Admin",
      });
    });
  });

  it("prefills admin on the admin path", () => {
    window.history.replaceState({}, "", "/admin");
    render(<LoginScreen onLogin={vi.fn()} />);
    expect(screen.getByTestId("login-username")).toHaveValue("admin");
  });

  it("shows a login failure", async () => {
    mockedLogin.mockRejectedValue({
      kind: "Unauthorized",
      message: "invalid username or password",
    });
    const user = userEvent.setup();

    render(<LoginScreen onLogin={vi.fn()} />);
    await user.type(screen.getByTestId("login-username"), "admin");
    await user.type(screen.getByTestId("login-password"), "wrong");
    await user.click(screen.getByTestId("login-submit"));

    expect(
      await screen.findByText(/invalid username or password/i),
    ).toBeInTheDocument();
  });
});
