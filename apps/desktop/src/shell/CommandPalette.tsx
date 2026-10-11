import {
  BookOpen,
  Calendar,
  Folder,
  Notebook,
  Pencil,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Tag,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useUIStore, type ViewMode } from "../state/uiStore";
import styles from "./CommandPalette.module.css";

interface Command {
  id: string;
  label: string;
  detail: string;
  Icon: LucideIcon;
  run: () => void;
}

const VIEW_COMMANDS: readonly {
  mode: ViewMode;
  label: string;
  detail: string;
  Icon: LucideIcon;
}[] = [
  { mode: "journal", label: "Open Journal", detail: "Go to journal", Icon: Notebook },
  { mode: "notes", label: "Open Notes", detail: "Browse folders", Icon: Folder },
  { mode: "calendar", label: "Open Calendar", detail: "Review timeline", Icon: Calendar },
  { mode: "search", label: "Search Notes", detail: "Find text", Icon: Search },
  { mode: "tags", label: "Open Tags", detail: "Filter by tag", Icon: Tag },
  { mode: "sync", label: "Open Sync", detail: "Backup and restore", Icon: RefreshCw },
] as const;

function matches(command: Command, query: string): boolean {
  if (query.length === 0) return true;
  const haystack = `${command.label} ${command.detail}`.toLowerCase();
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

export function CommandPalette() {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const setOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const toggleAiPanel = useUIStore((s) => s.toggleAiPanel);
  const editorMode = useUIStore((s) => s.editorMode);
  const toggleEditorMode = useUIStore((s) => s.toggleEditorMode);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Unique per instance so option ids never collide with other DOM ids.
  const listboxId = useId();
  const optionId = (command: Command) => `${listboxId}-option-${command.id}`;

  const commands = useMemo<Command[]>(
    () => [
      ...VIEW_COMMANDS.map(({ mode, label, detail, Icon }) => ({
        id: `view-${mode}`,
        label,
        detail,
        Icon,
        run: () => setViewMode(mode),
      })),
      {
        id: "open-settings",
        label: "Open Settings",
        detail: "Configure naiteh",
        Icon: Settings,
        run: () => setSettingsOpen(true),
      },
      {
        id: "toggle-ai",
        label: "Toggle AI Assist",
        detail: "Open or close assistant panel",
        Icon: Sparkles,
        run: toggleAiPanel,
      },
      {
        id: "toggle-edit-mode",
        label: editorMode === "view" ? "Edit Note" : "View Note",
        detail:
          editorMode === "view"
            ? "Show the Markdown source editor"
            : "Show the rendered note",
        Icon: editorMode === "view" ? Pencil : BookOpen,
        run: toggleEditorMode,
      },
    ],
    [
      editorMode,
      setSettingsOpen,
      setViewMode,
      toggleAiPanel,
      toggleEditorMode,
    ],
  );

  const filtered = useMemo(
    () => commands.filter((command) => matches(command, query)),
    [commands, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const activeCommand = filtered[activeIndex];
  const activeOptionId =
    activeCommand === undefined ? undefined : optionId(activeCommand);

  // Keep the keyboard-highlighted option visible in a scrolled list.
  useEffect(() => {
    if (activeOptionId === undefined) return;
    const el = document.getElementById(activeOptionId);
    if (el !== null && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [activeOptionId]);

  if (!open) return null;

  function close() {
    setOpen(false);
  }

  function run(command: Command) {
    command.run();
    close();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((idx) => Math.max(0, Math.min(filtered.length - 1, idx + 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((idx) => Math.max(0, idx - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeCommand !== undefined) run(activeCommand);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      data-testid="command-palette-backdrop"
    >
      <section
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* ARIA 1.2 combobox: focus stays in the input and
            aria-activedescendant points at the highlighted role="option". */}
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a command"
          role="combobox"
          aria-label="Command"
          aria-autocomplete="list"
          aria-expanded={filtered.length > 0}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          data-testid="command-palette-input"
        />
        <ul
          id={listboxId}
          className={styles.results}
          role="listbox"
          aria-label="Commands"
        >
          {filtered.map((command, index) => {
            const active = index === activeIndex;
            const Icon = command.Icon;
            return (
              <li
                key={command.id}
                id={optionId(command)}
                role="option"
                aria-selected={active}
                className={`${styles.command} ${active ? styles.commandActive : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                // Keep focus (and so the combobox state) in the input.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(command)}
                data-testid={`command-${command.id}`}
              >
                <Icon size={17} strokeWidth={1.7} aria-hidden="true" />
                <span className={styles.commandText}>
                  <span className={styles.commandLabel}>{command.label}</span>
                  <span className={styles.commandDetail}>{command.detail}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {filtered.length === 0 && (
          <p className={styles.empty} role="status">
            No matching commands
          </p>
        )}
      </section>
    </div>
  );
}
