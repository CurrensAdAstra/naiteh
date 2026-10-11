/**
 * Chat-note format — identical to the Obsidian plugin chatgpt-md
 * (https://github.com/bramses/chatgpt-md, MIT), so notes move between the
 * two unchanged. wiki: domain-model ("Chat note").
 *
 * Messages are separated by {@link CHAT_HR}; a message whose first line is
 * a heading `role::<role>` belongs to that role (optionally followed by a
 * small `(provider@model)` span); anything else is the user's.
 */

export const CHAT_HR = '<hr class="__chatgpt_plugin">';
const NEWLINE = "\n\n";

export type ChatRole = "user" | "assistant" | "system";

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 3;
  return Math.min(6, Math.max(1, Math.round(level)));
}

/**
 * The separator + role heading written before a message (chatgpt-md's
 * `getHeaderRole`). `model` (`provider@model`) is shown in small type.
 */
export function chatHeader(
  role: ChatRole,
  headingLevel: number,
  model?: string | null,
): string {
  const hashes = "#".repeat(clampLevel(headingLevel));
  const modelSpan =
    model !== undefined && model !== null && model !== ""
      ? `<span style="font-size: small;"> (${model})</span>`
      : "";
  return `${NEWLINE}${CHAT_HR}${NEWLINE}${hashes} role::${role}${modelSpan}${NEWLINE}`;
}

/** `role::assistant (openai@gpt-4o)` heading text → role + model. */
export function parseRoleHeading(
  text: string,
): { role: string; model: string | null } | null {
  const match = /^\s*role::(\w+)\s*(?:\(([^)]*)\))?\s*$/.exec(text);
  if (match === null) return null;
  const role = match[1] ?? "";
  const model = match[2]?.trim() ?? "";
  return { role, model: model === "" ? null : model };
}

/** Friendly label for a role badge in the reading view. */
export function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return role;
  }
}

/** `Chat 2026-10-11 0930` — chatgpt-md's new-chat title. */
export function chatTitle(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Chat ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
    now.getDate(),
  )} ${pad(now.getHours())}${pad(now.getMinutes())}`;
}
