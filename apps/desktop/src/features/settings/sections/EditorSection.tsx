import { useEffect, useRef, useState } from "react";

import { appConfigSetEditor } from "../../../lib/api/settings";
import {
  EDITOR_FONT_DEFAULT,
  EDITOR_FONT_MAX,
  EDITOR_FONT_MIN,
  formatAppError,
} from "../../../lib/types";
import {
  selectEditorConfig,
  useSettingsStore,
} from "../../../state/settingsStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

/** Idle time after the last keystroke before a typed font size is saved. */
export const FONT_SIZE_COMMIT_DELAY_MS = 600;

const FONT_SIZE_ID = "settings-font-size";
const LINE_WRAP_ID = "settings-line-wrapping";

function clampFontSize(value: number): number {
  return Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(value)));
}

export function EditorSection() {
  const config = useSettingsStore((s) => s.config);
  const editorConfig = useSettingsStore(selectEditorConfig);
  const setSettings = useSettingsStore((s) => s.setConfig);
  const refreshSettings = useSettingsStore((s) => s.refresh);
  const [error, setError] = useState<string | null>(null);
  const [wrapBusy, setWrapBusy] = useState(false);

  // The font-size field edits a local draft; only a committed value
  // (blur, Enter, or a pause in typing) is clamped and sent over IPC, so
  // intermediate keystrokes ("1" on the way to "16") never apply.
  const [fontDraft, setFontDraft] = useState(String(editorConfig.fontSize));
  const editingFont = useRef(false);
  const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the stored value while the user isn't mid-edit.
  useEffect(() => {
    if (!editingFont.current) setFontDraft(String(editorConfig.fontSize));
  }, [editorConfig.fontSize]);

  useEffect(
    () => () => {
      if (commitTimer.current !== null) clearTimeout(commitTimer.current);
    },
    [],
  );

  async function save(fontSize: number, lineWrapping: boolean) {
    setError(null);
    try {
      setSettings(await appConfigSetEditor(fontSize, lineWrapping));
    } catch (e) {
      setError(formatAppError(e));
      await refreshSettings();
    }
  }

  function cancelPendingCommit() {
    if (commitTimer.current !== null) {
      clearTimeout(commitTimer.current);
      commitTimer.current = null;
    }
  }

  function commitFontSize(raw: string) {
    cancelPendingCommit();
    editingFont.current = false;
    const current = selectEditorConfig(useSettingsStore.getState());
    const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed)) {
      setFontDraft(String(current.fontSize));
      return;
    }
    const next = clampFontSize(parsed);
    setFontDraft(String(next));
    if (next === current.fontSize) return;
    void save(next, current.lineWrapping);
  }

  function onFontDraftChange(value: string) {
    editingFont.current = true;
    setFontDraft(value);
    cancelPendingCommit();
    commitTimer.current = setTimeout(() => {
      commitTimer.current = null;
      commitFontSize(value);
    }, FONT_SIZE_COMMIT_DELAY_MS);
  }

  async function toggleWrapping() {
    setWrapBusy(true);
    try {
      const current = selectEditorConfig(useSettingsStore.getState());
      await save(current.fontSize, !current.lineWrapping);
    } finally {
      setWrapBusy(false);
    }
  }

  return (
    <div data-testid="settings-editor">
      <h2 className={styles.sectionHeading}>Editor</h2>
      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <SettingItem
        name="Font size"
        description={`Editor text size in pixels (${EDITOR_FONT_MIN}–${EDITOR_FONT_MAX}). Defaults to ${EDITOR_FONT_DEFAULT}.`}
        controlId={FONT_SIZE_ID}
      >
        <input
          id={FONT_SIZE_ID}
          type="number"
          inputMode="numeric"
          className={styles.numberInput}
          min={EDITOR_FONT_MIN}
          max={EDITOR_FONT_MAX}
          step={1}
          value={fontDraft}
          onChange={(e) => onFontDraftChange(e.target.value)}
          onBlur={(e) => {
            // Already committed (Enter / pause) and untouched since.
            if (editingFont.current) commitFontSize(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitFontSize(e.currentTarget.value);
            }
          }}
          aria-describedby={`${FONT_SIZE_ID}-description`}
          data-testid="font-size-input"
        />
      </SettingItem>
      <SettingItem
        name="Line wrapping"
        description="Wrap long lines instead of scrolling horizontally."
        controlId={LINE_WRAP_ID}
      >
        <button
          id={LINE_WRAP_ID}
          type="button"
          role="switch"
          aria-checked={editorConfig.lineWrapping}
          aria-describedby={`${LINE_WRAP_ID}-description`}
          className={`${styles.toggle} ${
            editorConfig.lineWrapping ? styles.toggleOn : ""
          }`}
          onClick={() => void toggleWrapping()}
          disabled={wrapBusy}
          data-testid="line-wrapping-input"
        />
      </SettingItem>
      {config === null && (
        <p className={styles.emptyNote}>Loading current values…</p>
      )}
    </div>
  );
}
