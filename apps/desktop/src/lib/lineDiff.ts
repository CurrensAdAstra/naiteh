/**
 * Line diff (LCS) for the backup compare view. Pure; no dependencies.
 * Common prefix/suffix are trimmed first; if the remaining middle is too
 * large for the O(n*m) table it is reported as a block replacement.
 */

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-based line number in the old (left) text; absent for `add`. */
  oldLine?: number;
  /** 1-based line number in the new (right) text; absent for `del`. */
  newLine?: number;
}

/** Cell budget for the LCS table (4M cells = 16 MB of Uint32). */
const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const out: DiffLine[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out.push({
      kind: "same",
      text: a[start]!,
      oldLine: start + 1,
      newLine: start + 1,
    });
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const n = endA - start;
  const m = endB - start;
  const pushDel = (i: number) =>
    out.push({ kind: "del", text: a[i]!, oldLine: i + 1 });
  const pushAdd = (j: number) =>
    out.push({ kind: "add", text: b[j]!, newLine: j + 1 });

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    for (let i = start; i < endA; i += 1) pushDel(i);
    for (let j = start; j < endB; j += 1) pushAdd(j);
  } else {
    // lcs[i*w+j] = LCS length of a[start+i..endA) and b[start+j..endB).
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * w + j] =
          a[start + i] === b[start + j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({
          kind: "same",
          text: a[start + i]!,
          oldLine: start + i + 1,
          newLine: start + j + 1,
        });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        pushDel(start + i);
        i += 1;
      } else {
        pushAdd(start + j);
        j += 1;
      }
    }
    for (; i < n; i += 1) pushDel(start + i);
    for (; j < m; j += 1) pushAdd(start + j);
  }

  for (let k = 0; k < a.length - endA; k += 1) {
    out.push({
      kind: "same",
      text: a[endA + k]!,
      oldLine: endA + k + 1,
      newLine: endB + k + 1,
    });
  }
  return out;
}

export function diffStats(lines: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "add") added += 1;
    else if (l.kind === "del") removed += 1;
  }
  return { added, removed };
}
