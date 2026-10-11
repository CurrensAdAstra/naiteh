import { useState } from "react";

import { useUIStore } from "../../../state/uiStore";
import { useVaultStore } from "../../../state/vaultStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";
import local from "./BackupSection.module.css";

/**
 * Explains how to back up the vault. naiteh's recommended (primary)
 * backup is a folder-sync service — Google Drive for desktop — pointed at
 * the vault folder; the in-app Sync (Git) is optional and has limits that
 * matter for Evernote-sized attachments. See vault/wiki/vault-and-data.md
 * ("Backup").
 */
export function BackupSection() {
  const vaultRoot = useVaultStore((s) => s.active?.root ?? null);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  async function copyPath() {
    if (vaultRoot === null) return;
    try {
      await navigator.clipboard.writeText(vaultRoot);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  function openSyncPanel() {
    setViewMode("sync");
    setSettingsOpen(false);
  }

  return (
    <div data-testid="settings-backup">
      <h2 className={styles.sectionHeading}>Backup</h2>
      <p className={styles.sectionIntro}>
        Your vault is an ordinary folder, so the simplest reliable backup is a
        folder-sync service. naiteh recommends <strong>Google Drive for
        desktop</strong>: it copes with large Evernote attachments and keeps
        deleted files and earlier versions for a while.
      </p>

      <SettingItem
        name="Recommended: Google Drive"
        stacked
        testId="settings-backup-drive"
        description="Set it up once; after that every save, attachment and Evernote import is uploaded automatically."
      >
        <ol className={local.steps}>
          <li>Install Google Drive for desktop and sign in.</li>
          <li>
            In Drive&rsquo;s settings choose <strong>My Computer</strong> →{" "}
            <strong>Add folder</strong>, and pick your vault folder:
            {vaultRoot !== null ? (
              <span className={local.pathRow}>
                <code className={local.path} data-testid="settings-backup-path">
                  {vaultRoot}
                </code>
                <button
                  type="button"
                  className={styles.button}
                  onClick={() => void copyPath()}
                  data-testid="settings-backup-copy"
                >
                  {copyState === "copied" ? "Copied" : "Copy path"}
                </button>
              </span>
            ) : (
              <span className={local.pathRow}>
                No vault is open yet — choose one under <strong>Vault</strong>.
              </span>
            )}
            {copyState === "failed" && (
              <span className={local.hint} role="status">
                Couldn&rsquo;t copy — select the path above and copy it
                manually.
              </span>
            )}
          </li>
          <li>
            Choose <strong>Sync with Google Drive</strong>.
          </li>
        </ol>
      </SettingItem>

      <SettingItem
        name="What the backup includes"
        description={
          <>
            Everything inside the vault folder: notes, journal, attachments
            and Evernote imports. naiteh&rsquo;s own settings, accounts and AI
            key are stored on this computer outside the vault and are{" "}
            <strong>not</strong> part of it.
          </>
        }
      />

      <SettingItem
        name="Good to know"
        stacked
        description="Folder sync has no merge step, so:"
      >
        <ul className={local.caveats}>
          <li>
            Don&rsquo;t edit the same note on two computers at the same time
            — Drive keeps both versions as separate files and naiteh
            won&rsquo;t merge them.
          </li>
          <li>
            Use one sync method per vault. If Drive syncs this vault between
            several computers, leave the in-app Sync off.
          </li>
        </ul>
      </SettingItem>

      <SettingItem
        name="Optional: in-app Sync"
        stacked
        testId="settings-backup-sync"
        description="The Sync panel can also keep a version history with a Git service such as GitHub. It is optional and has limits:"
      >
        <ul className={local.caveats}>
          <li>
            Use a <strong>private</strong> repository — notes are uploaded
            unencrypted.
          </li>
          <li>
            GitHub rejects files over <strong>100 MB</strong>. One large
            attachment (common in Evernote imports) stops every later sync.
          </li>
          <li>
            Attachments stay in the history even after you delete them, so
            the repository only grows.
          </li>
        </ul>
        <button
          type="button"
          className={styles.button}
          onClick={openSyncPanel}
          data-testid="settings-backup-open-sync"
        >
          Open Sync panel
        </button>
      </SettingItem>
    </div>
  );
}
