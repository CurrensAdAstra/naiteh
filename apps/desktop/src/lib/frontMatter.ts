/**
 * Markdown YAML front-matter helpers. The editor edits `pinned`, `tags`
 * and other fields in the buffer directly (autosave persists the
 * change), so there is no backend round-trip. Reads mirror the Rust
 * reader `services::notes::parse_yaml_map` (see vault/wiki/vault-and-data.md,
 * "Front matter"): scalars, flow lists and block lists.
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
    if (key === "pinned") return /^true$/i.test(parseScalar(value));
  }
  return false;
}

/**
 * Insert / replace / append `pinned: <bool>` in the front matter. When
 * the document has no front-matter block and `pinned` is false, returns
 * the content unchanged.
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

/**
 * One YAML scalar, the inverse of the Rust `yaml_quote`: double-quoted
 * strings are unescaped, single-quoted ones collapse `''`, anything else
 * is taken trimmed. Mirrors `parse_scalar` in services/notes.rs.
 */
function parseScalar(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return unescapeDoubleQuoted(t.slice(1, -1));
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
  " ": " ",
};
const HEX_LEN: Record<string, number> = { x: 2, u: 4, U: 8 };

function unescapeDoubleQuoted(s: string): string {
  let out = "";
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const esc = chars[i + 1];
    if (esc === undefined) {
      out += "\\";
      break;
    }
    i++;
    const hexLen = HEX_LEN[esc];
    if (hexLen !== undefined) {
      const digits = chars.slice(i + 1, i + 1 + hexLen).join("");
      const code = /^[0-9a-fA-F]+$/.test(digits) && digits.length === hexLen
        ? parseInt(digits, 16)
        : NaN;
      if (!Number.isNaN(code) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        out += String.fromCodePoint(code);
        i += hexLen;
      } else {
        out += `\\${esc}`;
      }
      continue;
    }
    out += SIMPLE_ESCAPES[esc] ?? `\\${esc}`;
  }
  return out;
}

/** Flow list `[a, "b, c", 'd']`, quote-aware. */
function parseTagArray(value: string): string[] {
  const v = value.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return [];
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const c of v.slice(1, -1)) {
    if (quote !== null) {
      current += c;
      if (escaped) escaped = false;
      else if (quote === '"' && c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ",") {
      items.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  items.push(current);
  return items.map(parseScalar).filter((t) => t.length > 0);
}

function serializeTag(tag: string): string {
  // Quote only when needed (mirrors what people typically write by hand).
  if (/^[\p{Letter}\p{Number}_-]+$/u.test(tag)) return tag;
  return `"${tag.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const BLOCK_ITEM = /^(\s*)-(?:\s+(.*))?$/;

/** Where the `tags` entry sits in the header lines. */
interface TagsEntry {
  /** Index of the `tags:` key line. */
  start: number;
  /** One past its last block-list item (`start + 1` for a flow list). */
  end: number;
  /** Block-list style (`tags:` then `- item` lines). */
  block: boolean;
  /** Leading whitespace of the first block item. */
  indent: string;
  tags: string[];
}

function findTags(lines: readonly string[]): TagsEntry | null {
  for (const [i, line] of lines.entries()) {
    if (/^\s/.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx < 0 || line.slice(0, idx).trim() !== "tags") continue;
    const value = line.slice(idx + 1).trim();
    if (value !== "") {
      return { start: i, end: i + 1, block: false, indent: "", tags: parseTagArray(value) };
    }
    // Block list: `- item` lines (blank and comment lines may sit between).
    const tags: string[] = [];
    let end = i + 1;
    let indent: string | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j] ?? "";
      const t = raw.trim();
      const m = BLOCK_ITEM.exec(raw);
      if (m) {
        indent ??= m[1] ?? "";
        const item = parseScalar(m[2] ?? "");
        if (item !== "") tags.push(item);
        end = j + 1;
      } else if (t !== "" && !t.startsWith("#")) {
        break;
      }
    }
    return { start: i, end, block: indent !== null, indent: indent ?? "  ", tags };
  }
  return null;
}

/** Returns the unique, order-preserving tag list from the front matter. */
export function getTagsFromContent(content: string): string[] {
  const { header, hasBlock } = split(content);
  if (!hasBlock) return [];
  return dedupe(findTags(headerLines(header))?.tags ?? []);
}

/**
 * Upsert the `tags` entry in the front matter, keeping its style: a
 * block list stays a block list (same item indent), a flow list stays
 * `tags: [...]`, and a new entry is written as a flow list. An empty
 * array removes the entry (and its items) entirely. If no front matter
 * exists and `tags` is non-empty, a fresh block is prepended.
 */
export function setTagsInContent(content: string, tags: readonly string[]): string {
  const unique = dedupe(tags);
  const { header, body, hasBlock, eol } = split(content);
  const flow = (): string[] =>
    unique.length === 0 ? [] : [`tags: [${unique.map(serializeTag).join(", ")}]`];

  if (!hasBlock) {
    if (unique.length === 0) return content;
    return `---\n${flow().join("\n")}\n---\n${content}`;
  }

  const lines = headerLines(header);
  const entry = findTags(lines);
  if (entry === null) return unique.length === 0 ? content : joinBlock([...lines, ...flow()], body, eol);
  const replacement =
    unique.length === 0
      ? []
      : entry.block
        ? ["tags:", ...unique.map((t) => `${entry.indent}- ${serializeTag(t)}`)]
        : flow();
  const rewritten = [...lines.slice(0, entry.start), ...replacement, ...lines.slice(entry.end)];
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

// ── Generic scalar fields (chat notes: model, title, …) ─────────────────

/** Raw scalar value of `key` in the front matter (quotes stripped), or null. */
export function getFrontMatterField(content: string, key: string): string | null {
  const { header, hasBlock } = split(content);
  if (!hasBlock) return null;
  for (const line of headerLines(header)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim() === key) {
      const value = stripQuotes(line.slice(idx + 1));
      return value === "" ? null : value;
    }
  }
  return null;
}

function yamlScalar(value: string): string {
  const needsQuotes =
    value === "" ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    /:\s|\s#|:$/.test(value) ||
    /\s$/.test(value) ||
    /^(true|false|null|yes|no|~)$/i.test(value);
  return needsQuotes ? JSON.stringify(value) : value;
}

/**
 * Upsert `key: value` (scalar, quoted only when YAML needs it) in the
 * front matter; `null` removes the line. `raw` writes the value verbatim
 * (numbers, booleans). Keeps the block's line endings; adds a fresh block
 * when there is none.
 */
export function setFrontMatterField(
  content: string,
  key: string,
  value: string | null,
  raw = false,
): string {
  const { header, body, hasBlock, eol } = split(content);
  const serialized =
    value === null ? null : `${key}: ${raw ? value : yamlScalar(value)}`;
  if (!hasBlock) {
    if (serialized === null) return content;
    return `---\n${serialized}\n---\n${content}`;
  }
  let found = false;
  const rewritten: string[] = [];
  for (const line of headerLines(header)) {
    const idx = line.indexOf(":");
    if (idx >= 0 && line.slice(0, idx).trim() === key) {
      found = true;
      if (serialized !== null) rewritten.push(serialized);
      continue;
    }
    rewritten.push(line);
  }
  if (!found && serialized !== null) rewritten.push(serialized);
  return joinBlock(rewritten, body, eol);
}

/** Replace the body after the front matter, keeping the block verbatim. */
export function replaceBody(content: string, body: string): string {
  const { offset } = splitFrontMatterBody(content);
  return content.slice(0, offset) + body;
}
