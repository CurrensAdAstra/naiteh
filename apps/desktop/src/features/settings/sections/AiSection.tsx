import { useEffect, useState } from "react";

import {
  aiBaseIsLocal,
  OLLAMA_BASE_URL,
  OPENAI_BASE_URL,
  validateAiBaseUrl,
} from "../../../lib/aiProvider";
import { aiListModels } from "../../../lib/api/ai";
import {
  appConfigSetAi,
  type AiSettingsUpdate,
} from "../../../lib/api/settings";
import { formatAppError } from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import { SettingItem } from "../SettingItem";
import styles from "../SettingsModal.module.css";

const KEY_ID = "settings-ai-key";
const MODEL_ID = "settings-ai-model";
const BASE_URL_ID = "settings-ai-base-url";

/**
 * AI Assist provider settings. The API key is write-only: the backend
 * only reports `hasApiKey`, and the key typed here is dropped from state
 * as soon as it has been sent — it never sits in React state or the
 * settings store after a save.
 */
export function AiSection() {
  const config = useSettingsStore((s) => s.config);
  const setSettings = useSettingsStore((s) => s.setConfig);

  const hasApiKey = config?.ai.hasApiKey ?? false;
  const storedModel = config?.ai.model ?? null;
  const storedBaseUrl = config?.ai.baseUrl ?? null;
  const baseUrl = storedBaseUrl ?? OPENAI_BASE_URL;
  const usingLocal = aiBaseIsLocal(baseUrl);

  const [keyDraft, setKeyDraft] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [modelDraft, setModelDraft] = useState(storedModel ?? "");
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (storedModel !== null) setModelDraft(storedModel);
  }, [storedModel]);
  useEffect(() => {
    if (storedBaseUrl !== null) setBaseUrlDraft(storedBaseUrl);
  }, [storedBaseUrl]);

  const showKeyInput = !hasApiKey || replacingKey;

  async function send(update: AiSettingsUpdate, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setSettings(await appConfigSetAi(update));
      setNotice(done);
      return true;
    } catch (e) {
      setError(formatAppError(e));
      return false;
    } finally {
      // Whatever happened, the key is gone from memory once sent.
      setKeyDraft("");
      setBusy(false);
    }
  }

  function typedKey(): string | null {
    const key = keyDraft.trim();
    return key === "" ? null : key;
  }

  async function handleSave() {
    const nextBaseUrl = baseUrlDraft.trim();
    const urlProblem = validateAiBaseUrl(nextBaseUrl);
    if (urlProblem !== null) {
      setError(urlProblem);
      return;
    }
    const model = modelDraft.trim();
    if (model === "") {
      setError("Choose a model.");
      return;
    }
    const apiKey = typedKey();
    const ok = await send(
      { apiKey, clearApiKey: false, model, baseUrl: nextBaseUrl },
      apiKey !== null ? "AI settings saved. Key saved." : "AI settings saved.",
    );
    if (ok) setReplacingKey(false);
  }

  async function handleRemoveKey() {
    const ok = await send(
      {
        apiKey: null,
        clearApiKey: true,
        model: storedModel ?? modelDraft.trim(),
        baseUrl: null,
      },
      "API key removed.",
    );
    if (ok) setReplacingKey(false);
  }

  async function handleUseProvider(providerUrl: string, fallbackModel: string) {
    const model = modelDraft.trim() === "" ? fallbackModel : modelDraft.trim();
    const ok = await send(
      { apiKey: typedKey(), clearApiKey: false, model, baseUrl: providerUrl },
      "Provider updated.",
    );
    if (ok) {
      setModelDraft(model);
      setModelOptions([]);
    }
  }

  async function handleLoadModels() {
    setLoadingModels(true);
    setError(null);
    try {
      setModelOptions(await aiListModels());
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <div data-testid="settings-ai">
      <h2 className={styles.sectionHeading}>AI Assist</h2>
      <p className={styles.sectionIntro}>
        AI Assist is the one feature that sends note text out of the app —
        only when you trigger it. Use a hosted API (OpenAI) with a key, or
        run a model locally with{" "}
        <a href="https://ollama.com" target="_blank" rel="noreferrer">
          Ollama
        </a>{" "}
        for fully local, key-free, no-network AI.
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
      <SettingItem
        name="Provider"
        description={
          <>
            Endpoint: <code>{baseUrl}</code>
            {usingLocal &&
              " — make sure Ollama is running (ollama serve) and you've pulled a model."}
          </>
        }
        testId="ai-endpoint"
      >
        <button
          type="button"
          className={`${styles.button} ${usingLocal ? styles.buttonPrimary : ""}`}
          onClick={() => void handleUseProvider(OLLAMA_BASE_URL, "llama3.2")}
          disabled={busy}
          aria-pressed={usingLocal}
          data-testid="ai-use-ollama"
        >
          {usingLocal ? "✓ Local Ollama" : "Use local Ollama"}
        </button>
        <button
          type="button"
          className={`${styles.button} ${!usingLocal ? styles.buttonPrimary : ""}`}
          onClick={() => void handleUseProvider(OPENAI_BASE_URL, "gpt-4o-mini")}
          disabled={busy}
          aria-pressed={!usingLocal}
          data-testid="ai-use-openai"
        >
          {!usingLocal ? "✓ OpenAI" : "Use OpenAI"}
        </button>
      </SettingItem>
      <SettingItem
        name="Endpoint URL"
        description="Any OpenAI-compatible API. Must use https://, except on this machine (localhost, 127.0.0.1, [::1])."
        controlId={BASE_URL_ID}
      >
        <input
          id={BASE_URL_ID}
          type="url"
          className={styles.textInput}
          value={baseUrlDraft}
          onChange={(e) => setBaseUrlDraft(e.target.value)}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${BASE_URL_ID}-description`}
          data-testid="ai-base-url-input"
        />
      </SettingItem>
      {showKeyInput ? (
        <SettingItem
          name="API key"
          description={
            usingLocal
              ? "Not needed for a local endpoint."
              : hasApiKey
                ? "Enter the new key, then save. The old key stays until you do."
                : "Stored in your app config and never shown again; used only for AI Assist calls."
          }
          controlId={KEY_ID}
        >
          <input
            id={KEY_ID}
            type="password"
            className={styles.textInput}
            placeholder={usingLocal ? "—" : "sk-…"}
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            disabled={busy}
            autoComplete="off"
            aria-describedby={`${KEY_ID}-description`}
            data-testid="ai-key-input"
          />
          {hasApiKey && (
            <button
              type="button"
              className={styles.button}
              onClick={() => {
                setKeyDraft("");
                setReplacingKey(false);
              }}
              disabled={busy}
              data-testid="ai-cancel-replace-key"
            >
              Cancel
            </button>
          )}
        </SettingItem>
      ) : (
        <SettingItem
          name="API key"
          description="A key is stored for this endpoint. It is never displayed."
        >
          <span className={styles.keyStatus} data-testid="ai-key-status">
            Key saved
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => {
              setNotice(null);
              setReplacingKey(true);
            }}
            disabled={busy}
            data-testid="ai-replace-key"
          >
            Replace key
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() => void handleRemoveKey()}
            disabled={busy}
            data-testid="ai-remove-key"
          >
            Remove key
          </button>
        </SettingItem>
      )}
      <SettingItem
        name="Model"
        description="Load the list from the endpoint, then pick one."
        controlId={MODEL_ID}
      >
        <input
          id={MODEL_ID}
          type="text"
          list="ai-model-options"
          className={styles.textInput}
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          disabled={busy}
          aria-describedby={`${MODEL_ID}-description`}
          data-testid="ai-model-input"
        />
        <datalist id="ai-model-options">
          {modelOptions.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </SettingItem>
      <SettingItem
        name="Save"
        description={
          modelOptions.length > 0
            ? `${modelOptions.length} model${
                modelOptions.length === 1 ? "" : "s"
              } available.`
            : undefined
        }
      >
        <button
          type="button"
          className={`${styles.button} ${styles.buttonPrimary}`}
          onClick={() => void handleSave()}
          disabled={busy || modelDraft.trim() === ""}
          data-testid="ai-save"
        >
          {busy ? "Saving…" : "Save AI settings"}
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => void handleLoadModels()}
          disabled={loadingModels || busy}
          data-testid="ai-load-models"
        >
          {loadingModels ? "Loading…" : "Load models"}
        </button>
      </SettingItem>
    </div>
  );
}
