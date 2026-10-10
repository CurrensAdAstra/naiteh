import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authChangePassword, authLogin, authLogout } from "../../../lib/api/auth";
import {
  notePasswordChangeRequired,
  resetPasswordChangeFlagsForTests,
} from "../../../lib/api/passwordChangeFlags";
import type { AuthSession } from "../../../lib/types";
import { useAuthStore } from "../../../state/authStore";
import { LoginScreen } from "../LoginScreen";

vi.mock("../../../lib/api/auth", () => ({
  authLogin: vi.fn(),
  authLogout: vi.fn().mockResolvedValue(undefined),
  authChangePassword: vi.fn(),
  authLogAction: vi.fn().mockResolvedValue(undefined),
}));

const mockedLogin = vi.mocked(authLogin);
const mockedLogout = vi.mocked(authLogout);
const mockedChange = vi.mocked(authChangePassword);

const ALICE: AuthSession = { username: "alice", role: "User" };

describe("LoginScreen", () => {
  beforeEach(() => {
    mockedLogin.mockReset();
    mockedChange.mockReset();
    mockedLogout.mockClear();
    resetPasswordChangeFlagsForTests();
    useAuthStore.setState({
      token: null,
      session: null,
      pendingPasswordChange: null,
      signedOutReason: null,
    });
    window.history.replaceState({}, "", "/");
  });

  it("submits credentials and returns the token + session", async () => {
    mockedLogin.mockResolvedValue({
      token: "deadbeef",
      session: { username: "admin", role: "Admin" },
      mustChangePassword: false,
    });
    const onLogin = vi.fn();
    const user = userEvent.setup();

    render(<LoginScreen onLogin={onLogin} />);
    await user.type(screen.getByTestId("login-username"), "admin");
    await user.type(screen.getByTestId("login-password"), "admin");
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => {
      // "Keep me signed in" defaults on, so remember=true.
      expect(mockedLogin).toHaveBeenCalledWith("admin", "admin", true);
      expect(onLogin).toHaveBeenCalledWith("deadbeef", {
        username: "admin",
        role: "Admin",
      });
    });
  });

  it("passes remember=false when the checkbox is unticked", async () => {
    mockedLogin.mockResolvedValue({
      token: "deadbeef",
      session: { username: "admin", role: "Admin" },
      mustChangePassword: false,
    });
    const user = userEvent.setup();

    render(<LoginScreen onLogin={vi.fn()} />);
    await user.type(screen.getByTestId("login-username"), "admin");
    await user.type(screen.getByTestId("login-password"), "admin");
    await user.click(screen.getByTestId("login-remember"));
    await user.click(screen.getByTestId("login-submit"));

    await waitFor(() => {
      expect(mockedLogin).toHaveBeenCalledWith("admin", "admin", false);
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

  it("explains an unexpected sign-out", () => {
    useAuthStore.setState({ signedOutReason: "Your session ended." });
    render(<LoginScreen onLogin={vi.fn()} />);
    expect(screen.getByTestId("login-notice")).toHaveTextContent(
      "Your session ended.",
    );
  });

  describe("forced password change", () => {
    it("after login: blocks entry until a valid new password is set", async () => {
      mockedLogin.mockResolvedValue({
        token: "tok",
        session: ALICE,
        mustChangePassword: true,
      });
      mockedChange.mockResolvedValue(undefined);
      const onLogin = vi.fn();
      const user = userEvent.setup();

      render(<LoginScreen onLogin={onLogin} />);
      await user.type(screen.getByTestId("login-username"), "alice");
      await user.type(screen.getByTestId("login-password"), "initial-pw");
      await user.click(screen.getByTestId("login-submit"));

      expect(await screen.findByTestId("password-change-step")).toBeInTheDocument();
      // Not signed in yet: App keeps showing the login screen.
      expect(onLogin).not.toHaveBeenCalled();
      expect(useAuthStore.getState().session).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();
      // The password just typed is offered as the current one.
      expect(screen.getByTestId("forced-password-current")).toHaveValue(
        "initial-pw",
      );

      // Client-side rules run before any IPC.
      await user.type(screen.getByTestId("forced-password-new"), "short");
      await user.type(screen.getByTestId("forced-password-confirm"), "short");
      await user.click(screen.getByTestId("forced-password-submit"));
      expect(await screen.findByTestId("forced-password-error")).toHaveTextContent(
        /at least 8/i,
      );
      expect(mockedChange).not.toHaveBeenCalled();

      await user.clear(screen.getByTestId("forced-password-new"));
      await user.clear(screen.getByTestId("forced-password-confirm"));
      await user.type(screen.getByTestId("forced-password-new"), "alice");
      await user.type(screen.getByTestId("forced-password-confirm"), "alice");
      await user.click(screen.getByTestId("forced-password-submit"));
      expect(await screen.findByTestId("forced-password-error")).toHaveTextContent(
        /at least 8/i,
      );

      await user.clear(screen.getByTestId("forced-password-new"));
      await user.clear(screen.getByTestId("forced-password-confirm"));
      await user.type(screen.getByTestId("forced-password-new"), "a-much-better-pw");
      await user.type(
        screen.getByTestId("forced-password-confirm"),
        "a-much-better-pw",
      );
      await user.click(screen.getByTestId("forced-password-submit"));

      await waitFor(() => {
        expect(mockedChange).toHaveBeenCalledWith(
          "tok",
          "initial-pw",
          "a-much-better-pw",
        );
        expect(useAuthStore.getState().session).toEqual(ALICE);
      });
      expect(useAuthStore.getState().token).toBe("tok");
      expect(useAuthStore.getState().pendingPasswordChange).toBeNull();
    });

    it("rejects a new password equal to the username or the current one", async () => {
      useAuthStore.getState().setSession("tok", ALICE, true);
      const user = userEvent.setup();
      render(<LoginScreen onLogin={vi.fn()} />);

      await user.type(screen.getByTestId("forced-password-current"), "same-password");
      await user.type(screen.getByTestId("forced-password-new"), "same-password");
      await user.type(screen.getByTestId("forced-password-confirm"), "same-password");
      await user.click(screen.getByTestId("forced-password-submit"));
      expect(await screen.findByTestId("forced-password-error")).toHaveTextContent(
        /different from the current/i,
      );
      expect(mockedChange).not.toHaveBeenCalled();
    });

    it("after resume: asks for the current password and shows backend errors", async () => {
      // App's resume path only forwards (token, session); the flag is
      // recorded by authResume and picked up by setSession.
      notePasswordChangeRequired({
        token: "resumed",
        session: ALICE,
        mustChangePassword: true,
      });
      useAuthStore.getState().setSession("resumed", ALICE);
      expect(useAuthStore.getState().session).toBeNull();
      mockedChange
        .mockRejectedValueOnce({
          kind: "Unauthorized",
          message: "current password is incorrect",
        })
        .mockResolvedValueOnce(undefined);

      const user = userEvent.setup();
      render(<LoginScreen onLogin={vi.fn()} />);
      const current = await screen.findByTestId("forced-password-current");
      expect(current).toHaveValue("");

      await user.type(current, "wrong-old-pw");
      await user.type(screen.getByTestId("forced-password-new"), "brand-new-pw");
      await user.type(screen.getByTestId("forced-password-confirm"), "brand-new-pw");
      await user.click(screen.getByTestId("forced-password-submit"));
      expect(await screen.findByTestId("forced-password-error")).toHaveTextContent(
        /current password is incorrect/i,
      );
      // A wrong current password on an auth command never logs out.
      expect(useAuthStore.getState().pendingPasswordChange).not.toBeNull();

      // Fields are kept after a failure; only the current password changes.
      await user.clear(screen.getByTestId("forced-password-current"));
      await user.type(screen.getByTestId("forced-password-current"), "right-old-pw");
      await user.click(screen.getByTestId("forced-password-submit"));
      await waitFor(() => {
        expect(useAuthStore.getState().session).toEqual(ALICE);
      });
      expect(mockedChange).toHaveBeenLastCalledWith(
        "resumed",
        "right-old-pw",
        "brand-new-pw",
      );
    });

    it("can't be skipped — only abandoned by signing out", async () => {
      useAuthStore.getState().setSession("tok", ALICE, true);
      const user = userEvent.setup();
      render(<LoginScreen onLogin={vi.fn()} />);

      expect(screen.queryByTestId("login-submit")).not.toBeInTheDocument();
      await user.click(screen.getByTestId("password-change-signout"));

      expect(await screen.findByTestId("login-submit")).toBeInTheDocument();
      expect(mockedLogout).toHaveBeenCalledWith("tok");
      expect(useAuthStore.getState().pendingPasswordChange).toBeNull();
      expect(useAuthStore.getState().session).toBeNull();
    });
  });
});
