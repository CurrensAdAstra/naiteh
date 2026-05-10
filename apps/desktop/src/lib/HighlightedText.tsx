import { Fragment } from "react";

interface HighlightedTextProps {
  text: string;
  /** Substring to highlight (case-insensitive). Empty string disables. */
  query: string;
}

/**
 * Render `text` with every case-insensitive occurrence of `query` wrapped
 * in a `<mark>` element. Safe against XSS — we never put user input into
 * `dangerouslySetInnerHTML`; React escapes the strings as text.
 */
export function HighlightedText({ text, query }: HighlightedTextProps) {
  const needle = query.trim();
  if (needle === "") return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const segments: { kind: "plain" | "match"; value: string }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerNeedle, cursor);
    if (idx === -1) {
      segments.push({ kind: "plain", value: text.slice(cursor) });
      break;
    }
    if (idx > cursor) {
      segments.push({ kind: "plain", value: text.slice(cursor, idx) });
    }
    segments.push({
      kind: "match",
      value: text.slice(idx, idx + needle.length),
    });
    cursor = idx + needle.length;
  }
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "match" ? (
          <mark key={i}>{segment.value}</mark>
        ) : (
          <Fragment key={i}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
}
