/**
 * Count words in a Markdown document body. Front matter (the leading
 * `---\n…\n---\n` block) is excluded so the count reflects what the
 * user thinks of as "the writing".
 *
 * Words are runs of non-whitespace characters, which is good enough for
 * Latin scripts and produces a reasonable count for CJK (each glyph
 * counts when separated by whitespace; CJK without spaces is treated as
 * a single "word" — better than nothing, refined later if needed).
 */
export function countWords(text: string): number {
  let body = text;
  if (body.startsWith("---\n")) {
    const close = body.indexOf("\n---\n", "---\n".length);
    if (close !== -1) {
      body = body.slice(close + "\n---\n".length);
    }
  }
  const tokens = body.match(/\S+/g);
  return tokens === null ? 0 : tokens.length;
}
