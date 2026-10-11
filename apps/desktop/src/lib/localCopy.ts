/**
 * Where local edits go when they can't be written to their own file: the
 * document changed (or vanished) on disk while the user was typing and
 * they chose "Save mine as copy" — or moved off the document without
 * choosing (lib/externalChange, state/autosave).
 *
 * `notes/ideas.md` → `notes/ideas.local-20260511-093012.md`; a journal
 * entry gets the same sibling under `journal/<y>/<m>/`. The copy is an
 * ordinary note next to the original, so every list and search finds it.
 */
export function localCopyRelPath(
  relPath: string,
  now: Date = new Date(),
): string {
  const slash = relPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : relPath.slice(0, slash + 1);
  const file = relPath.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${dir}${stem}.local-${timestamp(now)}.md`;
}

function timestamp(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}
