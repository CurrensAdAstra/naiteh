/**
 * Canonical vault-relative location of a journal entry:
 * `journal/YYYY/MM/YYYY-MM-DD.md`. The single source of truth for that
 * shape on the frontend — everything that builds or parses a journal
 * path goes through here.
 */
export function journalRelPathFor(date: string): string {
  return `journal/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
}

const JOURNAL_PATTERN = /^journal\/(\d{4})\/(\d{2})\/((\d{4})-(\d{2})-\d{2})\.md$/;

/**
 * Inverse of {@link journalRelPathFor}: the entry's date when `relPath`
 * is a canonical journal path (year/month folders matching the date),
 * otherwise null.
 */
export function journalDateFromRelPath(relPath: string): string | null {
  const m = JOURNAL_PATTERN.exec(relPath);
  if (m === null) return null;
  const [, folderYear, folderMonth, date, year, month] = m;
  if (folderYear !== year || folderMonth !== month) return null;
  return date ?? null;
}
