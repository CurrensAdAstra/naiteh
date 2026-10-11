/**
 * How the Markdown viewer resolves links and image sources.
 *
 * Paths in a note can be written two ways, and both occur in real vaults:
 *   - note-relative (`photo.png`, `../other.md`) — standard Markdown, and
 *     what the Evernote importer writes (attachments sit next to the note);
 *   - vault-relative (`attachments/photo.png`, `notes/other.md`) — what
 *     naiteh's own attachment import inserts.
 * So a local path yields up to two vault-relative *candidates*, tried in
 * that order. A leading `/` means "from the vault root" only.
 */

const EXTERNAL_LINK = /^(https?:|mailto:)/i;
const REMOTE_IMAGE = /^https?:/i;
const DATA_IMAGE = /^data:image\//i;
// Any other `scheme:` (javascript:, file:, vbscript:, a Windows drive
// `C:`) is never followed from a note.
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "document"; candidates: string[] }
  | { kind: "file"; candidates: string[] }
  | { kind: "blocked" };

export type ImageSource =
  | { kind: "data"; url: string }
  | { kind: "remote"; url: string }
  | { kind: "vault"; candidates: string[] }
  | { kind: "blocked" };

/** Directory part of a vault-relative path (`notes/a/b.md` → `notes/a`). */
export function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i < 0 ? "" : relPath.slice(0, i);
}

/**
 * Lexically normalize a vault-relative path: collapse `.`, `..`, empty
 * segments and backslashes. `null` when it is empty or climbs above the
 * vault root. (The backend re-checks containment on every read.)
 */
export function normalizeRelPath(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.length === 0 ? null : out.join("/");
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Vault-relative candidates for a local path written in `docRelPath`. */
export function candidatePaths(
  docRelPath: string | null,
  target: string,
): string[] {
  const path = decodePath(target.trim());
  if (path === "") return [];
  if (path.startsWith("/")) {
    const rooted = normalizeRelPath(path);
    return rooted === null ? [] : [rooted];
  }
  const found: string[] = [];
  const add = (p: string | null) => {
    if (p !== null && !found.includes(p)) found.push(p);
  };
  if (docRelPath !== null) add(normalizeRelPath(`${dirOf(docRelPath)}/${path}`));
  add(normalizeRelPath(path));
  return found;
}

function stripSuffix(href: string): string {
  const cut = href.search(/[?#]/);
  return cut < 0 ? href : href.slice(0, cut);
}

/** Decide what clicking `href` inside the document at `docRelPath` does. */
export function classifyLink(
  href: string | undefined,
  docRelPath: string | null,
): LinkTarget {
  const raw = (href ?? "").trim();
  if (raw === "") return { kind: "blocked" };
  if (raw.startsWith("#")) {
    return { kind: "anchor", id: decodePath(raw.slice(1)) };
  }
  if (EXTERNAL_LINK.test(raw)) return { kind: "external", url: raw };
  if (HAS_SCHEME.test(raw)) return { kind: "blocked" };
  const candidates = candidatePaths(docRelPath, stripSuffix(raw));
  const first = candidates[0];
  if (first === undefined) return { kind: "blocked" };
  return /\.md$/i.test(first)
    ? { kind: "document", candidates }
    : { kind: "file", candidates };
}

/** Decide how the viewer loads an image `src`. */
export function imageSource(
  src: string | undefined,
  docRelPath: string | null,
): ImageSource {
  const raw = (src ?? "").trim();
  if (raw === "") return { kind: "blocked" };
  if (DATA_IMAGE.test(raw)) return { kind: "data", url: raw };
  if (REMOTE_IMAGE.test(raw)) return { kind: "remote", url: raw };
  if (HAS_SCHEME.test(raw)) return { kind: "blocked" };
  const candidates = candidatePaths(docRelPath, stripSuffix(raw));
  return candidates.length === 0
    ? { kind: "blocked" }
    : { kind: "vault", candidates };
}

/**
 * GitHub-style heading slug so `[x](#my-heading)` links work in the
 * viewer: lowercase, drop punctuation (keeps letters/numbers of any
 * script, `-` and `_`), spaces → `-`.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
