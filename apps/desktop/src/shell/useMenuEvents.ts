import { useEffect } from "react";

import { listen } from "@tauri-apps/api/event";

import { useUIStore, type ViewMode } from "../state/uiStore";

// A Record keyed by ViewMode (rather than an array) makes the compiler
// flag this table whenever a view mode is added or removed.
const VIEW_MODES: Readonly<Record<ViewMode, true>> = {
  journal: true,
  notes: true,
  calendar: true,
  search: true,
  tags: true,
  sync: true,
};

function isViewMode(value: unknown): value is ViewMode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(VIEW_MODES, value)
  );
}

/**
 * Bridges native application-menu clicks to in-app store actions. Mounted
 * once at the app root. The menu owns the global keyboard shortcuts
 * (accelerators), so each click/shortcut arrives here as a `menu:*`
 * event:
 *   - `menu:view` (payload = mode) → switch panel (Cmd+1..6, one
 *     per view mode: journal, notes, calendar, search, tags, sync)
 *   - `menu:command-palette` → open the palette (Cmd+P)
 *   - `menu:toggle-ai` → toggle the AI panel (Cmd+E)
 *   - `menu:toggle-edit` → switch the open note between the rendered
 *     view and the source editor (Shift+Cmd+E)
 *   - `menu:settings` → open the settings modal (Cmd+,)
 *   - `menu:new-note` / `menu:new-folder` → Notes panel prompts (Cmd+N /
 *     Shift+Cmd+N)
 *   - `menu:import-evernote` → Settings import flow
 */
export function useMenuEvents(): void {
  useEffect(() => {
    const ui = () => useUIStore.getState();
    const subscriptions = [
      listen<unknown>("menu:view", (e) => {
        if (isViewMode(e.payload)) ui().setViewMode(e.payload);
      }),
      listen("menu:command-palette", () => ui().setCommandPaletteOpen(true)),
      listen("menu:toggle-ai", () => ui().toggleAiPanel()),
      listen("menu:toggle-edit", () => ui().toggleEditorMode()),
      listen("menu:settings", () => ui().setSettingsOpen(true)),
      listen("menu:new-note", () => ui().requestNewNote()),
      listen("menu:new-folder", () => ui().requestNewFolder()),
      listen("menu:import-evernote", () => ui().requestEvernoteImport()),
    ];
    return () => {
      for (const sub of subscriptions) void sub.then((un) => un());
    };
  }, []);
}
