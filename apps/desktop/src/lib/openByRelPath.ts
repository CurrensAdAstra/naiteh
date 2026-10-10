import { openDocument, targetForRelPath } from "./openDocument";

/**
 * Generic open: dispatches to `journal_open` for paths that match the
 * canonical `journal/YYYY/MM/YYYY-MM-DD.md` shape, otherwise falls through
 * to `notes_read`. Used where the source kind isn't known up front (e.g.
 * tag results, search hits).
 *
 * Thin wrapper over {@link openDocument}, so it shares its flush-first and
 * latest-request-wins semantics. Resolves without opening anything when a
 * newer open request superseded this one.
 */
export async function openByRelPath(relPath: string): Promise<void> {
  await openDocument(targetForRelPath(relPath));
}
