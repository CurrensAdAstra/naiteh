import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

import { useAdminData } from "../auth/useAdminData";
import { useAuthStore } from "../../state/authStore";
import { useUIStore } from "../../state/uiStore";
import { AccountSection } from "./sections/AccountSection";
import { AccountsSection } from "./sections/AccountsSection";
import { AiSection } from "./sections/AiSection";
import { AuditSection } from "./sections/AuditSection";
import { EditorSection } from "./sections/EditorSection";
import { ImportSection } from "./sections/ImportSection";
import { VaultSection } from "./sections/VaultSection";
import { useDialogFocus } from "./useDialogFocus";
import styles from "./SettingsModal.module.css";

type SectionId =
  | "general"
  | "editor"
  | "ai"
  | "import"
  | "account"
  | "accounts"
  | "audit";

interface NavEntry {
  id: SectionId;
  label: string;
  group: "options" | "administration";
}

const NAV: readonly NavEntry[] = [
  { id: "general", label: "Vault", group: "options" },
  { id: "editor", label: "Editor", group: "options" },
  { id: "ai", label: "AI Assist", group: "options" },
  { id: "import", label: "Import from Evernote", group: "options" },
  { id: "account", label: "Account", group: "options" },
  { id: "accounts", label: "Accounts", group: "administration" },
  { id: "audit", label: "Audit Log", group: "administration" },
];

const TITLE_ID = "settings-title";

/**
 * Obsidian-style settings: section nav on the left, the active section
 * on the right. Each section is its own component (./sections) owning
 * its state; sections stay mounted while hidden so drafts and an
 * in-flight Evernote import survive switching sections.
 */
export function SettingsModal() {
  const session = useAuthStore((s) => s.session);
  const token = useAuthStore((s) => s.token);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const isAdmin = session?.role === "Admin";
  const [activeSection, setActiveSection] = useState<SectionId>("general");
  const admin = useAdminData(isAdmin ? token : null);

  const close = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, close);

  // File ▸ Import queues the Evernote import; show its section (the
  // section itself consumes the action and opens the picker).
  const pendingAction = useUIStore((s) => s.pendingAction);
  useEffect(() => {
    if (pendingAction === "evernoteImport") setActiveSection("import");
  }, [pendingAction]);

  const visibleNav = NAV.filter((n) => n.group !== "administration" || isAdmin);

  const sections: Record<SectionId, ReactNode> = {
    general: <VaultSection />,
    editor: <EditorSection />,
    ai: <AiSection />,
    import: <ImportSection />,
    account: <AccountSection />,
    accounts: isAdmin ? <AccountsSection admin={admin} /> : null,
    audit: isAdmin ? <AuditSection admin={admin} /> : null,
  };

  function renderNavGroup(group: NavEntry["group"]) {
    return visibleNav
      .filter((n) => n.group === group)
      .map((n) => (
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
          {renderNavGroup("options")}
          {isAdmin && (
            <>
              <div className={styles.navGroupLabel}>Administration</div>
              {renderNavGroup("administration")}
            </>
          )}
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
            {visibleNav.map((n) => (
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
