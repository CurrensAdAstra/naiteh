import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import Markdown, { type Components, type ExtraProps } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { splitFrontMatterBody } from "../lib/frontMatter";
import {
  classifyLink,
  imageSource,
  slugify,
  type ImageSource,
} from "../lib/markdownLinks";
import { toggleTaskAt } from "../lib/markdownTasks";
import { openDocument, targetForRelPath } from "../lib/openDocument";
import { formatAppError, isAppError } from "../lib/types";
import { loadVaultImage } from "../lib/viewerImages";
import styles from "./MarkdownViewer.module.css";

/**
 * Rendered (read) view of the open Markdown document — what the editor
 * panel shows unless edit mode is on.
 *
 * - GitHub-flavored Markdown (tables, task lists, strikethrough,
 *   autolinks, footnotes). Raw HTML in a note is parsed and then
 *   sanitized with the GitHub schema, so scripts, event handlers and
 *   `javascript:` URLs never reach the DOM.
 * - Front matter is not shown (tags/pin have their own UI).
 * - Links: `http(s):`/`mailto:` open in the system browser; links to other
 *   `.md` files open them in naiteh; `#anchors` scroll within the note;
 *   every other scheme is ignored.
 * - Images in the vault are read through the gated backend
 *   (`attachments_read_image`); remote images are not fetched.
 * - Task-list checkboxes toggle the `[ ]` in the source.
 */
export interface MarkdownViewerProps {
  /** The full document text, front matter included. */
  content: string;
  /** Vault-relative path of the document (link/image resolution). */
  docRelPath: string;
  /** Called with the whole new document after a task checkbox toggle. */
  onChange: (nextContent: string) => void;
  /** Switch to the source editor (empty-note call to action). */
  onStartEditing: () => void;
}

// GitHub's sanitize schema, minus the `user-content-` id prefix: heading
// ids are assigned by the `h1`–`h6` components below, after sanitizing.
const SANITIZE_SCHEMA = { ...defaultSchema, clobberPrefix: "" };

const TaskOffsetContext = createContext<number | null>(null);

export function MarkdownViewer({
  content,
  docRelPath,
  onChange,
  onStartEditing,
}: MarkdownViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { body, offset } = useMemo(() => splitFrontMatterBody(content), [content]);

  // Notices are about the document they were raised on.
  useEffect(() => setNotice(null), [docRelPath]);

  // Latest values for the (stable) component overrides below.
  const latest = useRef({ content, offset, docRelPath, onChange });
  latest.current = { content, offset, docRelPath, onChange };

  const components = useMemo<Components>(() => {
    const heading =
      (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
      ({ node, children }: { children?: ReactNode } & ExtraProps) => (
        <Tag
          id={
            node === undefined
              ? undefined
              : slugify(textOf(node as unknown as HastNode))
          }
        >
          {children}
        </Tag>
      );

    return {
      h1: heading("h1"),
      h2: heading("h2"),
      h3: heading("h3"),
      h4: heading("h4"),
      h5: heading("h5"),
      h6: heading("h6"),
      a: ({ href, children, title }) => (
        <a
          href={href}
          title={title ?? href}
          onClick={(e) => handleLinkClick(e, href)}
        >
          {children}
        </a>
      ),
      img: ({ src, alt, title }) => (
        <ViewerImage
          src={typeof src === "string" ? src : undefined}
          alt={alt ?? ""}
          title={title}
          docRelPath={latest.current.docRelPath}
        />
      ),
      li: ({ node, className, children }) => {
        const isTask =
          typeof className === "string" &&
          className.split(/\s+/).includes("task-list-item");
        const itemOffset = node?.position?.start.offset;
        return (
          <li className={className}>
            {isTask ? (
              <TaskOffsetContext.Provider value={itemOffset ?? null}>
                {children}
              </TaskOffsetContext.Provider>
            ) : (
              children
            )}
          </li>
        );
      },
      input: ({ type, checked }) =>
        type === "checkbox" ? (
          <TaskCheckbox checked={checked === true} onToggle={toggleTask} />
        ) : null,
      table: ({ children }) => (
        <div className={styles.tableWrap}>
          <table>{children}</table>
        </div>
      ),
    };

    function toggleTask(itemOffset: number) {
      const { content: doc, offset: bodyOffset, onChange: emit } = latest.current;
      const next = toggleTaskAt(doc, bodyOffset + itemOffset);
      if (next !== null) emit(next);
    }

    function handleLinkClick(e: MouseEvent<HTMLAnchorElement>, href?: string) {
      // Never let the webview itself navigate away from the app.
      e.preventDefault();
      setNotice(null);
      const target = classifyLink(href, latest.current.docRelPath);
      switch (target.kind) {
        case "external":
          void openUrl(target.url).catch((err: unknown) =>
            setNotice(`Couldn't open ${target.url}: ${formatAppError(err)}`),
          );
          return;
        case "anchor":
          scrollToAnchor(containerRef.current, target.id);
          return;
        case "document":
          void openFirstExisting(target.candidates).then(
            (found) => {
              if (!found) {
                setNotice(
                  `Linked note not found: ${target.candidates[target.candidates.length - 1]}`,
                );
              }
            },
            (err: unknown) => setNotice(formatAppError(err)),
          );
          return;
        case "file":
          setNotice(
            `Only notes open from links for now — find ${target.candidates[target.candidates.length - 1]} in your file manager.`,
          );
          return;
        case "blocked":
          return;
      }
    }
  }, []);

  return (
    <div
      ref={containerRef}
      className={styles.viewer}
      data-testid="markdown-viewer"
    >
      {notice !== null && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      {body.trim() === "" ? (
        <div className={styles.emptyNote}>
          <p>This note is empty.</p>
          <button
            type="button"
            className={styles.startButton}
            onClick={onStartEditing}
          >
            Start writing
          </button>
        </div>
      ) : (
        <article className={styles.content}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA]]}
            components={components}
          >
            {body}
          </Markdown>
        </article>
      )}
    </div>
  );
}

function TaskCheckbox({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: (itemOffset: number) => void;
}) {
  const itemOffset = useContext(TaskOffsetContext);
  return (
    <input
      type="checkbox"
      className={styles.taskBox}
      checked={checked}
      disabled={itemOffset === null}
      aria-label={checked ? "Mark task as not done" : "Mark task as done"}
      onChange={() => {
        if (itemOffset !== null) onToggle(itemOffset);
      }}
    />
  );
}

// ── images ──────────────────────────────────────────────────────────────

type ImageState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

function ViewerImage({
  src,
  alt,
  title,
  docRelPath,
}: {
  src: string | undefined;
  alt: string;
  title?: string | undefined;
  docRelPath: string;
}) {
  const source: ImageSource = useMemo(
    () => imageSource(src, docRelPath),
    [src, docRelPath],
  );
  const [state, setState] = useState<ImageState>({ status: "loading" });

  useEffect(() => {
    if (source.kind !== "vault") return;
    let cancelled = false;
    setState({ status: "loading" });
    loadVaultImage(source.candidates).then(
      (url) => {
        if (!cancelled) setState({ status: "ready", url });
      },
      (err: unknown) => {
        if (cancelled) return;
        const missing = isAppError(err) && err.kind === "NotFound";
        setState({
          status: "error",
          message: missing
            ? `Image not found: ${source.candidates[source.candidates.length - 1]}`
            : formatAppError(err),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  const label = alt !== "" ? alt : (src ?? "image");
  switch (source.kind) {
    case "data":
      return <img src={source.url} alt={alt} title={title} />;
    case "remote":
      return (
        <span className={styles.imageNote} title={source.url}>
          Remote image not loaded: {label}
        </span>
      );
    case "blocked":
      return <span className={styles.imageNote}>[{label}]</span>;
    case "vault":
      if (state.status === "ready") {
        return <img src={state.url} alt={alt} title={title} />;
      }
      if (state.status === "error") {
        return (
          <span className={styles.imageNote} role="img" aria-label={label}>
            {state.message}
          </span>
        );
      }
      return (
        <span className={styles.imageLoading} aria-busy="true">
          {label}
        </span>
      );
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Minimal hast shape we read (react-markdown passes the element node). */
interface HastNode {
  type: string;
  value?: string;
  children?: HastNode[];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function scrollToAnchor(container: HTMLElement | null, id: string): void {
  if (container === null || id === "") return;
  const wanted = new Set([id, slugify(id), `user-content-${id}`]);
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[id]"))) {
    if (wanted.has(el.id)) {
      // jsdom has no scrollIntoView.
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "start" });
      }
      return;
    }
  }
}

/**
 * Open the first candidate note that exists. Resolves `false` when none
 * does; other read errors reject.
 */
async function openFirstExisting(candidates: string[]): Promise<boolean> {
  for (const relPath of candidates) {
    try {
      await openDocument(targetForRelPath(relPath));
      return true;
    } catch (err) {
      if (isAppError(err) && err.kind === "NotFound") continue;
      throw err;
    }
  }
  return false;
}
