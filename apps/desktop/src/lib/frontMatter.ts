/**
 * Markdown YAML front-matter helpers — client-side mirror of
 * `services::notes::set_pinned_in_content` and friends so the editor
 * toolbar can flip the `pinned` flag without a round-trip through the
 * backend (autosave persists the change).
 */

const FENCE = "---\n";

interface FrontMatterSplit {
  /** Front-matter body excluding the fences (may be empty). */
  header: string;
  /** Document body after the closing fence. */
  body: string;
  hasBlock: boolean;
}

function split(content: string): FrontMatterSplit {
  if (!content.startsWith(FENCE)) {
    return { header: "", body: content, hasBlock: false };
  }
  const end = content.indexOf("\n" + FENCE.trimEnd() + "\n", FENCE.length);
  // Equivalent to looking for '\n---\n'; trimEnd is just to keep the
  // intent of "the closing fence on its own line" explicit.
  const closingIdx = content.indexOf("\n---\n", FENCE.length);
  if (closingIdx === -1) {
    return { header: "", body: content, hasBlock: false };
  }
  // Suppress unused-var warning while keeping the intent comment above.
  void end;
  const header = content.slice(FENCE.length, closingIdx);
  const body = content.slice(closingIdx + "\n---\n".length);
  return { header, body, hasBlock: true };
}

/** Whether the content's front matter has `pinned: true`. */
export function isPinnedInContent(content: string): boolean {
  const { header, hasBlock } = split(content);
  if (!hasBlock) return false;
  for (const line of header.split("\n")) {
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
  const { header, body, hasBlock } = split(content);
  const value = pinned ? "true" : "false";
  if (!hasBlock) {
    if (!pinned) return content;
    return `---\npinned: ${value}\n---\n${content}`;
  }
  const lines = header.split("\n");
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
  return `---\n${next.join("\n")}\n---\n${body}`;
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
  for (const line of header.split("\n")) {
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
  const { header, body, hasBlock } = split(content);
  const serialized =
    unique.length === 0 ? null : `tags: [${unique.map(serializeTag).join(", ")}]`;

  if (!hasBlock) {
    if (serialized === null) return content;
    return `---\n${serialized}\n---\n${content}`;
  }

  const lines = header.split("\n");
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

  return `---\n${rewritten.join("\n")}\n---\n${body}`;
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
