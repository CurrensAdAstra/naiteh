import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Tabbable descendants, skipping anything inside a `hidden` subtree. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.closest("[hidden]") === null && el.tabIndex >= 0,
  );
}

/**
 * Modal-dialog keyboard contract:
 * - on mount, focus moves into the dialog (first tabbable element);
 * - Tab / Shift+Tab cycle inside it (focus can't leak to the page);
 * - Escape calls `onClose`;
 * - on unmount, focus returns to whatever was focused before opening.
 */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    (focusableWithin(dialog)[0] ?? dialog).focus();

    function onKeyDown(e: KeyboardEvent) {
      if (dialog === null) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusableWithin(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const current = document.activeElement;
      const inside = current instanceof Node && dialog.contains(current);
      if (e.shiftKey) {
        if (!inside || current === first || current === dialog) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused !== null && previouslyFocused.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [dialogRef]);
}
