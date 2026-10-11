//! CodeMirror 6 syntax highlighting driven by the theme tokens.
//!
//! basicSetup ships `defaultHighlightStyle` (fixed light-theme colors) as a
//! fallback; this style takes precedence and colors everything through the
//! CSS custom properties in styles/tokens.css, so the active palette
//! (styles/palettes.ts, including the dark ones) recolors the editor too.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const accent = "var(--color-accent)";
const muted = "var(--color-text-muted)";
const secondary = "var(--color-text-secondary)";
const success = "var(--color-success)";
const warning = "var(--color-warning)";
const danger = "var(--color-danger)";

export const tokenHighlightStyle = HighlightStyle.define([
  // Markdown
  { tag: t.heading, fontWeight: "bold", color: accent },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: accent, textDecoration: "underline" },
  { tag: t.url, color: accent },
  { tag: t.quote, color: secondary, fontStyle: "italic" },
  { tag: t.monospace, color: warning },
  { tag: [t.processingInstruction, t.contentSeparator], color: muted },
  { tag: t.meta, color: muted },
  // Code (fenced blocks)
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: accent },
  { tag: [t.string, t.special(t.string), t.regexp], color: success },
  { tag: [t.number, t.bool, t.null, t.atom], color: warning },
  { tag: [t.comment, t.lineComment, t.blockComment], color: muted, fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: warning },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: accent },
  { tag: [t.definition(t.variableName), t.propertyName, t.attributeName], color: secondary },
  { tag: [t.tagName, t.angleBracket], color: danger },
  { tag: t.invalid, color: danger },
]);

export function editorHighlight() {
  return syntaxHighlighting(tokenHighlightStyle);
}
