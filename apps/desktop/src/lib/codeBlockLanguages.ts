//! Code-block syntax highlighting — a self-contained CodeMirror plugin
//! module, same pattern as `markdownKeymap` and `editorAttachmentDrop`.
//!
//! Fenced code blocks in Markdown (```python … ```) get per-language
//! highlighting by handing the Markdown parser a language registry:
//! `markdown({ codeLanguages })`. The registry is
//! `@codemirror/language-data`, which knows 100+ languages/aliases
//! (python, rust, ts/js, go, sql, bash, json, yaml, html/css, …) and
//! **lazy-loads** each language's parser on first use via dynamic
//! import — Vite code-splits them, so unused grammars never ship in the
//! initial bundle and an unopened language costs nothing at runtime.
//!
//! Token colors come from the `defaultHighlightStyle` that `basicSetup`
//! already installs; this module only supplies the nested parsers.

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

/** The full language-data registry; exported so tests can probe coverage. */
export const codeBlockLanguages: readonly LanguageDescription[] = languages;

/**
 * Resolve a fence info string (the word after ```) to a language
 * description. Passed directly as `markdown({ codeLanguages })`, so this
 * function IS the fence-resolution behaviour, not an approximation of it.
 *
 * Matching is deliberately not fuzzy — fuzzy mode substring-matches
 * aliases and turns nonsense like `definitely-not-a-language` into INI.
 * Instead: exact name/alias match first (`js`, `ts`, `c++`, …), then an
 * extension fallback so extension-style infos (`py`, `rs`, `kt`) work
 * too. Unknown languages return null and the block renders as plain
 * text, exactly like before this plugin existed.
 */
export function resolveFenceLanguage(
  info: string,
): LanguageDescription | null {
  const name = info.trim();
  if (name === "") return null;
  const descs = codeBlockLanguages as LanguageDescription[];
  const exact = LanguageDescription.matchLanguageName(descs, name, false);
  if (exact !== null) return exact;
  return LanguageDescription.matchFilename(descs, `file.${name}`);
}
