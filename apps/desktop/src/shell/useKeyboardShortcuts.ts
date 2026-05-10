import { useEffect } from "react";

import { useUIStore, type ViewMode } from "../state/uiStore";

/** Same order as the Activity Bar, indexed by Cmd/Ctrl-N (1..7). */
const VIEW_MODES_BY_INDEX: readonly ViewMode[] = [
  "journal",
  "notes",
  "calendar",
  "search",
  "tags",
  "sync",
  "settings",
] as const;

/**
 * Wires up the global keyboard shortcuts:
 *   - Cmd/Ctrl + 1..7 → switch ViewMode
 *   - Cmd/Ctrl + E    → toggle AI Assist panel
 * These are intentionally distinct from Cmd/Ctrl + S (handled in EditorPanel)
 * and from any shortcut a third-party-style modifier alone (Alt etc.) would
 * use. We bind on `window` so they fire regardless of focus, then bail when
 * the user is already in a text input/textarea/contenteditable so we don't
 * eat keystrokes mid-typing.
 */
export function useKeyboardShortcuts(): void {
  const setViewMode = useUIStore((s) => s.setViewMode);
  const toggleAiPanel = useUIStore((s) => s.toggleAiPanel);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.altKey || e.shiftKey) return; // keep the surface tight

      // Numeric mode switching is OK to fire even while a text field is
      // focused — Cmd+digit is universally a navigation shortcut. The
      // Cmd+E toggle however is a plain letter; respect text editing.
      const target = e.target as Element | null;
      const inEditableField = isEditableTarget(target);

      if (e.key >= "1" && e.key <= "7") {
        const idx = Number.parseInt(e.key, 10) - 1;
        const mode = VIEW_MODES_BY_INDEX[idx];
        if (mode === undefined) return;
        e.preventDefault();
        setViewMode(mode);
        return;
      }

      if (e.key.toLowerCase() === "e" && !inEditableField) {
        e.preventDefault();
        toggleAiPanel();
        return;
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setViewMode, toggleAiPanel]);
}

function isEditableTarget(target: Element | null): boolean {
  if (target === null) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // CodeMirror's editable surface is a contenteditable child of `.cm-editor`.
  const html = target as HTMLElement;
  if (html.isContentEditable) return true;
  return false;
}

/** Exposed for tests. */
export const __VIEW_MODES_BY_INDEX = VIEW_MODES_BY_INDEX;
