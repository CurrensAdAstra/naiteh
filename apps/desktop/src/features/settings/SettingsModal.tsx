import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import { useUIStore } from "../../state/uiStore";
import { SecuritySection } from "./sections/SecuritySection";
import { AiSection } from "./sections/AiSection";
import { AppearanceSection } from "./sections/AppearanceSection";
import { AuditSection } from "./sections/AuditSection";
import { BackupSection } from "./sections/BackupSection";
import { EditorSection } from "./sections/EditorSection";
import { ClippingSection } from "./sections/ClippingSection";
import { ImportSection } from "./sections/ImportSection";
import { VaultSection } from "./sections/VaultSection";
import { useDialogFocus } from "./useDialogFocus";
import styles from "./SettingsModal.module.css";

type SectionId =
  | "general"
  | "backup"
  | "appearance"
  | "editor"
  | "clipping"
  | "ai"
  | "import"
  | "security"
  | "audit";

interface NavEntry {
  id: SectionId;
  label: string;
}

const NAV: readonly NavEntry[] = [
  { id: "general", label: "Vault" },
  { id: "backup", label: "Backup" },
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "clipping", label: "Web Clipping" },
  { id: "ai", label: "AI" },
  { id: "import", label: "Import from Evernote" },
  { id: "security", label: "Security" },
  { id: "audit", label: "Local Activity" },
];

const TITLE_ID = "settings-title";

/**
 * Obsidian-style settings: section nav on the left, the active section
 * on the right. Each section is its own component (./sections) owning
 * its state; sections stay mounted while hidden so drafts and an
 * in-flight Evernote import survive switching sections.
 */
export function SettingsModal() {
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [activeSection, setActiveSection] = useState<SectionId>("general");

  const close = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, close);

  // File ▸ Import queues the Evernote import; show its section (the
  // section itself consumes the action and opens the picker).
  // The Sync panel's "Backup settings" link lands on the Backup section;
  // nothing else consumes that action, so clear it here.
  const pendingAction = useUIStore((s) => s.pendingAction);
  const clearPendingAction = useUIStore((s) => s.clearPendingAction);
  useEffect(() => {
    if (pendingAction === "evernoteImport") setActiveSection("import");
    if (pendingAction === "showBackup") {
      setActiveSection("backup");
      clearPendingAction();
    }
  }, [pendingAction, clearPendingAction]);

  const sections: Record<SectionId, ReactNode> = {
    general: <VaultSection />,
    backup: <BackupSection />,
    appearance: <AppearanceSection />,
    editor: <EditorSection />,
    clipping: <ClippingSection />,
    ai: <AiSection />,
    import: <ImportSection />,
    security: <SecuritySection />,
    audit: <AuditSection />,
  };

  function renderNav() {
    return NAV.map((n) => (
        <button
          key={n.id}
          type="button"
          className={`${styles.navItem} ${
            activeSection === n.id ? styles.navItemActive : ""
          }`}
          aria-current={activeSection === n.id ? "page" : undefined}
          aria-controls={`settings-panel-${n.id}`}
          onClick={() => setActiveSection(n.id)}
          data-testid={`settings-nav-${n.id}`}
        >
          {n.label}
        </button>
      ));
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        // Click on the backdrop (not the modal) closes.
        if (e.target === e.currentTarget) close();
      }}
      data-testid="settings-modal"
    >
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
      >
        <nav className={styles.nav} aria-label="Settings sections">
          <h1 className={styles.navTitle} id={TITLE_ID}>
            Settings
          </h1>
          <div className={styles.navGroupLabel}>Options</div>
          {renderNav()}
        </nav>

        <div className={styles.content}>
          <button
            type="button"
            className={styles.close}
            onClick={close}
            aria-label="Close settings"
            data-testid="settings-close"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
          <div className={styles.scroll}>
            {NAV.map((n) => (
              <section
                key={n.id}
                id={`settings-panel-${n.id}`}
                aria-label={n.label}
                hidden={activeSection !== n.id}
              >
                {sections[n.id]}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
