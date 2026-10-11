//! Dependency-free HTML → Markdown conversion for clipping / pasting
//! rich HTML into the editor. Options come from `AppConfig.clipping`
//! (see vault/wiki app-config page, "Clipping").
//!
//! Pipeline: parse with `DOMParser` → strip unsafe / invisible nodes →
//! walk the tree producing Markdown blocks (paragraphs, headings, lists,
//! code, quotes, tables) whose inline content is collapsed like a browser
//! would and escaped so literal text never turns into formatting.

import type { ClippingConfig } from "./types";

/** Elements dropped together with their content before conversion. */
const REMOVE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "meta",
  "link",
  "base",
  "template",
  "title",
  "svg",
  "canvas",
  "audio",
  "video",
  "button",
  "select",
  "textarea",
  "dialog",
].join(",");

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "center",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).join(",");

/** Attributes whose value is a URL that could carry `javascript:`. */
const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "xlink:href",
  "poster",
  "background",
  "data",
  "cite",
]);

/** Attributes kept on a table emitted as HTML (`tables: "html"`). */
const TABLE_ATTRS = new Set([
  "colspan",
  "rowspan",
  "align",
  "href",
  "src",
  "alt",
  "title",
]);

/** Hard line break sentinel used while assembling inline content. */
const BR = "\uE000";

interface LinkRef {
  dest: string;
  title: string;
}

interface Ctx {
  opts: ClippingConfig;
  refs: LinkRef[];
  strong: boolean;
  em: boolean;
  del: boolean;
}

interface Block {
  kind: "p" | "list" | "other";
  text: string;
}

// ── public API ────────────────────────────────────────────────────────

/** Convert an HTML fragment / document to Markdown using `opts`. */
export function htmlToMarkdown(html: string, opts: ClippingConfig): string {
  return convertBody(parseClean(html), opts);
}

/**
 * HTML with scripts, styles, hidden nodes, comments, event-handler
 * attributes and `javascript:` URLs removed — the "Keep raw HTML" mode.
 */
export function sanitizeHtml(html: string): string {
  const body = parseClean(html);
  scrubAttributes(body, null);
  return tidyHtml(body.innerHTML);
}

/**
 * Decide what a paste should insert. Returns the text to insert, or
 * `null` to let CodeMirror's default (text/plain) paste run: HTML paste
 * disabled, no `text/html` flavour, or HTML that is only a wrapper around
 * plain text (no formatting worth converting).
 */
export function clipboardToText(
  data: DataTransfer,
  opts: ClippingConfig,
): string | null {
  if (opts.htmlPaste === "plain") return null;
  const html = data.getData("text/html");
  if (html.trim() === "") return null;
  if (opts.htmlPaste === "html") {
    const raw = sanitizeHtml(html);
    return raw === "" ? null : raw;
  }
  const body = parseClean(html);
  if (!hasFormatting(body)) return null;
  const md = convertBody(body, opts);
  return md === "" ? null : md;
}

/** True when the HTML carries structure / formatting beyond plain text. */
export function htmlHasFormatting(html: string): boolean {
  return hasFormatting(parseClean(html));
}

// ── parsing & cleaning ────────────────────────────────────────────────

/** Strip the Windows CF_HTML header ("Version:0.9\r\nStartHTML:…"). */
function stripClipboardHeader(html: string): string {
  if (!/^Version:\d/.test(html)) return html;
  const i = html.indexOf("<");
  return i < 0 ? "" : html.slice(i);
}

function parseClean(html: string): HTMLElement {
  const src = stripClipboardHeader(html).replace(/\uE000/g, "");
  const doc = new DOMParser().parseFromString(src, "text/html");
  const body = doc.body;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    comments.push(n);
  }
  for (const c of comments) c.parentNode?.removeChild(c);
  for (const el of Array.from(body.querySelectorAll(REMOVE_SELECTOR))) {
    el.remove();
  }
  for (const el of Array.from(body.querySelectorAll("*"))) {
    if (el.isConnected && isHidden(el)) el.remove();
  }
  return body;
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const display = styleProp(el, "display");
  const visibility = styleProp(el, "visibility");
  return display === "none" || visibility === "hidden";
}

/** One declaration from an inline `style` attribute, lowercased. */
function styleProp(el: Element, prop: string): string | null {
  const style = el.getAttribute("style");
  if (style === null) return null;
  let found: string | null = null;
  for (const decl of style.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    if (decl.slice(0, i).trim().toLowerCase() === prop) {
      found = decl
        .slice(i + 1)
        .trim()
        .toLowerCase()
        .replace(/\s*!important$/, "");
    }
  }
  return found;
}

/** true = bold, false = explicitly not bold, null = unspecified. */
function boldWeight(el: Element): boolean | null {
  const v = styleProp(el, "font-weight");
  if (v === null || v === "") return null;
  if (v === "bold" || v === "bolder") return true;
  if (v === "normal" || v === "lighter") return false;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n >= 600;
}

function isDangerousUrl(value: string): boolean {
  // Browsers ignore control chars / whitespace inside the scheme.
  const v = Array.from(value)
    .filter((c) => c.charCodeAt(0) > 0x20)
    .join("")
    .toLowerCase();
  return /^(javascript|vbscript|data):/.test(v) && !/^data:image\//.test(v);
}

function scrubAttributes(root: Element, allow: Set<string> | null): void {
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        (URL_ATTRS.has(name) && isDangerousUrl(attr.value)) ||
        (allow !== null && !allow.has(name))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/** Drop blank lines (they would end a Markdown HTML block) and trim. */
function tidyHtml(html: string): string {
  return html.replace(/\r\n?/g, "\n").replace(/\n[ \t]*(?=\n)/g, "").trim();
}

function hasFormatting(body: HTMLElement): boolean {
  for (const el of Array.from(body.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "em":
      case "i":
      case "del":
      case "s":
      case "strike":
      case "img":
      case "ul":
      case "ol":
      case "table":
      case "pre":
      case "code":
      case "kbd":
      case "blockquote":
      case "hr":
      case "sup":
      case "sub":
        return true;
      case "strong":
      case "b":
        if (boldWeight(el) !== false) return true;
        break;
      case "a": {
        const href = el.getAttribute("href");
        if (href !== null && href.trim() !== "" && !isDangerousUrl(href)) {
          return true;
        }
        break;
      }
      default:
        if (spanFormatting(el, tag).any) return true;
    }
  }
  return false;
}

// ── conversion ────────────────────────────────────────────────────────

function convertBody(body: HTMLElement, opts: ClippingConfig): string {
  const ctx: Ctx = { opts, refs: [], strong: false, em: false, del: false };
  let md = joinBlocks(blocks(body, ctx));
  if (ctx.refs.length > 0 && md !== "") {
    md +=
      "\n\n" +
      ctx.refs
        .map((r, i) => `[${i + 1}]: ${r.dest}${titlePart(r.title)}`)
        .join("\n");
  }
  return md.replace(/^\n+/, "").replace(/\s+$/, "");
}

function joinBlocks(bs: Block[]): string {
  return bs
    .map((b) => b.text)
    .filter((t) => t !== "")
    .join("\n\n");
}

function isElement(n: Node): n is Element {
  return n.nodeType === Node.ELEMENT_NODE;
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

/** Convert the children of `parent` into Markdown blocks. */
function blocks(parent: Node, ctx: Ctx): Block[] {
  const out: Block[] = [];
  let buf = "";
  const flush = () => {
    const text = finishInline(buf, "block");
    buf = "";
    if (text !== "") out.push({ kind: "p", text });
  };
  for (const child of Array.from(parent.childNodes)) {
    if (!isElement(child)) {
      if (child.nodeType === Node.TEXT_NODE) buf += inlineNode(child, ctx);
      continue;
    }
    const tag = tagOf(child);
    if (BLOCK_TAGS.has(tag)) {
      flush();
      out.push(...blockElement(child, tag, ctx));
    } else if (tag !== "a" && child.querySelector(BLOCK_SELECTOR) !== null) {
      // An inline wrapper around blocks (e.g. Google Docs'
      // `<b id="docs-internal-guid-…">`) is a transparent container.
      flush();
      out.push(...blocks(child, ctx));
    } else {
      buf += inlineNode(child, ctx);
    }
  }
  flush();
  return out;
}

function blockElement(el: Element, tag: string, ctx: Ctx): Block[] {
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return heading(el, Number(tag[1]), ctx);
    case "hr":
      return [{ kind: "other", text: "---" }];
    case "pre":
      return codeBlock(el, ctx);
    case "blockquote": {
      const inner = joinBlocks(blocks(el, ctx));
      if (inner === "") return [];
      const text = inner
        .split("\n")
        .map((l) => (l === "" ? ">" : `> ${l}`))
        .join("\n");
      return [{ kind: "other", text }];
    }
    case "ul":
    case "ol":
      return list(el, tag === "ol", ctx);
    case "table":
      return table(el as HTMLTableElement, ctx);
    default:
      return blocks(el, ctx);
  }
}

function heading(el: Element, level: number, ctx: Ctx): Block[] {
  // Headings are bold already; don't double-wrap styled spans inside.
  const inner = inlineChildren(el, { ...ctx, strong: true });
  let text = finishInline(inner, "heading");
  if (text === "") return [];
  if (ctx.opts.headingStyle === "setext" && level <= 2) {
    const ch = level === 1 ? "=" : "-";
    return [
      {
        kind: "other",
        text: `${text}\n${ch.repeat(Math.max(3, text.length))}`,
      },
    ];
  }
  // A trailing run of `#` would read as the optional closing sequence.
  text = text.replace(/(\s)(#+)$/, "$1\\$2");
  return [{ kind: "other", text: `${"#".repeat(level)} ${text}` }];
}

function codeBlock(pre: Element, ctx: Ctx): Block[] {
  for (const br of Array.from(pre.querySelectorAll("br"))) {
    br.replaceWith("\n");
  }
  const text = (pre.textContent ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^\n/, "")
    .replace(/\n+$/, "");
  if (text.trim() === "") return [];
  if (ctx.opts.codeBlockStyle === "indented") {
    return [
      {
        kind: "other",
        text: text
          .split("\n")
          .map((l) => (l === "" ? "" : `    ${l}`))
          .join("\n"),
      },
    ];
  }
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) {
    longest = Math.max(longest, m[0].length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  const lang = codeLanguage(pre);
  return [{ kind: "other", text: `${fence}${lang}\n${text}\n${fence}` }];
}

function codeLanguage(pre: Element): string {
  const code = pre.querySelector("code");
  for (const el of code !== null ? [pre, code] : [pre]) {
    const m = /(?:^|\s)(?:language|lang)-([^\s]+)/i.exec(
      el.getAttribute("class") ?? "",
    );
    if (m?.[1] !== undefined) return m[1].replace(/[`~]/g, "");
    const data = el.getAttribute("data-lang") ?? el.getAttribute("data-language");
    if (data !== null && /^[\w+#.-]+$/.test(data)) return data;
  }
  return "";
}

// ── lists ─────────────────────────────────────────────────────────────

function list(el: Element, ordered: boolean, ctx: Ctx): Block[] {
  const startAttr = Number.parseInt(el.getAttribute("start") ?? "1", 10);
  let n = Number.isNaN(startAttr) ? 1 : startAttr;
  const items: string[] = [];
  let lastPad = "";
  for (const child of Array.from(el.childNodes)) {
    if (!isElement(child)) continue;
    const tag = tagOf(child);
    if (tag === "ul" || tag === "ol") {
      // Invalid but common: a nested list directly inside the list.
      const nested = joinBlocks(list(child, tag === "ol", ctx));
      if (nested === "") continue;
      if (items.length > 0) {
        items[items.length - 1] += `\n${indent(nested, lastPad)}`;
      } else {
        items.push(nested);
      }
      continue;
    }
    const marker = ordered ? `${n}.` : ctx.opts.bulletMarker;
    if (ordered) n += 1;
    lastPad = " ".repeat(marker.length + 1);
    items.push(listItem(child, marker, ctx));
  }
  return items.length === 0 ? [] : [{ kind: "list", text: items.join("\n") }];
}

function listItem(li: Element, marker: string, ctx: Ctx): string {
  const checked = takeCheckbox(li);
  const bs = blocks(li, ctx);
  let body = "";
  bs.forEach((b, i) => {
    if (i === 0) body = b.text;
    else body += (b.kind === "list" ? "\n" : "\n\n") + b.text;
  });
  if (checked !== null) body = `[${checked ? "x" : " "}] ${body}`.trimEnd();
  if (body === "") return marker;
  const pad = " ".repeat(marker.length + 1);
  const [first, ...rest] = body.split("\n");
  return [`${marker} ${first}`, ...rest.map((l) => (l === "" ? "" : pad + l))].join(
    "\n",
  );
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => (l === "" ? "" : pad + l))
    .join("\n");
}

/**
 * Detach a leading task-list checkbox from `li`; returns its state, or
 * null when the item doesn't start with one.
 */
function takeCheckbox(li: Element): boolean | null {
  const walker = li.ownerDocument.createTreeWalker(
    li,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if (!isElement(n)) {
      if ((n.textContent ?? "").trim() !== "") return null;
      continue;
    }
    const tag = tagOf(n);
    if (tag === "ul" || tag === "ol") return null;
    if (tag === "input") {
      if ((n.getAttribute("type") ?? "").toLowerCase() !== "checkbox") {
        return null;
      }
      const checked = n.hasAttribute("checked");
      n.remove();
      return checked;
    }
  }
  return null;
}

// ── tables ────────────────────────────────────────────────────────────

function table(el: HTMLTableElement, ctx: Ctx): Block[] {
  const rows = Array.from(el.rows);
  const firstRow = rows[0];
  if (firstRow === undefined) return [];
  // A single-cell table is layout, not data.
  const onlyCell = firstRow.cells[0];
  if (rows.length === 1 && firstRow.cells.length === 1 && onlyCell !== undefined) {
    return blocks(onlyCell, ctx);
  }
  const mode = ctx.opts.tables;
  if (mode === "html") {
    const clone = el.cloneNode(true) as Element;
    scrubAttributes(clone, TABLE_ATTRS);
    return [{ kind: "other", text: tidyHtml(clone.outerHTML) }];
  }
  if (mode === "text") {
    const lines = rows
      .map((r) =>
        Array.from(r.cells)
          .map((c) => finishInline(inlineChildren(c, ctx), "heading"))
          .filter((t) => t !== "")
          .join(" · "),
      )
      .filter((l) => l !== "")
      .map(escapeLineStart);
    return lines.length === 0 ? [] : [{ kind: "other", text: lines.join("\n") }];
  }

  const headerRow = el.tHead?.rows[0] ?? firstRow;
  const ordered = [headerRow, ...rows.filter((r) => r !== headerRow)];
  const matrix = ordered.map((r) => {
    const cells: string[] = [];
    for (const c of Array.from(r.cells)) {
      cells.push(
        finishInline(inlineChildren(c, ctx), "cell").replace(/\|/g, "\\|"),
      );
      const span = Number.parseInt(c.getAttribute("colspan") ?? "1", 10);
      for (let i = 1; i < Math.min(Number.isNaN(span) ? 1 : span, 100); i++) {
        cells.push("");
      }
    }
    return cells;
  });
  const cols = Math.max(...matrix.map((r) => r.length));
  if (cols === 0) return [];
  for (const r of matrix) while (r.length < cols) r.push("");
  const aligns: string[] = [];
  const headerCells = Array.from(headerRow.cells);
  for (let i = 0; i < cols; i++) {
    const c = headerCells[i];
    aligns.push(
      c === undefined
        ? ""
        : (c.getAttribute("align") ?? styleProp(c, "text-align") ?? "").toLowerCase(),
    );
  }
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(3, ...matrix.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 3)).join(" | ")} |`;
  const sep = `| ${widths
    .map((w, i) => {
      const a = aligns[i];
      if (a === "center") return `:${"-".repeat(w - 2)}:`;
      if (a === "right") return `${"-".repeat(w - 1)}:`;
      if (a === "left") return `:${"-".repeat(w - 1)}`;
      return "-".repeat(w);
    })
    .join(" | ")} |`;
  const text = [line(matrix[0] ?? []), sep, ...matrix.slice(1).map(line)];
  return [{ kind: "other", text: text.join("\n") }];
}

// ── inline content ────────────────────────────────────────────────────

function inlineChildren(el: Node, ctx: Ctx): string {
  let out = "";
  for (const child of Array.from(el.childNodes)) out += inlineNode(child, ctx);
  return out;
}

function collapse(text: string): string {
  return text.replace(/[ \t\n\r\f\u00a0]+/g, " ");
}

function inlineNode(node: Node, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(collapse(node.textContent ?? ""));
  }
  if (!isElement(node)) return "";
  const el = node;
  const tag = tagOf(el);
  switch (tag) {
    case "br":
      return BR;
    case "img":
      return image(el, ctx);
    case "a":
      return link(el, ctx);
    case "code":
    case "kbd":
    case "samp":
    case "tt":
    case "pre":
      return codeSpan(collapse(el.textContent ?? ""));
    case "input":
      return "";
    case "sup":
    case "sub": {
      const inner = inlineChildren(el, ctx).trim();
      return inner === "" ? "" : `<${tag}>${inner}</${tag}>`;
    }
    case "hr":
      return BR;
    default:
      break;
  }
  if (BLOCK_TAGS.has(tag)) {
    // Block inside inline context (e.g. a card link wrapping divs).
    return BR + inlineChildren(el, ctx) + BR;
  }

  let strong = false;
  let em = false;
  let del = false;
  if (tag === "strong" || tag === "b") {
    strong = boldWeight(el) !== false;
  } else if (tag === "em" || tag === "i" || tag === "cite" || tag === "dfn") {
    em = styleProp(el, "font-style") !== "normal";
  } else if (tag === "del" || tag === "s" || tag === "strike") {
    del = true;
  }
  const styled = spanFormatting(el, tag);
  strong = strong || styled.strong;
  em = em || styled.em;
  del = del || styled.del;
  strong = strong && !ctx.strong;
  em = em && !ctx.em;
  del = del && !ctx.del;

  const inner = inlineChildren(el, {
    ...ctx,
    strong: ctx.strong || strong,
    em: ctx.em || em,
    del: ctx.del || del,
  });
  let out = inner;
  if (em) out = wrap(out, ctx.opts.emphasis);
  if (strong) out = wrap(out, ctx.opts.strong);
  if (del) out = wrap(out, "~~");
  return out;
}

/** Bold / italic / strike-through expressed via inline `style`. */
function spanFormatting(
  el: Element,
  tag: string,
): { strong: boolean; em: boolean; del: boolean; any: boolean } {
  if (tag !== "span" && tag !== "font") {
    return { strong: false, em: false, del: false, any: false };
  }
  const strong = boldWeight(el) === true;
  const style = styleProp(el, "font-style");
  const em = style === "italic" || style === "oblique";
  const deco = `${styleProp(el, "text-decoration") ?? ""} ${
    styleProp(el, "text-decoration-line") ?? ""
  }`;
  const del = deco.includes("line-through");
  return { strong, em, del, any: strong || em || del };
}

/** Wrap with `marker`, keeping edge whitespace / breaks outside it. */
function wrap(inner: string, marker: string): string {
  const m = /^([ \uE000]*)([\s\S]*?)([ \uE000]*)$/.exec(inner);
  if (m === null || m[2] === "") return inner;
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`;
}

function codeSpan(text: string): string {
  if (text === "") return "";
  const runs = new Set<number>();
  for (const m of text.matchAll(/`+/g)) runs.add(m[0].length);
  let n = 1;
  while (runs.has(n)) n++;
  const fence = "`".repeat(n);
  const pad =
    text.startsWith("`") ||
    text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "")
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function formatDest(url: string): string {
  return url
    .replace(/[\r\n]/g, "")
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

function titlePart(title: string): string {
  return title === "" ? "" : ` "${title.replace(/["\\]/g, "\\$&")}"`;
}

function link(el: Element, ctx: Ctx): string {
  const inner = inlineChildren(el, ctx);
  const href = (el.getAttribute("href") ?? "").trim();
  if (href === "" || isDangerousUrl(href) || /^data:/i.test(href)) return inner;
  const m = /^([ \uE000]*)([\s\S]*?)([ \uE000]*)$/.exec(inner);
  const text = m?.[2] ?? "";
  if (text === "") return inner;
  const lead = m?.[1] ?? "";
  const trail = m?.[3] ?? "";
  const title = collapse(el.getAttribute("title") ?? "").trim();
  const dest = formatDest(href);
  if (ctx.opts.linkStyle === "reference") {
    let idx = ctx.refs.findIndex((r) => r.dest === dest && r.title === title);
    if (idx < 0) {
      ctx.refs.push({ dest, title });
      idx = ctx.refs.length - 1;
    }
    return `${lead}[${text}][${idx + 1}]${trail}`;
  }
  if (
    title === "" &&
    /^(https?:|mailto:)/i.test(href) &&
    collapse(el.textContent ?? "").trim() === href &&
    !/[\s<>]/.test(href)
  ) {
    return `${lead}<${href}>${trail}`;
  }
  return `${lead}[${text}](${dest}${titlePart(title)})${trail}`;
}

function image(el: Element, ctx: Ctx): string {
  if (ctx.opts.images === "drop") return "";
  const src = (el.getAttribute("src") ?? el.getAttribute("data-src") ?? "").trim();
  if (src === "" || isDangerousUrl(src)) return "";
  const alt = collapse(el.getAttribute("alt") ?? "")
    .trim()
    .replace(/[\\[\]]/g, "\\$&");
  const title = collapse(el.getAttribute("title") ?? "").trim();
  return `![${alt}](${formatDest(src)}${titlePart(title)})`;
}

// ── escaping & finishing ──────────────────────────────────────────────

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Escape characters that would otherwise start inline formatting. */
export function escapeText(text: string): string {
  return text
    .replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\")
    .replace(/[*`[\]]/g, "\\$&")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/_/g, (_m, off: number, str: string) =>
      WORD_CHAR.test(str[off - 1] ?? "") && WORD_CHAR.test(str[off + 1] ?? "")
        ? "_"
        : "\\_",
    );
}

/** Escape what would start a block construct at the beginning of a line. */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(#{1,6})(?=\s|$)/, "\\$1")
    .replace(/^>/, "\\>")
    .replace(/^([-+])(?=\s|$)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2")
    .replace(/^([=-]+\s*)$/, "\\$1")
    .replace(/^~~~/, "\\~~~");
}

/**
 * Normalise assembled inline content: collapse spaces, trim around
 * breaks, then render breaks for the target (`\` hard break in a block,
 * `<br>` in a table cell, a space in a heading).
 */
function finishInline(s: string, target: "block" | "cell" | "heading"): string {
  const t = s
    .replace(/ {2,}/g, " ")
    .replace(/ *\uE000[ \uE000]*/g, BR)
    .replace(/^[ \uE000]+|[ \uE000]+$/g, "");
  if (t === "") return "";
  if (target === "cell") return t.replace(/\uE000/g, "<br>");
  if (target === "heading") return escapeLineStart(t.replace(/\uE000/g, " "));
  return t.split(BR).map(escapeLineStart).join("\\\n");
}
