import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import type { AiSettings } from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";
import { settingsOf } from "./aiSettings";
import aiStyles from "./AiSection.module.css";

interface Props {
  busy: boolean;
  onSave: (settings: AiSettings) => Promise<boolean>;
}

export function AiAdvancedSettings({ busy, onSave }: Props) {
  const settings = useSettingsStore(
    useShallow((s) => settingsOf(s.config?.ai)),
  );
  const [draft, setDraft] = useState<AiSettings>(settings);

  useEffect(() => setDraft(settings), [settings]);

  function patch<K extends keyof AiSettings>(key: K, value: AiSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <details className={aiStyles.advanced}>
      <summary>Advanced chat settings</summary>
      <fieldset className={aiStyles.advancedFields} disabled={busy}>
        <SettingItem name="Temperature" controlId="settings-ai-temperature">
          <input
            id="settings-ai-temperature"
            type="number"
            min={0}
            max={2}
            step={0.1}
            className={styles.numberInput}
            value={draft.temperature}
            onChange={(event) =>
              patch("temperature", Number(event.target.value))
            }
            data-testid="ai-temperature-input"
          />
        </SettingItem>
        <SettingItem name="Max tokens" controlId="settings-ai-max-tokens">
          <input
            id="settings-ai-max-tokens"
            type="number"
            min={1}
            max={1000000}
            step={1}
            className={styles.numberInput}
            value={draft.maxTokens}
            onChange={(event) => patch("maxTokens", Number(event.target.value))}
            data-testid="ai-max-tokens-input"
          />
        </SettingItem>
        <SettingItem
          name="Stream replies"
          description="Write the reply into the note as it arrives."
        >
          <button
            type="button"
            role="switch"
            aria-checked={draft.stream}
            aria-label="Stream replies"
            className={`${styles.toggle} ${draft.stream ? styles.toggleOn : ""}`}
            onClick={() => patch("stream", !draft.stream)}
            data-testid="ai-stream-toggle"
          />
        </SettingItem>
        <SettingItem
          name="Heading level"
          description="Level (1–6) of the role:: headings written into chats."
          controlId="settings-ai-heading-level"
        >
          <select
            id="settings-ai-heading-level"
            className={styles.textInput}
            value={draft.headingLevel}
            onChange={(event) =>
              patch("headingLevel", Number(event.target.value))
            }
            data-testid="ai-heading-level-input"
          >
            {[1, 2, 3, 4, 5, 6].map((level) => (
              <option key={level} value={level}>
                {"#".repeat(level)}
              </option>
            ))}
          </select>
        </SettingItem>
        <SettingItem
          name="Infer title language"
          description="Language of titles from “Chat: Infer title”."
          controlId="settings-ai-title-language"
        >
          <input
            id="settings-ai-title-language"
            className={styles.textInput}
            value={draft.inferTitleLanguage}
            onChange={(event) =>
              patch("inferTitleLanguage", event.target.value)
            }
            data-testid="ai-title-language-input"
          />
        </SettingItem>
        <SettingItem
          name="Chats folder"
          description="Where “Chat: New chat” creates notes."
          controlId="settings-ai-chats-folder"
        >
          <input
            id="settings-ai-chats-folder"
            className={styles.textInput}
            value={draft.chatsFolder}
            onChange={(event) => patch("chatsFolder", event.target.value)}
            spellCheck={false}
            data-testid="ai-chats-folder-input"
          />
        </SettingItem>
        <SettingItem
          name="Agents folder"
          description="Notes whose body is a system prompt; reference one with agent: in front matter."
          controlId="settings-ai-agents-folder"
        >
          <input
            id="settings-ai-agents-folder"
            className={styles.textInput}
            value={draft.agentsFolder}
            onChange={(event) => patch("agentsFolder", event.target.value)}
            spellCheck={false}
            data-testid="ai-agents-folder-input"
          />
        </SettingItem>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonPrimary}`}
            onClick={() =>
              void onSave({
                ...draft,
                defaultModel: settings.defaultModel,
                chatsFolder: draft.chatsFolder.trim(),
                agentsFolder: draft.agentsFolder.trim(),
              })
            }
            data-testid="ai-save"
          >
            {busy ? "Saving…" : "Save chat settings"}
          </button>
        </div>
      </fieldset>
      <p className={aiStyles.hint}>
        Chat inside any note with Ctrl/Cmd+J. Per-note front matter overrides
        these defaults. Replies use <code>role::assistant</code> headings and{" "}
        <code>&lt;hr class=&quot;__chatgpt_plugin&quot;&gt;</code> separators.
        Based on chatgpt-md (MIT).
      </p>
    </details>
  );
}
