/**
 * Toggle a GFM task-list checkbox (`- [ ]` ↔ `- [x]`) in Markdown source.
 *
 * The viewer knows each task item's source offset (from the Markdown
 * parser's position info), so it can flip exactly that item — never a
 * look-alike inside a code block or a different list.
 */

// List marker (bullet or ordered), whitespace, then the `[ ]` box.
const TASK_AT = /^([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\]/;

/**
 * Return `source` with the task item that starts at `offset` toggled, or
 * `null` when there is no task marker at that offset.
 */
export function toggleTaskAt(source: string, offset: number): string | null {
  if (offset < 0 || offset >= source.length) return null;
  const match = TASK_AT.exec(source.slice(offset));
  if (match === null) return null;
  const [, marker = "", gap = "", mark = ""] = match;
  const boxAt = offset + marker.length + gap.length + 1;
  const next = mark === " " ? "x" : " ";
  return source.slice(0, boxAt) + next + source.slice(boxAt + 1);
}
