import { useEffect } from "react";

import { listen } from "@tauri-apps/api/event";

import { useUIStore, type ViewMode } from "../state/uiStore";

const VIEW_MODES: readonly ViewMode[] = [
  "journal",
  "notes",
  "calendar",
  "search",
  "tags",
  "sync",
  "settings",
];

function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as readonly string[]).includes(value);
}

/**
 * Bridges native application-menu clicks to in-app store actions. Mounted
 * once at the app root. The menu owns the global keyboard shortcuts
 * (accelerators), so each click/shortcut arrives here as a `menu:*`
 * event:
 *   - `menu:view` (payload = mode) → switch panel (Cmd+1..7)
 *   - `menu:command-palette` → open the palette (Cmd+P)
 *   - `menu:toggle-ai` → toggle the AI panel (Cmd+E)
 *   - `menu:new-note` / `menu:new-folder` → Notes panel prompts (Cmd+N /
 *     Shift+Cmd+N)
 *   - `menu:import-evernote` → Settings import flow
 */
export function useMenuEvents(): void {
  useEffect(() => {
    const ui = () => useUIStore.getState();
    const subscriptions = [
      listen<string>("menu:view", (e) => {
        if (isViewMode(e.payload)) ui().setViewMode(e.payload);
      }),
      listen("menu:command-palette", () => ui().setCommandPaletteOpen(true)),
      listen("menu:toggle-ai", () => ui().toggleAiPanel()),
      listen("menu:new-note", () => ui().requestNewNote()),
      listen("menu:new-folder", () => ui().requestNewFolder()),
      listen("menu:import-evernote", () => ui().requestEvernoteImport()),
    ];
    return () => {
      for (const sub of subscriptions) void sub.then((un) => un());
    };
  }, []);
}
