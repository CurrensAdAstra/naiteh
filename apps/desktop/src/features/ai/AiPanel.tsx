import { X } from "lucide-react";
import { useState } from "react";

import { aiImprove } from "../../lib/api/ai";
import { aiReady } from "../../lib/aiProvider";
import { formatAppError } from "../../lib/types";
import {
  readCurrentSelection,
  replaceRange,
  useEditorStore,
  type CurrentSelection,
} from "../../state/editorStore";
import { selectEditorConfig, useSettingsStore } from "../../state/settingsStore";
import { useUIStore } from "../../state/uiStore";
import styles from "./AiPanel.module.css";

type Scope = "selection" | "document";

const PRESETS: ReadonlyArray<{ label: string; instruction: string }> = [
  { label: "Improve writing", instruction: "Improve clarity and flow." },
  { label: "Make shorter", instruction: "Make this noticeably shorter while preserving meaning." },
  { label: "Fix grammar", instruction: "Fix grammar and spelling without changing meaning." },
  {
    label: "Translate to English",
    instruction: "Translate to natural-sounding English.",
  },
];

interface PendingResult {
  text: string;
  /** Range in the document that the result should replace if applied. */
  from: number;
  to: number;
}

export function AiPanel() {
  const setOpen = useUIStore((s) => s.setAiPanelOpen);
  const config = useSettingsStore((s) => s.config);
  // Reading selectEditorConfig keeps a single subscription path consistent
  // with EditorPanel even though we don't currently use the editor prefs.
  useSettingsStore(selectEditorConfig);
  const open = useEditorStore((s) => s.open);

  const [scope, setScope] = useState<Scope>("selection");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PendingResult | null>(null);

  // AI is unusable until a provider is configured: a hosted API needs a
  // key + model; a local provider (Ollama) just needs a model.
  const aiNotReady = config !== null && !aiReady(config.ai);

  function pickRange(): CurrentSelection | null {
    if (scope === "document" && open !== null) {
      return { text: open.content, from: 0, to: open.content.length };
    }
    return readCurrentSelection();
  }

  async function handleRun() {
    setError(null);
    setResult(null);
    if (instruction.trim() === "") {
      setError("Enter an instruction first.");
      return;
    }
    const range = pickRange();
    if (range === null || range.text.trim() === "") {
      setError(
        scope === "selection"
          ? "No editor selection available. Open a note and select some text."
          : "No document open. Open a note to use document-wide AI Assist.",
      );
      return;
    }

    setBusy(true);
    try {
      const reply = await aiImprove(range.text, instruction);
      setResult({ text: reply, from: range.from, to: range.to });
    } catch (e) {
      setError(formatAppError(e));
    } finally {
      setBusy(false);
    }
  }

  function handleApply() {
    if (result === null) return;
    const ok = replaceRange(result.from, result.to, result.text);
    if (!ok) {
      setError("Editor is not available. Open a note first.");
      return;
    }
    setResult(null);
  }

  function handleCopyResult() {
    if (result === null) return;
    void navigator.clipboard?.writeText(result.text);
  }

  return (
    <div className={styles.panel} data-testid="ai-panel">
      <header className={styles.header}>
        <h2 className={styles.title}>AI Assist</h2>
        <button
          type="button"
          className={styles.closeButton}
          aria-label="Close AI Assist"
          onClick={() => setOpen(false)}
          data-testid="ai-panel-close"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <div className={styles.body}>
        <p className={styles.notice}>
          AI Assist sends the selected text to your configured provider
          (default OpenAI) over the network. naiteh stays local-first
          everywhere else — this panel is the one exception.
        </p>

        {aiNotReady && (
          <p className={styles.error} data-testid="ai-panel-key-missing">
            AI Assist isn&rsquo;t configured. Open Settings → AI Assist to
            set a model (and an API key for hosted providers, or pick local
            Ollama).
          </p>
        )}

        <div className={styles.field}>
          <span className={styles.label}>Apply to</span>
          <div className={styles.scopeRow}>
            <button
              type="button"
              className={`${styles.scopePill} ${
                scope === "selection" ? styles.scopePillActive : ""
              }`}
              onClick={() => setScope("selection")}
              data-testid="ai-scope-selection"
            >
              Selection
            </button>
            <button
              type="button"
              className={`${styles.scopePill} ${
                scope === "document" ? styles.scopePillActive : ""
              }`}
              onClick={() => setScope("document")}
              data-testid="ai-scope-document"
            >
              Whole document
            </button>
          </div>
          <p className={styles.helpText}>
            Selection: text highlighted in the editor (falls back to the
            whole document when nothing is highlighted).
          </p>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>Quick prompts</span>
          <div className={styles.presetGroup}>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={styles.preset}
                onClick={() => setInstruction(p.instruction)}
                data-testid={`ai-preset-${p.label
                  .toLowerCase()
                  .replace(/\s+/g, "-")}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="ai-instruction">
            Instruction
          </label>
          <textarea
            id="ai-instruction"
            className={styles.textarea}
            placeholder="e.g. Make this section more formal."
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            data-testid="ai-instruction"
          />
        </div>

        <button
          type="button"
          className={styles.runButton}
          onClick={() => void handleRun()}
          disabled={busy || aiNotReady}
          data-testid="ai-run"
        >
          {busy ? "Working…" : "Improve with AI"}
        </button>

        {error !== null && (
          <p className={styles.error} role="alert" data-testid="ai-error">
            {error}
          </p>
        )}

        {result !== null && (
          <div className={styles.result} data-testid="ai-result">
            <div className={styles.resultText}>{result.text}</div>
            <div className={styles.resultActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={handleCopyResult}
                data-testid="ai-result-copy"
              >
                Copy
              </button>
              <button
                type="button"
                className={styles.applyButton}
                onClick={handleApply}
                data-testid="ai-result-apply"
              >
                Replace in editor
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
