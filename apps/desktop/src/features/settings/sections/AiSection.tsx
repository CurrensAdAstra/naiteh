import { Minus, Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import {
  appConfigSetAi,
  appConfigSetAiProvider,
  type AiProviderUpdate,
} from "../../../lib/api/settings";
import { addedProviders, isModelId } from "../../../lib/chatMd/models";
import {
  AI_PROVIDERS,
  formatAppError,
  type AiProviderId,
  type AppConfig,
} from "../../../lib/types";
import { useSettingsStore } from "../../../state/settingsStore";
import styles from "../SettingsModal.module.css";
import { AiAdvancedSettings } from "./AiAdvancedSettings";
import { AiConnectionSettings, AiModelSettings } from "./AiProviderSetup";
import { isLocalProvider, PROVIDER_NAMES, settingsOf } from "./aiSettings";
import aiStyles from "./AiSection.module.css";

/** Provider management → connection → model, with advanced settings folded away. */
export function AiSection() {
  const ai = useSettingsStore((s) => s.config?.ai);
  const setConfig = useSettingsStore((s) => s.setConfig);
  const providers = addedProviders(ai);
  const [selected, setSelected] = useState<AiProviderId | null>(null);
  const [step, setStep] = useState<"connection" | "model">("connection");
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<AiProviderId | "">("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const available = AI_PROVIDERS.filter((id) => !providers.includes(id));
  const active =
    selected !== null && providers.includes(selected) ? selected : null;
  const connected =
    active !== null &&
    (isLocalProvider(active) || ai?.providers[active]?.hasApiKey === true);
  const currentStep = active === null ? 1 : step === "connection" ? 2 : 3;

  async function save(
    operation: () => Promise<AppConfig>,
    message: string,
  ): Promise<boolean> {
    if (submitting.current) return false;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setConfig(await operation());
      setNotice(message);
      return true;
    } catch (e) {
      setError(formatAppError(e));
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function openProvider(id: AiProviderId) {
    setSelected(id);
    setStep("connection");
    setAdding(false);
    setError(null);
    setNotice(null);
  }

  async function addProvider(event: FormEvent) {
    event.preventDefault();
    if (newProvider === "" || !available.includes(newProvider)) return;
    const id = newProvider;
    if (
      await save(
        () =>
          appConfigSetAi({
            ...settingsOf(ai),
            addedProviders: [...providers, id],
          }),
        `${PROVIDER_NAMES[id]} added. Choose how to connect.`,
      )
    ) {
      setSelected(id);
      setStep("connection");
      setAdding(false);
      setNewProvider("");
    }
  }

  async function removeProvider(id: AiProviderId) {
    if (
      await save(
        () =>
          appConfigSetAi({
            ...settingsOf(ai),
            addedProviders: providers.filter((p) => p !== id),
          }),
        `${PROVIDER_NAMES[id]} removed.`,
      )
    ) {
      if (selected === id) setSelected(null);
    }
  }

  async function saveModel(value: string): Promise<boolean> {
    if (active === null) return false;
    const trimmed = value.trim();
    const model = trimmed.includes("@") ? trimmed : `${active}@${trimmed}`;
    if (!isModelId(model) || !model.startsWith(`${active}@`)) {
      setError(`Enter a model ID for ${PROVIDER_NAMES[active]}.`);
      return false;
    }
    return save(
      () => appConfigSetAi({ ...settingsOf(ai), defaultModel: model }),
      `${model} is now the default chat model.`,
    );
  }

  return (
    <div data-testid="settings-ai">
      <h2 className={styles.sectionHeading}>AI</h2>
      <p className={styles.sectionIntro}>
        Add a provider, choose how to connect, then select an LLM model.
      </p>
      <ol className={aiStyles.steps} aria-label="AI setup progress">
        {(["Providers", "Connection", "Model"] as const).map((label, index) => (
          <li
            key={label}
            aria-current={currentStep === index + 1 ? "step" : undefined}
          >
            <button
              type="button"
              className={aiStyles.step}
              disabled={
                busy ||
                (index > 0 && active === null) ||
                (index === 2 && !connected)
              }
              onClick={() => {
                if (index === 0) setSelected(null);
                else setStep(index === 1 ? "connection" : "model");
                setError(null);
                setNotice(null);
              }}
            >
              <span className={aiStyles.stepNumber}>{index + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>
      {error !== null && (
        <p
          className={styles.error}
          role="alert"
          data-testid="ai-settings-error"
        >
          {error}
        </p>
      )}
      {notice !== null && error === null && (
        <p
          className={styles.notice}
          role="status"
          data-testid="ai-settings-notice"
        >
          {notice}
        </p>
      )}

      <section
        className={aiStyles.providerSection}
        aria-labelledby="ai-providers-heading"
      >
        <div className={aiStyles.sectionHeader}>
          <h3 id="ai-providers-heading" className={aiStyles.heading}>
            Your providers
          </h3>
          <button
            type="button"
            className={`${styles.button} ${aiStyles.iconTextButton}`}
            disabled={busy || available.length === 0}
            onClick={() => {
              setAdding(true);
              setSelected(null);
              setNewProvider(available[0] ?? "");
              setError(null);
              setNotice(null);
            }}
            data-testid="ai-add-provider"
          >
            <Plus size={14} aria-hidden="true" />
            Add provider
          </button>
        </div>
        {providers.length === 0 && !adding && (
          <p className={aiStyles.hint}>
            No providers added yet. Start with + Add provider.
          </p>
        )}
        {providers.length > 0 && (
          <ul className={aiStyles.providerList} aria-label="Added AI providers">
            {providers.map((id) => (
              <li
                key={id}
                className={`${aiStyles.providerRow} ${active === id ? aiStyles.providerActive : ""}`}
                data-testid={`ai-provider-${id}`}
              >
                <button
                  type="button"
                  className={aiStyles.providerSelect}
                  disabled={busy}
                  onClick={() => openProvider(id)}
                  aria-pressed={active === id}
                >
                  <strong>{PROVIDER_NAMES[id]}</strong>
                  <span className={aiStyles.providerStatus}>
                    {isLocalProvider(id)
                      ? "Local API"
                      : ai?.providers[id]?.hasApiKey
                        ? "API key saved"
                        : "Connection needed"}
                    {ai?.defaultModel.startsWith(`${id}@`) &&
                    (isLocalProvider(id) || ai.providers[id]?.hasApiKey)
                      ? " · Default model"
                      : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className={aiStyles.removeButton}
                  aria-label={`Remove ${PROVIDER_NAMES[id]}`}
                  title={`Remove ${PROVIDER_NAMES[id]}`}
                  disabled={busy}
                  onClick={() => void removeProvider(id)}
                  data-testid={`ai-remove-provider-${id}`}
                >
                  <Minus size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {adding && (
          <form
            className={aiStyles.addForm}
            onSubmit={(event) => void addProvider(event)}
          >
            <label className={aiStyles.field}>
              <span>Provider</span>
              <select
                className={styles.textInput}
                value={newProvider}
                disabled={busy}
                onChange={(event) =>
                  setNewProvider(event.target.value as AiProviderId)
                }
                data-testid="ai-provider-choice"
                autoFocus
              >
                {available.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_NAMES[id]}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.actionRow}>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`${styles.button} ${styles.buttonPrimary}`}
                disabled={busy || newProvider === ""}
                data-testid="ai-add-provider-confirm"
              >
                {busy ? "Adding…" : "Add provider"}
              </button>
            </div>
          </form>
        )}
      </section>

      {active !== null && (
        <section
          className={aiStyles.setup}
          aria-label={`${PROVIDER_NAMES[active]} setup`}
        >
          <h3 className={aiStyles.heading}>
            {PROVIDER_NAMES[active]} ·{" "}
            {step === "connection" ? "Connection" : "Model"}
          </h3>
          {step === "connection" ? (
            <AiConnectionSettings
              key={active}
              id={active}
              provider={ai?.providers[active]}
              busy={busy}
              onSave={(update: AiProviderUpdate) =>
                save(
                  () => appConfigSetAiProvider(update),
                  `${PROVIDER_NAMES[active]} connection saved.`,
                )
              }
              onNext={() => {
                setStep("model");
                setError(null);
              }}
            />
          ) : connected ? (
            <AiModelSettings
              key={active}
              id={active}
              defaultModel={ai?.defaultModel ?? ""}
              busy={busy}
              onSave={saveModel}
              onBack={() => setStep("connection")}
            />
          ) : (
            <p className={aiStyles.hint}>
              Save the provider connection before selecting a model.
            </p>
          )}
        </section>
      )}
      <AiAdvancedSettings
        busy={busy}
        onSave={(settings) =>
          save(() => appConfigSetAi(settings), "Chat settings saved.")
        }
      />
    </div>
  );
}
