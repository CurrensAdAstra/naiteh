import { useEffect, useState } from "react";

import {
  appConfigSetAi,
  appConfigSetAiProvider,
  type AiProviderUpdate,
} from "../../../lib/api/settings";
import {
  AI_PROVIDERS,
  DEFAULT_AI_SETTINGS,
  formatAppError,
  type AiProviderConfig,
  type AiProviderId,
  type AiSettings,
} from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import { ModelPicker } from "../../chat/ModelPicker";
import { isModelId } from "../../../lib/chatMd/models";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

const PROVIDER_NAMES: Record<AiProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  zai: "Z.ai",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
};

const LOCAL: readonly AiProviderId[] = ["ollama", "lmstudio"];

function settingsOf(ai: AiSettings | undefined): AiSettings {
  if (ai === undefined) return DEFAULT_AI_SETTINGS;
  return {
    defaultModel: ai.defaultModel,
    temperature: ai.temperature,
    maxTokens: ai.maxTokens,
    stream: ai.stream,
    headingLevel: ai.headingLevel,
    inferTitleLanguage: ai.inferTitleLanguage,
    chatsFolder: ai.chatsFolder,
    agentsFolder: ai.agentsFolder,
  };
}

/**
 * Settings → AI: chat in a note (a port of chatgpt-md). Providers keep a
 * base URL and a write-only API key (only `hasApiKey` crosses IPC; a
 * typed key is dropped from state as soon as it has been sent).
 */
export function AiSection() {
  const ai = useSettingsStore((s) => s.config?.ai);
  const setConfig = useSettingsStore((s) => s.setConfig);
  const [draft, setDraft] = useState<AiSettings>(() => settingsOf(ai));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(settingsOf(ai));
  }, [ai]);

  function patch<K extends keyof AiSettings>(key: K, value: AiSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  async function handleSave() {
    if (!isModelId(draft.defaultModel)) {
      setError("Default model must look like provider@model.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setConfig(
        await appConfigSetAi({
          ...draft,
          defaultModel: draft.defaultModel.trim(),
          chatsFolder: draft.chatsFolder.trim(),
          agentsFolder: draft.agentsFolder.trim(),
        }),
      );
      setNotice("Chat settings saved.");
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="settings-ai">
      <h2 className={styles.sectionHeading}>AI</h2>
      <p className={styles.sectionIntro}>
        Chat inside any note. <strong>Chat</strong> (Ctrl/Cmd+J) sends the
        note to the model and appends the reply under a{" "}
        <code>role::assistant</code> heading, separated by{" "}
        <code>&lt;hr class=&quot;__chatgpt_plugin&quot;&gt;</code>; then
        type your next message under <code>role::user</code>. Front matter
        (<code>model: openai@gpt-4.1-mini</code>, <code>temperature</code>,{" "}
        <code>max_tokens</code>, <code>system_commands</code>, …) overrides
        the defaults per note. Based on chatgpt-md (MIT).
      </p>
      {error !== null && (
        <p className={styles.error} role="alert" data-testid="ai-settings-error">
          {error}
        </p>
      )}
      {notice !== null && error === null && (
        <p className={styles.notice} role="status" data-testid="ai-settings-notice">
          {notice}
        </p>
      )}

      <h3 className={styles.groupHeading}>Providers</h3>
      {AI_PROVIDERS.map((id) => (
        <ProviderRow
          key={id}
          id={id}
          provider={ai?.providers[id]}
          onSaved={(message) => {
            setError(null);
            setNotice(message);
          }}
          onError={(message) => {
            setNotice(null);
            setError(message);
          }}
        />
      ))}

      <h3 className={styles.groupHeading}>Chat defaults</h3>
      <SettingItem
        name="Default model"
        description="provider@model — used when a note has no model: in its front matter."
        controlId="settings-ai-default-model"
      >
        <input
          id="settings-ai-default-model"
          type="text"
          className={styles.textInput}
          value={draft.defaultModel}
          onChange={(e) => patch("defaultModel", e.target.value)}
          spellCheck={false}
          data-testid="ai-default-model-input"
        />
        <button
          type="button"
          className={styles.button}
          onClick={() => setPicking(true)}
          data-testid="ai-choose-model"
        >
          Choose…
        </button>
      </SettingItem>
      <SettingItem name="Temperature" controlId="settings-ai-temperature">
        <input
          id="settings-ai-temperature"
          type="number"
          min={0}
          max={2}
          step={0.1}
          className={styles.numberInput}
          value={draft.temperature}
          onChange={(e) => patch("temperature", Number(e.target.value))}
          data-testid="ai-temperature-input"
        />
      </SettingItem>
      <SettingItem name="Max tokens" controlId="settings-ai-max-tokens">
        <input
          id="settings-ai-max-tokens"
          type="number"
          min={1}
          step={1}
          className={styles.numberInput}
          value={draft.maxTokens}
          onChange={(e) => patch("maxTokens", Number(e.target.value))}
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
          onChange={(e) => patch("headingLevel", Number(e.target.value))}
          data-testid="ai-heading-level-input"
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>
              {"#".repeat(n)}
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
          type="text"
          className={styles.textInput}
          value={draft.inferTitleLanguage}
          onChange={(e) => patch("inferTitleLanguage", e.target.value)}
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
          type="text"
          className={styles.textInput}
          value={draft.chatsFolder}
          onChange={(e) => patch("chatsFolder", e.target.value)}
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
          type="text"
          className={styles.textInput}
          value={draft.agentsFolder}
          onChange={(e) => patch("agentsFolder", e.target.value)}
          spellCheck={false}
          data-testid="ai-agents-folder-input"
        />
      </SettingItem>
      <SettingItem name="Save">
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={() => void handleSave()}
          disabled={busy}
          data-testid="ai-save"
        >
          {busy ? "Saving…" : "Save chat settings"}
        </button>
      </SettingItem>
      {picking && (
        <ModelPicker
          title="Default chat model"
          initial={draft.defaultModel}
          onPick={(model) => patch("defaultModel", model)}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

interface ProviderRowProps {
  id: AiProviderId;
  provider: AiProviderConfig | undefined;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

function ProviderRow({ id, provider, onSaved, onError }: ProviderRowProps) {
  const setConfig = useSettingsStore((s) => s.setConfig);
  const hasApiKey = provider?.hasApiKey ?? false;
  const storedUrl = provider?.baseUrl ?? "";
  const local = LOCAL.includes(id);
  const [urlDraft, setUrlDraft] = useState(storedUrl);
  const [keyDraft, setKeyDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setUrlDraft(storedUrl), [storedUrl]);

  const showKeyInput = !local && (!hasApiKey || replacing);
  const name = PROVIDER_NAMES[id];

  async function send(update: AiProviderUpdate, done: string) {
    setBusy(true);
    try {
      setConfig(await appConfigSetAiProvider(update));
      setReplacing(false);
      onSaved(done);
    } catch (e) {
      onError(formatAppError(e));
    } finally {
      // Whatever happened, the key is gone from memory once sent.
      setKeyDraft("");
      setBusy(false);
    }
  }

  function handleSave() {
    const key = keyDraft.trim();
    const url = urlDraft.trim();
    void send(
      {
        provider: id,
        baseUrl: url === "" || url === storedUrl ? null : url,
        apiKey: key === "" ? null : key,
        clearApiKey: false,
      },
      key === "" ? `${name} saved.` : `${name}: key saved.`,
    );
  }

  return (
    <SettingItem
      name={name}
      description={
        local
          ? "Runs on this machine; no API key needed."
          : hasApiKey
            ? "Key saved (never displayed)."
            : "No API key yet."
      }
      stacked
      testId={`ai-provider-${id}`}
    >
      <input
        type="url"
        className={styles.textInput}
        value={urlDraft}
        onChange={(e) => setUrlDraft(e.target.value)}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${name} base URL`}
        data-testid={`ai-base-url-${id}`}
      />
      {showKeyInput && (
        <input
          type="password"
          className={styles.textInput}
          placeholder="API key"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          disabled={busy}
          autoComplete="off"
          aria-label={`${name} API key`}
          data-testid={`ai-key-input-${id}`}
        />
      )}
      {!local && hasApiKey && !replacing && (
        <>
          <span className={styles.keyStatus} data-testid={`ai-key-status-${id}`}>
            Key saved
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => setReplacing(true)}
            disabled={busy}
            data-testid={`ai-replace-key-${id}`}
          >
            Replace
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() =>
              void send(
                { provider: id, baseUrl: null, apiKey: null, clearApiKey: true },
                `${name}: key removed.`,
              )
            }
            disabled={busy}
            data-testid={`ai-remove-key-${id}`}
          >
            Remove
          </button>
        </>
      )}
      {!local && hasApiKey && replacing && (
        <button
          type="button"
          className={styles.button}
          onClick={() => {
            setKeyDraft("");
            setReplacing(false);
          }}
          disabled={busy}
          data-testid={`ai-cancel-replace-key-${id}`}
        >
          Cancel
        </button>
      )}
      <button
        type="button"
        className={`${styles.button} ${styles.buttonPrimary}`}
        onClick={handleSave}
        disabled={busy || (keyDraft.trim() === "" && urlDraft.trim() === storedUrl)}
        data-testid={`ai-provider-save-${id}`}
      >
        Save
      </button>
    </SettingItem>
  );
}
