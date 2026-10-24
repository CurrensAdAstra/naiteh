import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";

import { formatAppError } from "../lib/types";
import { flushPendingSave, hasPendingSave } from "../state/autosave";

/** One root listener, kept mounted through access, recovery, and workspace loading. */
export function useDraftCloseGuard(canFlush: boolean): string | null {
  const mayFlush = useRef(canFlush);
  mayFlush.current = canFlush;
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (canFlush && !hasPendingSave()) setNotice(null);
  }, [canFlush]);

  useEffect(() => {
    let disposed = false;
    let closing = false;
    let unlisten: (() => void) | null = null;
    try {
      const win = getCurrentWindow();
      void win.onCloseRequested(async (event) => {
        if (!hasPendingSave()) return;
        event.preventDefault();
        if (!mayFlush.current) {
          setNotice("Not closing: unsaved edits are held only in memory. Finish loading, unlock, or return to the draft vault and retry recovery before closing this window.");
          return;
        }
        if (closing) return;
        closing = true;
        try {
          const { failedKeys, preserved } = await flushPendingSave({ leaving: true });
          if (failedKeys.length > 0 || !preserved || !mayFlush.current) {
            setNotice("Not closing: some edits could not be saved or preserved as a copy. Drafts remain in memory. Fix the problem and retry before closing.");
            return;
          }
          await win.destroy();
        } catch (error) {
          setNotice(`Not closing: ${formatAppError(error)}. Keep this window open while unsaved edits remain.`);
        } finally {
          closing = false;
        }
      }).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch(() => {});
    } catch {
      // Plain browser, without a native window.
    }
    return () => { disposed = true; unlisten?.(); };
  }, []);

  return notice;
}
