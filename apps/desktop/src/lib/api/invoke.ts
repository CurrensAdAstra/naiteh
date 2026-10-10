import {
  invoke as tauriInvoke,
  type InvokeArgs,
} from "@tauri-apps/api/core";

import { isAppError } from "../types";

/**
 * Central IPC entry point. Every `lib/api/*` module calls the backend
 * through {@link invoke} so cross-cutting error handling lives in one
 * place.
 *
 * Session gate: the backend refuses every non-auth command with
 * `AppError { kind: "Unauthorized" }` while no session is active (the
 * frontend sends no token to those commands). When that happens the
 * registered handler runs — the auth store registers one that logs the
 * user out, so the login screen appears instead of a broken shell.
 *
 * `auth_*` commands are excluded: there `Unauthorized` means "wrong
 * password" or "not an admin" and must surface as a form error rather
 * than ending the session.
 */

/** True inside the Tauri webview; false in a plain browser (vite dev). */
export function hasTauriRuntime(): boolean {
  if (typeof window === "undefined") return true;
  const maybeWindow = window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: unknown };
  };
  return typeof maybeWindow.__TAURI_INTERNALS__?.invoke === "function";
}

/** Matches the session-gate error (tolerates a lower-case `kind`). */
export function isUnauthorizedError(err: unknown): boolean {
  return isAppError(err) && err.kind.toLowerCase() === "unauthorized";
}

type UnauthorizedHandler = (command: string) => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

/**
 * Register the callback that runs when a gated command is refused.
 * Returns an unregister function. Only one handler is active at a time.
 */
export function setUnauthorizedHandler(
  handler: UnauthorizedHandler | null,
): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

function isGatedCommand(command: string): boolean {
  return !command.startsWith("auth_");
}

export async function invoke<T>(
  command: string,
  args?: InvokeArgs,
): Promise<T> {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (err) {
    if (isGatedCommand(command) && isUnauthorizedError(err)) {
      const handler = unauthorizedHandler;
      if (handler !== null) {
        // Deferred so the caller sees its rejection first and the
        // handler never runs inside the caller's own stack.
        queueMicrotask(() => {
          try {
            handler(command);
          } catch {
            // A failing handler must not mask the original error.
          }
        });
      }
    }
    throw err;
  }
}
