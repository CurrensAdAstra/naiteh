import {
  Calendar,
  Folder,
  Notebook,
  RefreshCw,
  Search,
  Settings,
  Tag,
  type LucideIcon,
} from "lucide-react";

import { useUIStore, type ViewMode } from "../state/uiStore";
import styles from "./ActivityBar.module.css";

interface ActivityIcon {
  mode: ViewMode;
  label: string;
  Icon: LucideIcon;
}

// Order is normative — see architecture.md §5.3.
const ICONS: readonly ActivityIcon[] = [
  { mode: "journal", label: "Journal", Icon: Notebook },
  { mode: "notes", label: "Notes", Icon: Folder },
  { mode: "calendar", label: "Calendar", Icon: Calendar },
  { mode: "search", label: "Search", Icon: Search },
  { mode: "tags", label: "Tags", Icon: Tag },
  { mode: "sync", label: "Sync", Icon: RefreshCw },
  { mode: "settings", label: "Settings", Icon: Settings },
] as const;

export function ActivityBar() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);

  return (
    <nav className={styles.bar} aria-label="Activity Bar">
      {ICONS.map(({ mode, label, Icon }) => {
        const isActive = viewMode === mode;
        const className = `${styles.button} ${isActive ? styles.active : ""}`;
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-current={isActive ? "page" : undefined}
            className={className}
            onClick={() => setViewMode(mode)}
          >
            {isActive && <span className={styles.activeBar} aria-hidden="true" />}
            <Icon size={24} strokeWidth={1.5} />
          </button>
        );
      })}
    </nav>
  );
}
