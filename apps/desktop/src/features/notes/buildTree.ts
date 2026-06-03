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
 * Build a folder tree rooted at `<vault>/notes/` from a flat list of
 * notes, plus an optional list of folder paths so **empty** folders
 * (which no note path would reveal) still appear. Entries that don't
 * start with `rootPath/` are skipped (defensive).
 */
export function buildTree(
  notes: readonly NoteMeta[],
  rootPath = "notes",
  dirs: readonly string[] = [],
): FolderNode {
  const root: FolderNode = {
    name: rootPath,
    path: rootPath,
    children: [],
    files: [],
  };

  // Walk/create the folder chain for `path` (a rootPath-relative folder
  // path like "notes/work/q1") and return the deepest node.
  const ensureFolder = (path: string): FolderNode => {
    const segments = path.split("/");
    let current = root;
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i] ?? "";
      if (segment === "") continue;
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
    return current;
  };

  for (const dir of dirs) {
    const segments = dir.split("/");
    if (segments.length < 2 || segments[0] !== rootPath) continue;
    ensureFolder(dir);
  }

  for (const note of notes) {
    const segments = note.relPath.split("/");
    if (segments.length < 2 || segments[0] !== rootPath) continue;
    const parentPath = segments.slice(0, segments.length - 1).join("/");
    ensureFolder(parentPath).files.push(note);
  }

  sortNode(root);
  return root;
}

function sortNode(node: FolderNode): void {
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.title.localeCompare(b.title));
  for (const child of node.children) sortNode(child);
}
