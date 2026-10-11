import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/chatMd/chatFlow", () => ({ stopChat: vi.fn() }));

import { stopChat } from "../../lib/chatMd/chatFlow";
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
