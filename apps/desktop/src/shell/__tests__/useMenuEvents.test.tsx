import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: Handler) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

vi.mock("../../lib/chatMd/chatFlow", () => ({
  sendChat: vi.fn(() => Promise.resolve()),
  newChat: vi.fn(() => Promise.resolve()),
  stopChat: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";
import { newChat, sendChat, stopChat } from "../../lib/chatMd/chatFlow";
import { useAuthStore } from "../../state/authStore";
import { useUIStore, type ViewMode } from "../../state/uiStore";
import { useMenuEvents } from "../useMenuEvents";

function Harness() {
  useMenuEvents();
  return null;
}

function fire(event: string, payload: unknown = undefined) {
  const handler = handlers.get(event);
  if (handler === undefined) throw new Error(`no listener for ${event}`);
  handler({ payload });
}

describe("useMenuEvents", () => {
  beforeEach(() => {
    handlers.clear();
    vi.mocked(sendChat).mockClear();
    vi.mocked(newChat).mockClear();
    vi.mocked(stopChat).mockClear();
    useAuthStore.setState({ token: "token", session: { username: "local", role: "Admin" }, busy: null });
    (listen as unknown as Mock).mockClear();
    useUIStore.setState({
      viewMode: "journal",
      pendingAction: null,
      commandPaletteOpen: false,
      modelPickerOpen: false,
      settingsOpen: false,
    });
  });

  it("registers a listener per menu channel", () => {
    render(<Harness />);
    expect(handlers.has("menu:view")).toBe(true);
    expect(handlers.has("menu:command-palette")).toBe(true);
    expect(handlers.has("menu:ai-chat-send")).toBe(true);
    expect(handlers.has("menu:ai-new-chat")).toBe(true);
    expect(handlers.has("menu:ai-select-model")).toBe(true);
    expect(handlers.has("menu:ai-stop")).toBe(true);
    expect(handlers.has("menu:toggle-ai")).toBe(false);
    expect(handlers.has("menu:new-note")).toBe(true);
    expect(handlers.has("menu:new-folder")).toBe(true);
    expect(handlers.has("menu:import-evernote")).toBe(true);
    expect(handlers.has("menu:settings")).toBe(true);
  });

  it("menu:view switches the view mode for a valid payload", () => {
    render(<Harness />);
    fire("menu:view", "tags");
    expect(useUIStore.getState().viewMode).toBe("tags");
  });

  it("menu:view ignores an unknown mode", () => {
    render(<Harness />);
    fire("menu:view", "bogus");
    expect(useUIStore.getState().viewMode).toBe("journal");
  });

  it("menu:view accepts exactly the six view modes (Cmd+1..6)", () => {
    render(<Harness />);
    const modes: ViewMode[] = [
      "journal",
      "notes",
      "calendar",
      "search",
      "tags",
      "sync",
    ];
    for (const mode of [...modes].reverse()) {
      fire("menu:view", mode);
      expect(useUIStore.getState().viewMode).toBe(mode);
    }
  });

  it("menu:view ignores non-string and prototype-key payloads", () => {
    render(<Harness />);
    useUIStore.setState({ viewMode: "notes" });
    for (const payload of [7, null, undefined, "toString", "__proto__"]) {
      fire("menu:view", payload);
      expect(useUIStore.getState().viewMode).toBe("notes");
    }
  });

  it("menu:command-palette opens the palette", () => {
    render(<Harness />);
    fire("menu:command-palette");
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
  });

  it("chat menu items run the chat actions", () => {
    render(<Harness />);
    fire("menu:ai-chat-send");
    expect(sendChat).toHaveBeenCalledTimes(1);
    fire("menu:ai-new-chat");
    expect(newChat).toHaveBeenCalledTimes(1);
    fire("menu:ai-stop");
    expect(stopChat).toHaveBeenCalledTimes(1);
    fire("menu:ai-select-model");
    expect(useUIStore.getState().modelPickerOpen).toBe(true);
  });

  it("menu:new-note / new-folder queue the Notes prompt", () => {
    render(<Harness />);
    fire("menu:new-note");
    expect(useUIStore.getState().viewMode).toBe("notes");
    expect(useUIStore.getState().pendingAction).toBe("newNote");

    fire("menu:new-folder");
    expect(useUIStore.getState().pendingAction).toBe("newFolder");
  });

  it("menu:import-evernote opens the settings modal import flow", () => {
    render(<Harness />);
    fire("menu:import-evernote");
    expect(useUIStore.getState().settingsOpen).toBe(true);
    expect(useUIStore.getState().pendingAction).toBe("evernoteImport");
  });

  it("menu:settings opens the settings modal", () => {
    render(<Harness />);
    expect(useUIStore.getState().settingsOpen).toBe(false);
    fire("menu:settings");
    expect(useUIStore.getState().settingsOpen).toBe(true);
  });

  it.each(["locked", "locking"])("ignores every menu mutation while %s", (state) => {
    render(<Harness />);
    if (state === "locked") useAuthStore.setState({ token: null, session: null });
    else useAuthStore.setState({ busy: "lock" });
    for (const event of handlers.keys()) fire(event, "notes");
    expect(useUIStore.getState()).toMatchObject({ viewMode: "journal", settingsOpen: false, pendingAction: null, commandPaletteOpen: false, modelPickerOpen: false });
    expect(sendChat).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();
    expect(stopChat).not.toHaveBeenCalled();
  });
});
