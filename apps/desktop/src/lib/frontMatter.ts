/**
 * Markdown YAML front-matter helpers — client-side mirror of
 * `services::notes::set_pinned_in_content` and friends so the editor
 * toolbar can flip the `pinned` flag without a round-trip through the
 * backend (autosave persists the change).
 */

interface FrontMatterSplit {
  /** Front-matter body excluding the fences (may be empty). */
  header: string;
  /** Document body after the closing fence. */
  body: string;
  hasBlock: boolean;
  /** The opening fence's line ending; rewrites reuse it so CRLF stays CRLF. */
  eol: "\n" | "\r\n";
}

/**
 * Split a leading `---` block (LF or CRLF line endings; the closing fence
 * may be the last line with no trailing newline). Mirrors
 * `split_front_matter` in services/notes.rs.
 */
function split(content: string): FrontMatterSplit {
  let eol: "\n" | "\r\n";
  if (content.startsWith("---\r\n")) eol = "\r\n";
  else if (content.startsWith("---\n")) eol = "\n";
  else return { header: "", body: content, hasBlock: false, eol: "\n" };

  const rest = content.slice(3 + eol.length);
  let pos = 0;
  for (;;) {
    const nl = rest.indexOf("\n", pos);
    const lineEnd = nl === -1 ? rest.length : nl;
    if (rest.slice(pos, lineEnd).replace(/\r$/, "") === "---") {
      const header = rest.slice(0, pos).replace(/\r?\n$/, "");
      const body = nl === -1 ? "" : rest.slice(nl + 1);
      return { header, body, hasBlock: true, eol };
    }
    if (nl === -1) return { header: "", body: content, hasBlock: false, eol: "\n" };
    pos = nl + 1;
  }
}

function headerLines(header: string): string[] {
  return header === "" ? [] : header.split(/\r?\n/);
}

function joinBlock(lines: readonly string[], body: string, eol: string): string {
  const inner = lines.length === 0 ? "" : `${lines.join(eol)}${eol}`;
  return `---${eol}${inner}---${eol}${body}`;
}

/**
 * The document body without its leading front-matter block, plus where
 * that body starts in `content` (0 when there is no block). The viewer
 * renders `body` and adds `offset` to map source positions back.
 */
export function splitFrontMatterBody(content: string): {
  body: string;
  offset: number;
} {
  const { body, hasBlock } = split(content);
  return hasBlock
    ? { body, offset: content.length - body.length }
    : { body: content, offset: 0 };
}

/** Whether the content's front matter has `pinned: true`. */
export function isPinnedInContent(content: string): boolean {
  const { header, hasBlock } = split(content);
  if (!hasBlock) return false;
  for (const line of headerLines(header)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key === "pinned") return /^true$/i.test(value);
  }
  return false;
}

/**
 * Insert / replace / append `pinned: <bool>` in the front matter. When
 * the document has no front-matter block and `pinned` is false, returns
 * the content unchanged. Mirrors `set_pinned_in_content` in Rust.
 */
export function setPinnedInContent(content: string, pinned: boolean): string {
  const { header, body, hasBlock, eol } = split(content);
  const value = pinned ? "true" : "false";
  if (!hasBlock) {
    if (!pinned) return content;
    return `---\npinned: ${value}\n---\n${content}`;
  }
  const lines = headerLines(header);
  let found = false;
  const next = lines.map((line) => {
    const idx = line.indexOf(":");
    if (idx < 0) return line;
    const key = line.slice(0, idx).trim();
    if (key !== "pinned") return line;
    found = true;
    return `pinned: ${value}`;
  });
  if (!found) next.push(`pinned: ${value}`);
  return joinBlock(next, body, eol);
}

export function togglePinnedInContent(content: string): string {
  return setPinnedInContent(content, !isPinnedInContent(content));
}

// ── Tags ─────────────────────────────────────────────────────────────────

function stripQuotes(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s.at(0);
    const last = s.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseTagArray(value: string): string[] {
  const v = value.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return [];
  const inner = v.slice(1, -1);
  return inner
    .split(",")
    .map((t) => stripQuotes(t).trim())
    .filter((t) => t.length > 0);
}

function serializeTag(tag: string): string {
  // Quote only when needed (mirrors what people typically write by hand).
  if (/^[\p{Letter}\p{Number}_-]+$/u.test(tag)) return tag;
  return `"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Returns the unique, order-preserving tag list from the front matter. */
export function getTagsFromContent(content: string): string[] {
  const { header, hasBlock } = split(content);
  if (!hasBlock) return [];
  for (const line of headerLines(header)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (key === "tags") return dedupe(parseTagArray(line.slice(idx + 1)));
  }
  return [];
}

/**
 * Upsert the `tags: [...]` line in the front matter. Empty array removes
 * the line entirely. If no front matter exists and `tags` is non-empty, a
 * fresh block is prepended.
 */
export function setTagsInContent(content: string, tags: readonly string[]): string {
  const unique = dedupe(tags);
  const { header, body, hasBlock, eol } = split(content);
  const serialized =
    unique.length === 0 ? null : `tags: [${unique.map(serializeTag).join(", ")}]`;

  if (!hasBlock) {
    if (serialized === null) return content;
    return `---\n${serialized}\n---\n${content}`;
  }

  const lines = headerLines(header);
  let found = false;
  const rewritten: string[] = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx >= 0 && line.slice(0, idx).trim() === "tags") {
      found = true;
      if (serialized !== null) rewritten.push(serialized);
      // When serialized is null the line is dropped entirely.
      continue;
    }
    rewritten.push(line);
  }
  if (!found && serialized !== null) rewritten.push(serialized);

  return joinBlock(rewritten, body, eol);
}

export function addTagToContent(content: string, tag: string): string {
  const trimmed = tag.trim();
  if (trimmed === "") return content;
  const current = getTagsFromContent(content);
  if (current.includes(trimmed)) return content;
  return setTagsInContent(content, [...current, trimmed]);
}

export function removeTagFromContent(content: string, tag: string): string {
  const current = getTagsFromContent(content);
  const next = current.filter((t) => t !== tag);
  if (next.length === current.length) return content;
  return setTagsInContent(content, next);
}

function dedupe(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
