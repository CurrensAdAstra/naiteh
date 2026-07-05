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

import { listen } from "@tauri-apps/api/event";
import { useUIStore } from "../../state/uiStore";
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
    (listen as unknown as Mock).mockClear();
    useUIStore.setState({
      viewMode: "journal",
      pendingAction: null,
      commandPaletteOpen: false,
      aiPanelOpen: false,
      settingsOpen: false,
    });
  });

  it("registers a listener per menu channel", () => {
    render(<Harness />);
    expect(handlers.has("menu:view")).toBe(true);
    expect(handlers.has("menu:command-palette")).toBe(true);
    expect(handlers.has("menu:toggle-ai")).toBe(true);
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

  it("menu:command-palette opens the palette", () => {
    render(<Harness />);
    fire("menu:command-palette");
    expect(useUIStore.getState().commandPaletteOpen).toBe(true);
  });

  it("menu:toggle-ai toggles the AI panel", () => {
    render(<Harness />);
    fire("menu:toggle-ai");
    expect(useUIStore.getState().aiPanelOpen).toBe(true);
    fire("menu:toggle-ai");
    expect(useUIStore.getState().aiPanelOpen).toBe(false);
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
});
