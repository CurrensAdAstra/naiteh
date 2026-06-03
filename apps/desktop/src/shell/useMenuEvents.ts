import { useEffect } from "react";

import { listen } from "@tauri-apps/api/event";

import { useUIStore } from "../state/uiStore";

/**
 * Bridges native application-menu clicks to in-app actions. Mounted once
 * at the app root. Currently: File ▸ Import from Evernote emits
 * `menu:import-evernote`, which routes to the Settings import flow.
 */
export function useMenuEvents(): void {
  useEffect(() => {
    const unlisten = listen("menu:import-evernote", () => {
      useUIStore.getState().requestEvernoteImport();
    });
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);
}
