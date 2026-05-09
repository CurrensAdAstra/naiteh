import type { NoteMeta } from "../../lib/types";

export interface FolderNode {
  /** Display name (last path segment). */
  name: string;
  /** Vault-relative path of this folder, e.g. "notes/work". */
  path: string;
  children: FolderNode[];
  files: NoteMeta[];
}

/**
 * Build a folder tree rooted at `<vault>/notes/` from a flat list of notes.
 * Notes whose `relPath` does not start with `notes/` are skipped (defensive).
 */
export function buildTree(notes: readonly NoteMeta[], rootPath = "notes"): FolderNode {
  const root: FolderNode = {
    name: rootPath,
    path: rootPath,
    children: [],
    files: [],
  };
  for (const note of notes) {
    const segments = note.relPath.split("/");
    if (segments.length < 2 || segments[0] !== rootPath) continue;
    let current = root;
    for (let i = 1; i < segments.length - 1; i++) {
      const segment = segments[i] ?? "";
      let child = current.children.find((c) => c.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: segments.slice(0, i + 1).join("/"),
          children: [],
          files: [],
        };
        current.children.push(child);
      }
      current = child;
    }
    current.files.push(note);
  }
  sortNode(root);
  return root;
}

function sortNode(node: FolderNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.title.localeCompare(b.title));
  for (const child of node.children) sortNode(child);
}
