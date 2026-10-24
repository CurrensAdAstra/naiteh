import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { aiListModels } from "../../lib/api/ai";
import { configuredProviders, isModelId } from "../../lib/chatMd/models";
import { formatAppError } from "../../lib/types";
import { useSettingsStore } from "../../state/settingsStore";
import styles from "./ModelPicker.module.css";

export interface ModelPickerProps {
  /** Dialog title, e.g. "Select chat model". */
  title: string;
  /** Pre-filled `provider@model` (current choice). */
  initial?: string;
  onPick: (model: string) => void;
  onClose: () => void;
}

/**
 * Model chooser (chatgpt-md's "Select model"): lists `ai_list_models` for
 * each configured provider, plus free text in `provider@model` form.
 */
export function ModelPicker({ title, initial = "", onPick, onClose }: ModelPickerProps) {
  const ai = useSettingsStore((s) => s.config?.ai);
  const providers = useMemo(() => configuredProviders(ai), [ai]);
  const [query, setQuery] = useState(initial);
  const [models, setModels] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled(providers.map((p) => aiListModels(p))).then(
      (results) => {
        if (cancelled) return;
        const found: string[] = [];
        const failed: string[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") found.push(...r.value);
          else failed.push(`${providers[i] ?? "?"}: ${formatAppError(r.reason)}`);
        });
        setModels(found);
        setErrors(failed);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [providers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "" || q === initial.trim().toLowerCase()) return models;
    return models.filter((m) => m.toLowerCase().includes(q));
  }, [initial, models, query]);

  const typed = query.trim();
  const typedValid = isModelId(typed);

  function pick(model: string) {
    onPick(model);
    onClose();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (typedValid) pick(typed);
      else if (filtered.length === 1 && filtered[0] !== undefined) pick(filtered[0]);
    }
  }

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="model-picker"
    >
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className={styles.title}>{title}</h2>
        <div className={styles.inputRow}>
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="provider@model, e.g. openai@gpt-4.1-mini"
            aria-label="Model"
            data-testid="model-picker-input"
          />
          <button
            type="button"
            className={styles.use}
            disabled={!typedValid}
            onClick={() => pick(typed)}
            data-testid="model-picker-use"
          >
            Use
          </button>
        </div>
        {loading && (
          <p className={styles.hint} role="status">
            Loading models…
          </p>
        )}
        {!loading && providers.length === 0 && (
          <p className={styles.hint}>
            Add a provider and configure its connection in Settings → AI,
            or type a model.
          </p>
        )}
        {errors.map((e) => (
          <p key={e} className={styles.error}>
            {e}
          </p>
        ))}
        <ul className={styles.list} aria-label="Models">
          {filtered.map((m) => (
            <li key={m}>
              <button
                type="button"
                className={styles.option}
                onClick={() => pick(m)}
                data-testid={`model-option-${m}`}
              >
                {m}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
