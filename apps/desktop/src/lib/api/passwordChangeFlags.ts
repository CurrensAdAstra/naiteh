import type { LoginResult } from "../types";

/**
 * Tokens the backend flagged with `mustChangePassword` on login/resume.
 *
 * Callers that only forward `(token, session)` (the app's startup resume
 * path) lose the flag, so `authLogin`/`authResume` record it here and
 * `authStore.setSession` consults it: a flagged session is held as a
 * pending password change instead of being signed in.
 */
const flagged = new Set<string>();

export function notePasswordChangeRequired(result: LoginResult): void {
  if (result.mustChangePassword === true) flagged.add(result.token);
  else flagged.delete(result.token);
}

/** True (once) when `token` was flagged; the flag is consumed. */
export function takePasswordChangeRequired(token: string): boolean {
  return flagged.delete(token);
}

/** Test helper. */
export function resetPasswordChangeFlagsForTests(): void {
  flagged.clear();
}
