import { useEffect, useRef, useState, type FormEvent } from "react";

import { aiListModels } from "../../../lib/api/ai";
import type { AiProviderUpdate } from "../../../lib/api/settings";
import {
  DEFAULT_BASE_URLS,
  formatAppError,
  type AiProviderConfig,
  type AiProviderId,
} from "../../../lib/types";
import styles from "../SettingsModal.module.css";
import { isLocalProvider, PROVIDER_NAMES } from "./aiSettings";
import aiStyles from "./AiSection.module.css";

interface ConnectionProps {
  id: AiProviderId;
  provider: AiProviderConfig | undefined;
  busy: boolean;
  onSave: (update: AiProviderUpdate) => Promise<boolean>;
  onNext: () => void;
}

export function AiConnectionSettings({
  id,
  provider,
  busy,
  onSave,
  onNext,
}: ConnectionProps) {
  const name = PROVIDER_NAMES[id];
  const local = isLocalProvider(id);
  const storedUrl = provider?.baseUrl ?? DEFAULT_BASE_URLS[id];
  const hasApiKey = provider?.hasApiKey ?? false;
  const [url, setUrl] = useState(storedUrl);
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const submitting = useRef(false);

  useEffect(() => setUrl(storedUrl), [storedUrl]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      busy ||
      submitting.current ||
      (!local && !hasApiKey && key.trim() === "")
    )
      return;
    const typedKey = key.trim();
    const baseUrl = url.trim();
    if (typedKey === "" && (baseUrl === "" || baseUrl === storedUrl)) {
      onNext();
      return;
    }
    submitting.current = true;
    setKey("");
    try {
      if (
        await onSave({
          provider: id,
          baseUrl: baseUrl === "" || baseUrl === storedUrl ? null : baseUrl,
          apiKey: typedKey || null,
          clearApiKey: false,
        })
      ) {
        setReplacing(false);
        onNext();
      }
    } finally {
      submitting.current = false;
    }
  }

  return (
    <form className={aiStyles.form} onSubmit={(event) => void submit(event)}>
      <fieldset className={aiStyles.connectionMethods} disabled={busy}>
        <legend>Connection method</legend>
        <label className={aiStyles.method}>
          <input
            type="radio"
            name={`ai-connection-${id}`}
            value="api"
            checked
            readOnly
          />
          <span>
            <strong>{local ? "Local API" : "API key"}</strong>
            <small>
              {local
                ? "Connect to the server on this machine."
                : "Use a key from your provider account."}
            </small>
          </span>
        </label>
        <label className={`${aiStyles.method} ${aiStyles.unavailable}`}>
          <input
            type="radio"
            name={`ai-connection-${id}`}
            value="web"
            disabled
            aria-describedby={`ai-web-auth-${id}`}
          />
          <span>
            <strong>
              Web sign-in <span className={aiStyles.badge}>Coming soon</span>
            </strong>
            <small id={`ai-web-auth-${id}`}>
              {local
                ? "Local providers use an API connection."
                : "Browser authentication is not connected yet."}
            </small>
          </span>
        </label>
      </fieldset>
      <label className={aiStyles.field}>
        <span>Base URL</span>
        <input
          type="url"
          className={styles.textInput}
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${name} base URL`}
          data-testid={`ai-base-url-${id}`}
        />
      </label>
      {local ? (
        <p className={aiStyles.hint}>
          No API key is needed for this local provider.
        </p>
      ) : hasApiKey && !replacing ? (
        <div className={styles.actionRow}>
          <span
            className={styles.keyStatus}
            data-testid={`ai-key-status-${id}`}
          >
            Key saved
          </span>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => setReplacing(true)}
            data-testid={`ai-replace-key-${id}`}
          >
            Replace key
          </button>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() =>
              void onSave({
                provider: id,
                baseUrl: null,
                apiKey: null,
                clearApiKey: true,
              })
            }
            data-testid={`ai-remove-key-${id}`}
          >
            Remove key
          </button>
        </div>
      ) : (
        <label className={aiStyles.field}>
          <span>API key</span>
          <input
            type="password"
            className={styles.textInput}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
            autoComplete="off"
            placeholder="API key"
            aria-label={`${name} API key`}
            data-testid={`ai-key-input-${id}`}
          />
        </label>
      )}
      {replacing && (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => {
            setKey("");
            setReplacing(false);
          }}
        >
          Cancel replacement
        </button>
      )}
      <div className={styles.actionRow}>
        <button
          type="submit"
          className={`${styles.button} ${styles.buttonPrimary}`}
          disabled={busy || (!local && !hasApiKey && key.trim() === "")}
          data-testid={`ai-provider-save-${id}`}
        >
          {busy ? "Saving…" : "Continue to model"}
        </button>
      </div>
    </form>
  );
}

interface ModelProps {
  id: AiProviderId;
  defaultModel: string;
  busy: boolean;
  onSave: (model: string) => Promise<boolean>;
  onBack: () => void;
}

export function AiModelSettings({
  id,
  defaultModel,
  busy,
  onSave,
  onBack,
}: ModelProps) {
  const prefix = `${id}@`;
  const current = defaultModel.startsWith(prefix)
    ? defaultModel.slice(prefix.length)
    : "";
  const [model, setModel] = useState(current);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => setModel(current), [current]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void aiListModels(id)
      .then((items) => {
        if (!cancelled)
          setModels(
            items
              .filter((item) => item.startsWith(prefix))
              .map((item) => item.slice(prefix.length)),
          );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(formatAppError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, prefix, attempt]);

  return (
    <form
      className={aiStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && model.trim() !== "") void onSave(model);
      }}
    >
      <p className={aiStyles.hint}>
        Choose the default LLM model for chats using {PROVIDER_NAMES[id]}. You
        can also enter a model ID manually.
      </p>
      {loading && (
        <p className={aiStyles.hint} role="status">
          Loading models…
        </p>
      )}
      {error !== null && (
        <p className={aiStyles.modelError} role="alert">
          Could not load models: {error}. Enter a model ID below or retry.
        </p>
      )}
      {models.length > 0 && (
        <label className={aiStyles.field}>
          <span>Available models</span>
          <select
            className={styles.textInput}
            value={models.includes(model) ? model : ""}
            disabled={busy}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="" disabled>
              Choose a model…
            </option>
            {models.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={aiStyles.field}>
        <span>LLM model</span>
        <input
          className={styles.textInput}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          disabled={busy}
          spellCheck={false}
          placeholder="Select or enter a model ID"
          data-testid="ai-default-model-input"
        />
      </label>
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || loading}
          onClick={() => setAttempt((value) => value + 1)}
          data-testid="ai-choose-model"
        >
          Refresh models
        </button>
      </div>
      <div className={styles.actionRow}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={onBack}
        >
          Back to connection
        </button>
        <button
          type="submit"
          className={`${styles.button} ${styles.buttonPrimary}`}
          disabled={busy || model.trim() === ""}
          data-testid="ai-save-model"
        >
          {busy ? "Saving…" : "Use as default model"}
        </button>
      </div>
    </form>
  );
}
