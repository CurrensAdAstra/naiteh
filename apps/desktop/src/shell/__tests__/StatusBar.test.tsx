import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/chatMd/chatFlow", () => ({ stopChat: vi.fn() }));

import { stopChat } from "../../lib/chatMd/chatFlow";
import { useBackupStore } from "../../state/backupStore";
import { useAuthStore } from "../../state/authStore";
import { useEditorStore } from "../../state/editorStore";
import { useUIStore } from "../../state/uiStore";
import { StatusBar } from "../StatusBar";

describe("StatusBar live-update state", () => {
  beforeEach(() => {
    useUIStore.setState({
      liveUpdatesUnavailable: null,
      notice: null,
      chatRequest: null,
    });
  });

  it("shows the streaming chat with a Stop button", () => {
    useUIStore.setState({
      chatRequest: { requestId: "r", docKey: "note:a", model: "openai@gpt-x" },
    });
    render(<StatusBar />);
    expect(screen.getByTestId("status-chat")).toHaveTextContent(
      "Chat: streaming… (openai@gpt-x)",
    );
    screen.getByTestId("status-chat-stop").click();
    expect(stopChat).toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing about live updates while the watcher is healthy", () => {
    render(<StatusBar />);
    expect(screen.queryByTestId("status-live-updates")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-notice")).not.toBeInTheDocument();
  });

  it("says 'Live updates off' with the watcher's message as a tooltip", () => {
    useUIStore.setState({ liveUpdatesUnavailable: "inotify limit reached" });
    render(<StatusBar />);
    const indicator = screen.getByTestId("status-live-updates");
    expect(indicator).toHaveTextContent("Live updates off");
    expect(indicator).toHaveAttribute(
      "title",
      expect.stringContaining("inotify limit reached"),
    );
  });

  it("shows a transient notice and clears it after a few seconds", () => {
    vi.useFakeTimers();
    render(<StatusBar />);
    act(() => {
      useUIStore
        .getState()
        .setNotice("Unsaved edits kept as notes/a.local-20260511-093012.md");
    });
    expect(screen.getByTestId("status-notice")).toHaveTextContent(
      /kept as notes\/a\.local-/,
    );
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(screen.queryByTestId("status-notice")).not.toBeInTheDocument();
    expect(useUIStore.getState().notice).toBeNull();
  });
});

describe("StatusBar save error", () => {
  beforeEach(() => {
    useEditorStore.setState({ saveError: null });
  });

  it("says 'retrying' only while a retry is scheduled", () => {
    useEditorStore.setState({
      saveError: { key: "note:a.md", message: "disk full", retrying: true },
    });
    render(<StatusBar />);
    const el = screen.getByTestId("status-save-error");
    expect(el).toHaveTextContent("Save failed — retrying");
    expect(el).toHaveAttribute("title", "disk full");
  });

  it("shows a plain error when no retry is coming", () => {
    useEditorStore.setState({
      saveError: { key: "note:a.md", message: "disk full", retrying: false },
    });
    render(<StatusBar />);
    const el = screen.getByTestId("status-save-error");
    expect(el).toHaveTextContent("Save failed");
    expect(el).not.toHaveTextContent(/retrying/);
  });
});

describe("StatusBar backup indicator", () => {
  beforeEach(() => {
    useUIStore.setState({ notice: null, chatRequest: null, liveUpdatesUnavailable: null, settingsOpen: false, pendingAction: null });
    useBackupStore.setState({ running: false, progress: {}, lastRunError: null });
  });

  it("shows nothing when no backup ran", () => {
    render(<StatusBar />);
    expect(screen.queryByTestId("status-backup")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-backup-error")).not.toBeInTheDocument();
  });

  it("sums progress across targets while backing up", () => {
    useBackupStore.setState({
      running: true,
      progress: {
        a: { targetId: "a", done: 40, total: 100, relPath: "x" },
        b: { targetId: "b", done: 2, total: 20, relPath: "y" },
      },
    });
    render(<StatusBar />);
    expect(screen.getByTestId("status-backup")).toHaveTextContent("Backing up… 42/120");
  });

  it("shows the last error and opens Backup settings", () => {
    useBackupStore.setState({ lastRunError: "NAS: auth failed" });
    render(<StatusBar />);
    const btn = screen.getByTestId("status-backup-error");
    expect(btn).toHaveAttribute("title", "NAS: auth failed");
    btn.click();
    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(useUIStore.getState().pendingAction).toBe("showBackup");
  });
});

describe("StatusBar local access", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: "token", session: { username: "local", role: "Admin" }, lockEnabled: false, busy: null });
  });

  it("has no username or logout controls and no lock control when disabled", () => {
    render(<StatusBar />);
    expect(screen.queryByText("local")).toBeNull();
    expect(screen.queryByRole("button", { name: "Log out" })).toBeNull();
    expect(screen.queryByTestId("status-lock")).toBeNull();
  });

  it("offers manual lock only when enabled and disables it while awaiting acknowledgement", () => {
    useAuthStore.setState({ lockEnabled: true });
    render(<StatusBar />);
    expect(screen.getByTestId("status-lock")).toHaveTextContent("Lock");
    act(() => useAuthStore.setState({ busy: "lock" }));
    expect(screen.getByTestId("status-lock")).toBeDisabled();
    expect(screen.getByTestId("status-lock")).toHaveTextContent("Locking...");
  });
});
