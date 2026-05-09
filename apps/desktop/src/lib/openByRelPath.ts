import { journalOpen } from "./api/journal";
import { notesRead } from "./api/notes";
import { useEditorStore } from "../state/editorStore";

const JOURNAL_PATTERN = /^journal\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * Generic open: dispatches to `journal_open` for paths that match the
 * canonical `journal/YYYY/MM/YYYY-MM-DD.md` shape, otherwise falls through
 * to `notes_read`. Used where the source kind isn't known up front (e.g.
 * tag results, search hits).
 */
export async function openByRelPath(relPath: string): Promise<void> {
  const journalMatch = JOURNAL_PATTERN.exec(relPath);
  if (journalMatch !== null) {
    const date = journalMatch[1]!;
    const result = await journalOpen(date);
    useEditorStore.getState().openJournal(date, relPath, result.content);
    return;
  }
  const content = await notesRead(relPath);
  useEditorStore.getState().openNote(relPath, content);
}
